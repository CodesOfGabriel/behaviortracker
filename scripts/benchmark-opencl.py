#!/usr/bin/env python3
"""Benchmark sequencial de HEAD/atual e CPU/OpenCL em gravações reais."""

import argparse
import csv
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "src-tauri/python/opencv_engine.py"
SPEC = importlib.util.spec_from_file_location("benchmark_local_engine", ROOT / "scripts/benchmark-local-engine.py")
LOCAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCAL)


def probe_opencl(python):
    code = ("import cv2,json\ncv2.ocl.setUseOpenCL(True)\n"
            "d=cv2.ocl.Device.getDefault()\n"
            "print(json.dumps({'active':bool(cv2.ocl.useOpenCL()),'name':d.name(),"
            "'vendor':d.vendorName(),'type':d.type(),'gpuTypeMask':cv2.ocl.DEVICE_TYPE_GPU}))")
    try:
        return json.loads(subprocess.check_output([python, "-c", code], text=True))
    except (OSError, subprocess.CalledProcessError, ValueError):
        return None


def process_tree_snapshot(root_pid):
    try:
        output = subprocess.check_output(["ps", "-A", "-o", "pid=,ppid=,%cpu=,rss="], text=True,
                                         stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return None
    children = {}
    details = {}
    for line in output.splitlines():
        try:
            pid, parent, cpu, rss = line.split()
            pid, parent = int(pid), int(parent)
            details[pid] = (float(cpu.replace(",", ".")), int(rss))
            children.setdefault(parent, []).append(pid)
        except ValueError:
            continue
    pending = [root_pid]
    found = set()
    while pending:
        pid = pending.pop()
        if pid in found:
            continue
        found.add(pid)
        pending.extend(children.get(pid, []))
    return (sum(details.get(pid, (0, 0))[0] for pid in found),
            sum(details.get(pid, (0, 0))[1] for pid in found) / 1024)


def technical_counts(path):
    counts = {"validObservedFrames": 0, "uncertainFrames": 0, "missingFrames": 0,
              "predictedFrames": 0}
    with path.open() as source:
        for line in source:
            sample = json.loads(line)
            counts["validObservedFrames"] += sample.get("source") == "segmented" and sample.get("status") == "valid"
            counts["uncertainFrames"] += sample.get("status") == "low_confidence"
            counts["missingFrames"] += sample.get("status") == "missing"
            counts["predictedFrames"] += sample.get("source") == "predicted"
    return counts


def run_once(label, engine_bytes, request, python, directory):
    directory.mkdir()
    engine = directory / "engine.py"
    engine.write_bytes(engine_bytes)
    request_path = directory / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    wrapper = directory / "wrapper.py"
    wrapper.write_text(LOCAL.WRAPPER, encoding="utf-8")
    metrics = directory / "metrics.json"
    with (directory / "engine.log").open("w") as log:
        process = subprocess.Popen([python, str(wrapper), str(engine), str(request_path), str(metrics)],
                                   stdout=log, stderr=log)
        cpu_samples, rss_samples = [], []
        while process.poll() is None:
            snapshot = process_tree_snapshot(process.pid)
            if snapshot:
                cpu_samples.append(snapshot[0])
                rss_samples.append(snapshot[1])
            time.sleep(.2)
        returncode = process.wait()
    status = json.loads((directory / "status.json").read_text()) if (directory / "status.json").exists() else {}
    if returncode or status.get("state") != "succeeded":
        log_tail = (directory / "engine.log").read_text(errors="replace")[-1200:]
        raise RuntimeError(f"{label}: {status.get('error', log_tail)}")
    resources = json.loads(metrics.read_text())
    frames = status["framesProcessed"]
    sample_counts = technical_counts(directory / "samples.jsonl")
    return {
        "wallSec": resources["wallSec"], "cpuSec": resources["cpuSec"],
        "cpuMeanPctOfOneCore": 100 * resources["cpuSec"] / resources["wallSec"],
        "cpuMaxSampledPctOfOneCore": max(cpu_samples, default=None),
        "peakSimultaneousRssSampledMiB": max(rss_samples, default=None),
        "pythonPeakRssMiB": resources["enginePeakRssMiB"],
        "largestChildPeakRssMiB": resources["largestChildPeakRssMiB"],
        "frames": frames, "throughputFps": frames / resources["wallSec"],
        "computeBackend": status.get("computeBackend"),
        "counts": status.get("counts"),
        "cameraUncertainFrames": status.get("cameraUncertainFrames"),
        "observationCoveragePct": status.get("observationCoveragePct"),
        "validObservedCoveragePct": 100 * sample_counts["validObservedFrames"] / frames,
        **sample_counts,
        "benchmarkProfile": status.get("benchmarkProfile"),
        "samplesSha256": LOCAL.sha256_file(directory / "samples.jsonl"),
        "samplesPath": directory / "samples.jsonl",
    }


def sample_difference(left_path, right_path):
    paired = changed = coordinate_changes = presence_changes = valid_paired = valid_changes = 0
    max_distance = max_valid_distance = 0.
    with left_path.open() as left, right_path.open() as right:
        while True:
            a_line, b_line = left.readline(), right.readline()
            if not a_line and not b_line:
                break
            if not a_line or not b_line:
                raise ValueError("Contagens de frames diferentes")
            a, b = json.loads(a_line), json.loads(b_line)
            if a["frameIndex"] != b["frameIndex"] or abs(a["timestampSec"] - b["timestampSec"]) > 1e-6:
                raise ValueError("Relógios diferentes entre execuções")
            changed += a["status"] != b["status"]
            presence_changes += (a.get("xPx") is None) != (b.get("xPx") is None)
            if a.get("xPx") is not None and b.get("xPx") is not None:
                paired += 1
                difference = math.hypot(a["xPx"] - b["xPx"], a["yPx"] - b["yPx"])
                coordinate_changes += difference > 1e-6
                max_distance = max(max_distance, difference)
                if a.get("status") == "valid" and b.get("status") == "valid" and a.get("source") == "segmented" and b.get("source") == "segmented":
                    valid_paired += 1
                    valid_changes += difference > 1e-6
                    max_valid_distance = max(max_valid_distance, difference)
    return {"pairedCoordinates": paired, "statusChanges": changed,
            "coordinateChanges": coordinate_changes, "coordinatePresenceChanges": presence_changes,
            "maxCoordinateDifferencePx": max_distance, "pairedValidObservedCoordinates": valid_paired,
            "validObservedCoordinateChanges": valid_changes,
            "maxValidObservedCoordinateDifferencePx": max_valid_distance}


def summarize(runs):
    fields = ("wallSec", "throughputFps", "cpuMeanPctOfOneCore", "cpuMaxSampledPctOfOneCore",
              "peakSimultaneousRssSampledMiB", "validObservedCoveragePct", "uncertainFrames",
              "missingFrames")
    result = {}
    for key in fields:
        samples = [value.get(key) for value in runs if value.get(key) is not None]
        result[key] = statistics.median(samples) if samples else None
    return result


def benchmark(cases, python, repeats, warmups, versions):
    if repeats < 2 or warmups < 1:
        raise ValueError("Use ao menos duas repetições medidas e um aquecimento")
    current = ENGINE.read_bytes()
    head = subprocess.check_output(["git", "show", "HEAD:src-tauri/python/opencv_engine.py"], cwd=ROOT)
    sources = {"head": head, "current": current}
    reports = []
    with tempfile.TemporaryDirectory(prefix="behavetracker-opencl-benchmark-") as temporary:
        work = Path(temporary)
        for case_id, video, config_path in cases:
            video, config_path = Path(video), Path(config_path)
            config = json.loads(config_path.read_text())
            if not video.is_file():
                raise ValueError(f"Vídeo indisponível: {case_id}")
            if config.get("strategy", "classic") != "classic":
                raise ValueError("Benchmark exige estratégia OpenCV clássica")
            result = {"caseId": case_id, "videoFilename": video.name,
                      "videoSha256": LOCAL.sha256_file(video),
                      "configSha256": LOCAL.sha256_file(config_path),
                      "config": config,
                      "frameCountFromRuns": None, "runs": [], "pairedComparisons": []}
            paths = {}
            for version in versions:
                for use_opencl in (False, True):
                    for repetition in range(warmups + repeats):
                        phase = "warmup" if repetition < warmups else "measure"
                        run_id = f"{case_id}-{version}-{'opencl' if use_opencl else 'cpu'}-{repetition}"
                        request = {"video": str(video.resolve()), "ffprobe": "ffprobe", "ffmpeg": "ffmpeg",
                                   "config": {**config, "useOpenCL": use_opencl,
                                              "benchmarkProfile": False}}
                        value = run_once(run_id, sources[version], request, python, work / run_id)
                        if result["frameCountFromRuns"] is not None and result["frameCountFromRuns"] != value["frames"]:
                            raise ValueError("Execuções produziram contagens diferentes")
                        result["frameCountFromRuns"] = value["frames"]
                        paths[(version, use_opencl, repetition)] = value.pop("samplesPath")
                        result["runs"].append({"version": version, "requestedOpenCL": use_opencl,
                                               "phase": phase, "repetition": repetition, **value})
                        print(f"{case_id} {version} {'opencl' if use_opencl else 'cpu'} {phase} {repetition}: {value['wallSec']:.2f}s", flush=True)
            if "current" in versions:
                for use_opencl in (False, True):
                    run_id = f"{case_id}-current-{'opencl' if use_opencl else 'cpu'}-profile"
                    request = {"video": str(video.resolve()), "ffprobe": "ffprobe", "ffmpeg": "ffmpeg",
                               "config": {**config, "useOpenCL": use_opencl, "benchmarkProfile": True}}
                    value = run_once(run_id, current, request, python, work / run_id)
                    value.pop("samplesPath")
                    result["runs"].append({"version": "current", "requestedOpenCL": use_opencl,
                                           "phase": "profile", "repetition": None, **value})
                    print(f"{case_id} current {'opencl' if use_opencl else 'cpu'} profile: {value['wallSec']:.2f}s", flush=True)
            for use_opencl in (False, True):
                for repetition in range(warmups, warmups + repeats):
                    if len(versions) == 2:
                        result["pairedComparisons"].append({"comparison": "head_vs_current", "requestedOpenCL": use_opencl,
                            "repetition": repetition,
                            **sample_difference(paths[("head", use_opencl, repetition)],
                                                paths[("current", use_opencl, repetition)])})
            for repetition in range(warmups, warmups + repeats):
                result["pairedComparisons"].append({"version": "current" if "current" in versions else "head",
                    "repetition": repetition, "comparison": "opencl_vs_cpu",
                    **sample_difference(paths[("current" if "current" in versions else "head", False, repetition)],
                                        paths[("current" if "current" in versions else "head", True, repetition)])})
            result["summary"] = {f"{version}_{'opencl' if use_opencl else 'cpu'}": summarize([
                row for row in result["runs"] if row["version"] == version
                and row["requestedOpenCL"] == use_opencl and row["phase"] == "measure"])
                for version in versions for use_opencl in (False, True)}
            reports.append(result)
    return {"status": "TECHNICAL_BENCHMARK_NOT_ACCURACY_VALIDATION",
            "methodVersion": "opencl-sequential-repeated-2", "repeats": repeats,
            "warmups": warmups,
            "headCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "versions": {version: hashlib.sha256(sources[version]).hexdigest() for version in versions},
            "environment": {"platform": platform.platform(), "architecture": platform.machine(),
                            "pythonVersion": subprocess.check_output([python, "--version"], text=True).strip(),
                            "ffmpegVersion": subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0],
                            "ffprobeVersion": subprocess.check_output(["ffprobe", "-version"], text=True).splitlines()[0],
                            "openclDevice": probe_opencl(python)},
            "resourceScope": "CPU mean is total process CPU seconds divided by wall seconds; max sampled CPU is the highest ps %cpu snapshot (a time-averaged process metric, not an instantaneous peak). Simultaneous RSS is sampled from the ps process tree every 0.2 s. Timing comparisons use benchmarkProfile disabled in both versions. Separate current-engine profile runs supply P95 frame latency and stages; frame read wait overlaps FFmpeg decode. HEAD has no internal profiler.",
            "limits": "OpenCL requested is not proof of GPU use; inspect computeBackend and openclDevice. The HEAD engine does not report computeBackend. Two measured repeats per arm on one computer do not establish general speedup; background load and thermal state were not controlled. Coordinates and coverage are technical outputs, not anatomical accuracy. No human ground truth or Colab inference is used.",
            "cases": reports}


def write_sidecars(path, report):
    def display(value, decimals=1):
        return f"{value:.{decimals}f}" if value is not None else "indisponível"

    columns = ("methodVersion", "postprocessVersion", "headCommit", "caseId", "videoSha256", "configSha256", "configJson", "engineSha256", "version", "requestedOpenCL", "phase", "repetition",
               "computeBackend", "frames", "wallSec", "throughputFps", "cpuMeanPctOfOneCore",
               "cpuMaxSampledPctOfOneCore", "peakSimultaneousRssSampledMiB", "pythonPeakRssMiB",
               "largestChildPeakRssMiB", "cameraUncertainFrames", "observationCoveragePct",
               "validObservedCoveragePct", "validObservedFrames", "uncertainFrames", "missingFrames", "predictedFrames",
               "frameLatencyP95Ms", "trackingStageSec", "cameraGuardStageSec", "countsJson")
    with path.with_suffix(".csv").open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=columns)
        writer.writeheader()
        for case in report["cases"]:
            for run in case["runs"]:
                profile = run.get("benchmarkProfile") or {}
                writer.writerow({**{key: run.get(key) for key in columns if key in run},
                                 "methodVersion": report["methodVersion"],
                                 "postprocessVersion": report.get("postprocessVersion"), "caseId": case["caseId"],
                                 "headCommit": report.get("headCommit"),
                                 "videoSha256": case["videoSha256"],
                                 "configSha256": case["configSha256"],
                                 "configJson": json.dumps(case["config"], sort_keys=True),
                                 "engineSha256": report["versions"][run["version"]],
                                 "frameLatencyP95Ms": profile.get("frameLatencyP95Ms"),
                                 "trackingStageSec": profile.get("stageSeconds", {}).get("tracking"),
                                 "cameraGuardStageSec": profile.get("stageSeconds", {}).get("camera_guard"),
                                 "countsJson": json.dumps(run.get("counts"), sort_keys=True)})
    paired_columns = ("methodVersion", "postprocessVersion", "headCommit", "caseId", "videoSha256", "configSha256", "comparison",
                      "version", "requestedOpenCL", "repetition", "pairedCoordinates", "statusChanges",
                      "coordinateChanges", "coordinatePresenceChanges", "maxCoordinateDifferencePx",
                      "pairedValidObservedCoordinates", "validObservedCoordinateChanges",
                      "maxValidObservedCoordinateDifferencePx")
    with path.with_suffix(".paired.csv").open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=paired_columns)
        writer.writeheader()
        for case in report["cases"]:
            for item in case["pairedComparisons"]:
                writer.writerow({"methodVersion": report["methodVersion"],
                                 "postprocessVersion": report.get("postprocessVersion"), "caseId": case["caseId"],
                                 "headCommit": report.get("headCommit"),
                                 "videoSha256": case["videoSha256"], "configSha256": case["configSha256"],
                                 **item})
    lines = ["# Benchmark sequencial CPU e OpenCL", "", f"Status: `{report['status']}`.", "",
             f"Repetições medidas por braço: {report['repeats']}; aquecimentos: {report['warmups']}.",
             f"Dispositivo OpenCL: `{json.dumps(report['environment'].get('openclDevice'), sort_keys=True)}`.", "",
             "| Gravação | Versão | OpenCL solicitado | Backend efetivo | Tempo mediano (s) | FPS mediano | CPU média (%) | RSS simultâneo amostrado (MiB) | Válidos (%) | Incertos |",
             "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for case in report["cases"]:
        for key, value in case["summary"].items():
            version, backend = key.split("_")
            measured = [run for run in case["runs"] if run["version"] == version
                        and run["requestedOpenCL"] == (backend == "opencl") and run["phase"] == "measure"]
            effective = ", ".join(sorted({str(run["computeBackend"] or "não registrado") for run in measured}))
            lines.append(f"| {case['caseId']} | {version} | {backend} | {effective} | "
                         f"{display(value['wallSec'], 2)} | {display(value['throughputFps'])} | "
                         f"{display(value['cpuMeanPctOfOneCore'])} | {display(value['peakSimultaneousRssSampledMiB'])} | "
                         f"{display(value.get('validObservedCoveragePct'))} | {display(value.get('uncertainFrames'), 0)} |")
    lines.extend(["", "## Proveniência e configuração", "",
                  f"Commit HEAD: `{report.get('headCommit', 'não registrado')}`."])
    for version, digest in report["versions"].items():
        lines.append(f"Motor `{version}` SHA-256: `{digest}`.")
    lines.append("")
    for case in report["cases"]:
        lines.extend([f"### {case['caseId']}", "",
                      f"Vídeo `{case['videoFilename']}` SHA-256: `{case['videoSha256']}`.",
                      f"Configuração SHA-256: `{case['configSha256']}`.",
                      f"Parâmetros: `{json.dumps(case['config'], sort_keys=True)}`.",
                      f"Frames processados: {case['frameCountFromRuns']}.", ""])
        profiles = [run for run in case["runs"] if run["phase"] == "profile"]
        for run in profiles:
            profile = run["benchmarkProfile"] or {}
            lines.append(f"Perfil OpenCL solicitado={run['requestedOpenCL']}: P95 por frame "
                         f"{profile.get('frameLatencyP95Ms')} ms; etapas (s) "
                         f"`{json.dumps(profile.get('stageSeconds'), sort_keys=True)}`; "
                         f"cobertura observada válida={run.get('validObservedCoveragePct')}%; "
                         f"incertos={run.get('uncertainFrames')}; ausentes={run.get('missingFrames')}; contagens "
                         f"`{json.dumps(run['counts'], sort_keys=True)}`.")
        lines.append("")
        for comparison in case["pairedComparisons"]:
            lines.append(f"Comparação `{comparison['comparison']}` repetição {comparison['repetition']}: "
                         f"{comparison['statusChanges']} estados alterados, "
                         f"{comparison.get('coordinateChanges', 'não contado')} de "
                         f"{comparison['pairedCoordinates']} coordenadas pareadas alteradas, "
                         f"{comparison.get('coordinatePresenceChanges', 'não contado')} mudanças de presença, "
                         f"diferença máxima {comparison['maxCoordinateDifferencePx']:.3f} px; "
                         f"entre válidos, {comparison.get('validObservedCoordinateChanges', 'não contado')} "
                         f"de {comparison.get('pairedValidObservedCoordinates', 'não contado')} alterados, "
                         f"máximo {comparison.get('maxValidObservedCoordinateDifferencePx', 'não contado')} px.")
        lines.append("")
    lines.extend([report["resourceScope"], "", report["limits"], ""])
    path.with_suffix(".md").write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", required=True, help="ID:VIDEO:CONFIG_JSON; pode repetir")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--versions", choices=("current", "both"), default="both")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    cases = []
    for value in args.case:
        parts = value.split(":", 2)
        if len(parts) != 3 or not all(parts):
            parser.error("Use ID:VIDEO:CONFIG_JSON em --case")
        cases.append(tuple(parts))
    if len({case[0] for case in cases}) != len(cases):
        parser.error("IDs de casos duplicados")
    try:
        report = benchmark(cases, args.python, args.repeats, args.warmups,
                           ("head", "current") if args.versions == "both" else ("current",))
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    write_sidecars(args.output, report)
    print(json.dumps({"output": str(args.output), "cases": len(report["cases"])}))


if __name__ == "__main__":
    main()
