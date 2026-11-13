"""Jobs do runtime independentes da célula MCP; não mantém o runtime vivo."""

import fcntl
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import tempfile
import time
import traceback


LOG_TAIL_BYTES = 16 * 1024


def paths(directory, task):
    if task not in ("setup", "inference", "render", "training", "model_detector", "model_hrnet", "model_config"):
        raise ValueError("Tarefa desconhecida")
    root = Path(directory)
    return {name: root / (task + suffix) for name, suffix in (
        ("script", ".py"), ("status", ".status.json"),
        ("log", ".log"), ("lock", ".lock"),
    )}


def write_status(path, report):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as handle:
            temporary = handle.name
            json.dump(report, handle, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def read_status(path):
    if not path.is_file():
        return None
    return json.loads(path.read_text())


def process_active(lock_path):
    # A trava é herdada pelo worker e liberada pelo SO ao encerrar, sem confiar em PID reutilizável.
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def snapshot(directory, task):
    files = paths(directory, task)
    report = read_status(files["status"])
    if report is None:
        if files["status"].parent.exists() and process_active(files["lock"]):
            return {"state": "starting", "logTail": ""}
        return {"state": "missing", "error": "O runtime perdeu os arquivos desta execução."}
    if report["state"] in ("starting", "running") and not process_active(files["lock"]):
        # O worker pode ter publicado o resultado entre a primeira leitura e a liberação da trava.
        report = read_status(files["status"]) or report
        if report["state"] in ("starting", "running"):
            report = dict(report, state="failed", errorType="WorkerStopped",
                          error="O processo terminou sem confirmar o resultado. O runtime pode ter sido reiniciado.")
    tail = ""
    if files["log"].is_file():
        with files["log"].open("rb") as handle:
            handle.seek(max(0, files["log"].stat().st_size - LOG_TAIL_BYTES))
            tail = handle.read(LOG_TAIL_BYTES).decode("utf-8", errors="replace")
    report["logTail"] = tail
    if "traceback" in report:
        report["traceback"] = report["traceback"][-LOG_TAIL_BYTES:]
    if "error" in report:
        report["error"] = report["error"][-2000:]
    clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", tail)
    matches = list(re.finditer(r"(\d{1,3})%\|[^\r\n]*?\|\s*(\d+)/(\d+)", clean))
    if matches:
        percent, current, total = matches[-1].groups()
        report["progressText"] = f"{current}/{total} ({percent}%)"
    recovery = list(re.finditer(r"BEHAVETRACKER_RECOVERY_PROGRESS=(\d+)/(\d+)", clean))
    if recovery and (not matches or recovery[-1].start() > matches[-1].start()):
        current, total = recovery[-1].groups()
        report["progressText"] = f"Recuperação visual: {current}/{total} frames verificados"
    detector = list(re.finditer(r"BEHAVETRACKER_DETECTOR_PROGRESS=([^\r\n]+)", clean))
    if detector and (not recovery or detector[-1].start() > recovery[-1].start()):
        report["progressText"] = "Detector Wistar · " + detector[-1].group(1)
    video_phase = list(re.finditer(r"BEHAVETRACKER_VIDEO_PHASE=([^\r\n]+)", clean))
    last_progress = max(matches[-1].start() if matches else -1, recovery[-1].start() if recovery else -1)
    hybrid = list(re.finditer(r"BEHAVETRACKER_HYBRID_PHASE=([^\r\n]+)", clean))
    if hybrid and hybrid[-1].start() > last_progress:
        report["progressText"] = hybrid[-1].group(1)
        last_progress = hybrid[-1].start()
    diagnostic = list(re.finditer(r"BEHAVETRACKER_DIAGNOSTIC_PROGRESS=([^\r\n]+)", clean))
    if diagnostic and diagnostic[-1].start() > last_progress:
        report["progressText"] = "Diagnóstico: " + diagnostic[-1].group(1)
        last_progress = diagnostic[-1].start()
    custom = list(re.finditer(r"BEHAVETRACKER_(?:TRAINING|CUSTOM)_PROGRESS=([^\r\n]+)", clean))
    if custom and custom[-1].start() > last_progress:
        report["progressText"] = custom[-1].group(1)
        last_progress = custom[-1].start()
    if video_phase and video_phase[-1].start() > last_progress:
        report["progressText"] = video_phase[-1].group(1)
    fst_phase = list(re.finditer(r"BEHAVETRACKER_FST_PHASE=([a-z_]+)", clean))
    if fst_phase:
        report["progressText"] = "FST_STAGE=" + fst_phase[-1].group(1)
    return report


def print_report(report):
    compact = {key: value for key, value in report.items() if key not in ("logTail", "traceback")}
    line = "BEHAVETRACKER_WORKER=" + json.dumps(compact, ensure_ascii=False)
    # O estado não depende do log caber no limite de saída MCP, seja o corte no início ou no fim.
    print(line, flush=True)
    print("BEHAVETRACKER_WORKER_DETAILS=" + json.dumps(report, ensure_ascii=False), flush=True)
    print(line, flush=True)


def launch(directory, task, source):
    files = paths(directory, task)
    files["status"].parent.mkdir(parents=True, exist_ok=True)
    with files["lock"].open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return snapshot(directory, task)
        previous = read_status(files["status"])
        if previous is not None:
            # Inclusive falhas: uma resposta perdida não autoriza reiniciar o mesmo job.
            if previous["state"] in ("starting", "running"):
                previous = dict(previous, state="failed", errorType="WorkerStopped",
                                error="O processo anterior terminou sem confirmar o resultado.")
                write_status(files["status"], previous)
            return snapshot(directory, task)
        files["script"].write_text(source)
        initial = {"state": "starting", "createdAt": time.time()}
        write_status(files["status"], initial)
        try:
            with files["log"].open("ab", buffering=0) as log:
                child = subprocess.Popen(
                    [sys.executable, "-u", str(Path(__file__).resolve()), "run", str(files["script"]),
                     str(files["status"]), str(lock.fileno())],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                    start_new_session=True, close_fds=True, pass_fds=(lock.fileno(),),
                )
            # O filho mantém a mesma trava mesmo se a célula ou a conexão MCP for interrompida.
            del child
        except Exception as error:
            write_status(files["status"], dict(initial, state="failed",
                         errorType=type(error).__name__, error=str(error) or "Inicialização interrompida"))
            raise
    return snapshot(directory, task)


def run_task(script, status, lock_fd):
    # Mantém o descritor herdado aberto durante toda a tarefa.
    os.fstat(lock_fd)
    path = Path(status)
    initial = read_status(path) or {}
    report = dict(initial, state="running", pid=os.getpid(), startedAt=time.time())
    write_status(path, report)
    try:
        runpy.run_path(script, run_name="__main__")
    except BaseException as error:
        trace = traceback.format_exc()
        print(trace, file=sys.stderr, flush=True)
        write_status(path, dict(report, state="failed", finishedAt=time.time(),
                     errorType=type(error).__name__,
                     error=str(error) or "O processo foi interrompido no runtime.", traceback=trace))
        return 1
    write_status(path, dict(report, state="succeeded", finishedAt=time.time()))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] != "run":
        raise SystemExit("Uso interno: worker.py run script status lock_fd")
    raise SystemExit(run_task(sys.argv[2], sys.argv[3], int(sys.argv[4])))
