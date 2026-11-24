#!/usr/bin/env python3
"""Benchmark read-only do motor OpenCV com o mesmo vídeo e configuração."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "src-tauri" / "python" / "opencv_engine.py"
WRAPPER = """
import json, platform, resource, runpy, sys, time
engine, request, metrics = sys.argv[1:]
start = time.perf_counter()
sys.argv = [engine, request]
try:
    runpy.run_path(engine, run_name='__main__')
finally:
    own = resource.getrusage(resource.RUSAGE_SELF)
    child = resource.getrusage(resource.RUSAGE_CHILDREN)
    divisor = 1024*1024 if platform.system() == 'Darwin' else 1024
    with open(metrics, 'w') as output:
        json.dump({'wallSec': time.perf_counter()-start,
                   'cpuSec': own.ru_utime+own.ru_stime+child.ru_utime+child.ru_stime,
                   'enginePeakRssMiB': own.ru_maxrss/divisor,
                   'largestChildPeakRssMiB': child.ru_maxrss/divisor}, output)
"""


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_version(label, source, request, python, root):
    directory = root / label
    directory.mkdir()
    engine = directory / "engine.py"
    engine.write_bytes(source)
    (directory / "request.json").write_text(json.dumps(request), encoding="utf-8")
    wrapper = directory / "wrapper.py"
    wrapper.write_text(WRAPPER, encoding="utf-8")
    metrics = directory / "metrics.json"
    with (directory / "engine.log").open("w") as log:
        process = subprocess.run([python, str(wrapper), str(engine), str(directory / "request.json"), str(metrics)],
                                 stdout=log, stderr=log, check=False)
    status_path = directory / "status.json"
    status = json.loads(status_path.read_text()) if status_path.exists() else {}
    if process.returncode or status.get("state") != "succeeded":
        tail = (directory / "engine.log").read_text(errors="replace")[-1500:]
        raise RuntimeError(f"{label} falhou: {status.get('error', tail)}")
    samples = [json.loads(line) for line in (directory / "samples.jsonl").read_text().splitlines()]
    return {"engineSha256": sha256_bytes(source), "engineVersion": status.get("version"),
            "status": status, "resources": json.loads(metrics.read_text()), "samples": samples}


def observed_distance(samples):
    total = 0.
    previous = None
    for item in samples:
        if item.get("source") == "segmented" and item.get("status") == "valid" and item.get("xPx") is not None:
            if previous is not None and item["frameIndex"] == previous["frameIndex"] + 1:
                total += math.hypot(item["xPx"]-previous["xPx"], item["yPx"]-previous["yPx"])
            previous = item
        else:
            previous = None
    return total


def compare(baseline, current):
    before, after = baseline["samples"], current["samples"]
    if len(before) != len(after) or any(a["frameIndex"] != b["frameIndex"] or
                                     abs(a["timestampSec"]-b["timestampSec"]) > .000001
                                     for a, b in zip(before, after)):
        raise ValueError("Versões produziram relógios ou contagens diferentes")
    differences = [math.hypot(a["xPx"]-b["xPx"], a["yPx"]-b["yPx"])
                   for a, b in zip(before, after) if a.get("xPx") is not None and b.get("xPx") is not None]
    changed = sum(a.get("status") != b.get("status") for a, b in zip(before, after))
    return {"frames": len(before), "pairedCoordinates": len(differences),
            "meanCoordinateDifferencePx": sum(differences)/len(differences) if differences else None,
            "maxCoordinateDifferencePx": max(differences) if differences else None,
            "statusChanges": changed,
            "baselineValidObservedDistancePx": observed_distance(before),
            "currentValidObservedDistancePx": observed_distance(after)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True, help="request.json de uma execução local existente")
    parser.add_argument("--video", type=Path, help="Vídeo alternativo com mesma resolução e calibração")
    parser.add_argument("--python", default=sys.executable, help="Python com OpenCV instalado")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline-engine", type=Path, help="Snapshot Python anterior para comparação com configuração idêntica")
    parser.add_argument("--classical-widths", nargs="+", type=int, choices=[480, 640, 960],
                        help="Compara o baseline com fundo mediano/ROI nas larguras selecionadas")
    args = parser.parse_args()
    request = json.loads(args.request.read_text())
    # Benchmarks never replace audit videos belonging to application jobs.
    request.pop("auditVideo", None)
    if request["config"].get("protocol") not in (None, "open_field"):
        raise ValueError("Este benchmark compara apenas Campo Aberto")
    if request["config"].get("strategy", "classic") != "classic" and not (
            args.baseline_engine and request["config"].get("strategy") == "classical_roi_v1" and not args.classical_widths):
        raise ValueError("Use uma execução OpenCV clássica")
    request["config"]["useOpenCL"] = False
    if args.video:
        request["video"] = str(args.video.resolve())
    video = Path(request["video"])
    if not video.is_file():
        raise ValueError("Vídeo indisponível")
    baseline_source = (args.baseline_engine.read_bytes() if args.baseline_engine else
                       subprocess.check_output(["git", "show", "HEAD:src-tauri/python/opencv_engine.py"], cwd=ROOT))
    current_source = ENGINE.read_bytes()
    with tempfile.TemporaryDirectory(prefix="behavetracker-benchmark-") as temporary:
        root = Path(temporary)
        baseline = run_version("baseline", baseline_source, request, args.python, root)
        if args.classical_widths:
            variants = {}
            for width in dict.fromkeys(args.classical_widths):
                variant_request = {**request, "config": {**request["config"], "protocol": "open_field",
                    "strategy": "classical_roi_v1", "mode": "auto", "threshold": 25,
                    "maxWidth": width, "referenceApproved": False, "useOpenCL": False}}
                variant_request["config"].pop("guidance", None)
                variant_request["config"].pop("initialBox", None)
                variant_request["config"].pop("seed", None)
                value = run_version(f"classical-{width}", current_source, variant_request, args.python, root)
                variants[str(width)] = {"resources": value["resources"], "status": value["status"],
                    "config": variant_request["config"], "engineSha256": value["engineSha256"],
                    "comparison": compare(baseline, value)}
            result = {"status": "TECHNICAL_BENCHMARK_NOT_ACCURACY_VALIDATION",
                "comparisonMethod": "Git HEAD classic CPU versus workspace median background/ROI CPU; includes reference construction, decoding and feature extraction; excludes audit rendering.",
                "videoSha256": sha256_file(video), "baselineConfig": request["config"],
                "baseline": {"resources": baseline["resources"], "status": baseline["status"],
                             "engineSha256": baseline["engineSha256"]}, "classicalWidths": variants,
                "limits": "Single run per width on one machine; valid coverage is a heuristic, not spatial accuracy. Human annotation, neural classification and Colab were not evaluated."}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)+"\n", encoding="utf-8")
            print(json.dumps({"output": str(args.output), "widths": list(variants)}))
            return
        current = run_version("current", current_source, request, args.python, root)
        result = {"status": "TECHNICAL_BENCHMARK_NOT_ACCURACY_VALIDATION",
                  "comparisonMethod": ("Snapshot Python anterior" if args.baseline_engine else "Motor salvo em Git HEAD")+" versus motor atual do workspace; configuração idêntica, inclui todas as diferenças entre essas versões; exclui renderização de auditoria.",
                  "resourceScope": "CPU inclui Python e subprocessos; RSS do Python e maior subprocesso são picos separados, não soma simultânea.",
                  "videoSha256": sha256_file(video),
                  "configSha256": sha256_bytes(json.dumps(request["config"], sort_keys=True).encode()),
                  "videoBytes": video.stat().st_size,
                  "comparison": compare(baseline, current),
                  "versions": {label: {"engineVersion": value["engineVersion"],
                                       "engineSha256": value["engineSha256"],
                                       "resources": value["resources"],
                                       "report": {key: value["status"].get(key) for key in
                                                  ("framesProcessed", "processingFps", "observationCoveragePct",
                                                   "cameraUncertainFrames", "cameraMotionState", "counts", "backgroundReference",
                                                   "validObservationCoveragePct", "trackingObservedCoveragePct", "trackingObservedFrames",
                                                   "geometryRejectedFrames", "kalmanUpdateCount", "reasonCounts", "qualityReasonCounts")}}
                               for label, value in (("baseline", baseline), ("current", current))},
                  "limits": "Sem anotações humanas, diferenças não medem erro espacial ou falsos alertas; distância usa apenas pares consecutivos observados válidos."}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "frames": result["comparison"]["frames"],
                      "baselineWallSec": baseline["resources"]["wallSec"],
                      "currentWallSec": current["resources"]["wallSec"]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Benchmark interrompido: {error}")
