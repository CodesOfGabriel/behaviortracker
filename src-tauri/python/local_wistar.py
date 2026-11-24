"""Run the shared Wistar pipeline and publish its audit video for desktop jobs."""

import csv
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time
import traceback

from engine import write_json
from hybrid_render import render
from model_delivery import DownloadCancelled, install_bundle


class LocalRun:
    def __init__(self, request_file):
        self.root = Path(request_file).resolve().parent
        self.request = json.loads(Path(request_file).read_text(encoding="utf-8"))
        self.report = {"state": "running", "phase": "model_setup"}
        self.last_update = 0

    def cancelled(self):
        return (self.root / "cancel").exists()

    def progress(self, phase, processed=None, total=None, fps=None, backend=None):
        if self.cancelled():
            raise DownloadCancelled("Análise cancelada")
        now = time.monotonic()
        if phase == self.report["phase"] and now - self.last_update < 1:
            return
        self.report.update(phase=phase, framesProcessed=processed, totalFrames=total, processingFps=fps)
        if backend:
            self.report["computeBackend"] = backend
        self.save()
        self.last_update = now

    def save(self):
        write_json(self.root / "status.json", self.report)

    def prepare_models(self):
        if self.request["models"]:
            return Path(self.request["models"])
        if self.request["config"]["modelBundleId"] != "wistar_df_v2":
            raise RuntimeError("Instale o bundle Wistar v1 verificado para analisar com os pesos deste projeto.")
        registry = json.loads((self.root / "bundle.json").read_text(encoding="utf-8"))
        return install_bundle(registry, self.request["appData"], "deeplabcut-pytorch-3",
                              bundled_config_dir=self.root, cancelled=self.cancelled,
                              progress=lambda _received, _total: self.progress("model_setup"))

    def render_video(self, track_progress=True):
        progress = (lambda i, n: self.progress("rendering", i, n)) if track_progress else None
        artifact = render(self.request["video"], self.root, self.request["config"]["arena"],
                          ffmpeg_path=self.request["ffmpeg"], progress=progress)
        if track_progress:
            self.progress("rendering")
        if not artifact["available"]:
            raise RuntimeError(artifact["error"] or "O vídeo anotado não foi gerado.")
        destination = Path(self.request["auditVideo"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        (self.root / artifact["filename"]).replace(destination)
        artifact["filename"] = destination.name
        write_json(self.root / "video_artifact.json", artifact)

    def analyze(self):
        self.progress("model_setup")
        models = self.prepare_models()
        os.environ["DLClight"] = "True"
        csv_path = self.root / "canonical_pose.csv"
        runpy.run_path(str(self.root / "hybrid_pipeline.py"), run_name="__main__", init_globals={
            "__VIDEO__": self.request["video"], "__OUTPUT__": str(self.root), "__CSV__": str(csv_path),
            "__MODELS__": str(models), "__MODEL_BUNDLE_ID__": self.request["config"]["modelBundleId"],
            "__DETECTOR_SHA256__": self.request["modelHashes"]["best_detector.pth"],
            "__POSE_SHA256__": self.request["modelHashes"]["snapshot-hrnet_w32-001.pt"],
            "__CONFIG_SHA256__": self.request["modelHashes"]["pytorch_config.yaml"],
            "__ARENA__": self.request["config"]["arena"], "LOCAL_PROGRESS": self.progress,
        })
        manifest = json.loads((self.root / "run_manifest.json").read_text(encoding="utf-8"))
        count = manifest["frameCount"]
        if manifest["sourceSha256"] != self.request["preparedSha256"]:
            raise RuntimeError("O vídeo preparado foi alterado durante a análise.")
        with csv_path.open(newline="", encoding="utf-8") as output:
            valid = sum(row["keypoint"] == "mouse_center" and row["status"] == "valid"
                        for row in csv.DictReader(output))
        self.progress("rendering")
        try:
            self.render_video()
        except DownloadCancelled:
            raise
        except Exception as error:
            self.report["videoError"] = str(error)
        self.report.update(state="succeeded", phase="complete", framesProcessed=count, totalFrames=count,
                           observationCoveragePct=100 * valid / count, processingFps=None)


def run_command(args, job):
    with subprocess.Popen(args) as process:
        try:
            while True:
                job.progress("model_setup")
                try:
                    return process.wait(timeout=1) == 0
                except subprocess.TimeoutExpired:
                    continue
        except BaseException:
            process.kill()
            raise


def pytorch_build():
    legacy_cuda = False
    try:
        result = subprocess.run(["nvidia-smi", "--query-gpu=compute_cap,driver_version,memory.total",
                                 "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=8)
        for line in result.stdout.splitlines() if result.returncode == 0 else ():
            capability, driver, memory = (value.strip() for value in line.split(","))
            if float(capability) < 7.5 or int(memory) < 4096:
                continue
            driver = tuple(map(int, driver.split(".")))
            if driver >= (580, 88):
                return "cu130", "2.14.1", "0.29.1"
            legacy_cuda |= driver >= (570, 65)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        pass
    if legacy_cuda:
        return "cu128", "2.8.0", "0.23.0"
    return "cpu", "2.14.1", "0.29.1"


def prepare_runtime(job):
    if not (3, 10) <= sys.version_info[:2] <= (3, 13) or sys.maxsize <= 2**32:
        raise RuntimeError("A análise Wistar local requer Python 3.10 a 3.13 de 64 bits.")
    home = Path(job.request["runtime"])
    python = home / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    marker = home / "wistar-runtime-v1.ready"
    if python.is_file() and marker.is_file():
        return python
    if not run_command([sys.executable, "-m", "venv", str(home)], job):
        raise RuntimeError("Não foi possível criar o ambiente Python da análise local. Consulte engine.log.")
    pip = [str(python), "-m", "pip", "--disable-pip-version-check", "install"]
    build, torch, torchvision = pytorch_build()
    if not run_command([*pip, "--index-url", f"https://download.pytorch.org/whl/{build}",
                        f"torch=={torch}", f"torchvision=={torchvision}"], job):
        raise RuntimeError("Falha ao instalar PyTorch local. Verifique a conexão e consulte engine.log.")
    if not run_command([*pip, "--index-url", "https://pypi.org/simple", "deeplabcut==3.0.2",
                        "opencv-python-headless==4.13.0.92"], job):
        raise RuntimeError("Falha ao instalar DeepLabCut local. Verifique a conexão e consulte engine.log.")
    marker.touch()
    return python


def main():
    job = LocalRun(sys.argv[1])
    mode = sys.argv[2]
    if mode == "render":
        job.request["ffmpeg"] = sys.argv[3]
        job.render_video(track_progress=False)
        return
    try:
        if mode == "prepare":
            job.progress("model_setup")
            python = prepare_runtime(job)
            job.progress("model_setup")
            result = subprocess.run([str(python), "-X", "utf8", "-u", __file__, sys.argv[1], "analyze"])
            if result.returncode != 0:
                raise RuntimeError("O processo Wistar local foi interrompido. Consulte engine.log.")
            return
        job.analyze()
    except DownloadCancelled as error:
        job.report.update(state="cancelled", error=str(error))
    except Exception as error:
        traceback.print_exc()
        job.report.update(state="failed", error=str(error)[:1500])
    job.save()


if __name__ == "__main__":
    main()
