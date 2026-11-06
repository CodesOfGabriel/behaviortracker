import json
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import warnings
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from unittest.mock import patch

import worker


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="behavetracker-worker-test-")
        self.directory = self.temporary.name
        self.addCleanup(self.temporary.cleanup)
        warnings.simplefilter("ignore", ResourceWarning)

    def wait_for(self, expected=("succeeded", "failed")):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status = worker.snapshot(self.directory, "inference")
            if status["state"] in expected:
                return status
            time.sleep(0.02)
        self.fail("O worker não chegou ao estado esperado")

    def test_repeated_launch_uses_one_process_and_does_not_overwrite_source(self):
        source = ("import time\nfrom pathlib import Path\n"
                  f"with Path({str(Path(self.directory) / 'runs')!r}).open('a') as f: f.write('run\\n')\n"
                  "time.sleep(0.3)\nprint('resultado')\n")
        worker.launch(self.directory, "inference", source)
        first = self.wait_for(("running", "succeeded"))
        second = worker.launch(self.directory, "inference", "raise Exception('não executar')")
        self.assertEqual(first["pid"], second["pid"])
        self.assertEqual(self.wait_for()["state"], "succeeded")
        self.assertEqual((Path(self.directory) / "runs").read_text(), "run\n")
        self.assertEqual(worker.launch(self.directory, "inference", "pass")["state"], "succeeded")

    def test_concurrent_launches_do_not_start_two_workers(self):
        source = ("import time\nfrom pathlib import Path\n"
                  f"with Path({str(Path(self.directory) / 'runs')!r}).open('a') as f: f.write('run\\n')\n"
                  "time.sleep(0.2)\n")
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: worker.launch(self.directory, "inference", source), range(4)))
        self.assertEqual(self.wait_for()["state"], "succeeded")
        self.assertEqual((Path(self.directory) / "runs").read_text(), "run\n")

    def test_parent_can_exit_while_the_same_worker_finishes(self):
        # Simula a célula de lançamento encerrada; o processamento não usa sua conexão/stdio.
        source = "import time\ntime.sleep(0.2)\nprint('concluído sem a célula')"
        launcher = ("import runpy\n"
                    f"module = runpy.run_path({worker.__file__!r})\n"
                    f"module['launch']({self.directory!r}, 'inference', {source!r})\n")
        subprocess.run([sys.executable, "-B", "-c", launcher], check=True,
                       stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
        result = self.wait_for()
        self.assertEqual(result["state"], "succeeded")
        self.assertIn("concluído sem a célula", result["logTail"])

    def test_keyboard_interrupt_in_the_launcher_does_not_interrupt_the_worker(self):
        source = "import time\ntime.sleep(0.2)\nprint('resultado independente')"
        launcher = ("import runpy\n"
                    f"module = runpy.run_path({worker.__file__!r})\n"
                    f"module['launch']({self.directory!r}, 'inference', {source!r})\n"
                    "raise KeyboardInterrupt\n")
        result = subprocess.run([sys.executable, "-B", "-c", launcher],
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("KeyboardInterrupt", result.stderr.decode())
        report = self.wait_for()
        self.assertEqual(report["state"], "succeeded")
        self.assertIn("resultado independente", report["logTail"])

    def test_warnings_and_detector_100_percent_are_not_a_completed_job(self):
        source = ("import time\nprint('WARNING: config padrão', flush=True)\n"
                  "print('100%|████| 7356/7356 [03:29<00:00]', flush=True)\n"
                  "print('49%|████| 3633/7356 [01:21<01:23]', flush=True)\n"
                  "time.sleep(0.4)\n")
        worker.launch(self.directory, "inference", source)
        self.wait_for(("running",))
        deadline = time.monotonic() + 5
        report = worker.snapshot(self.directory, "inference")
        while not report.get("progressText") and time.monotonic() < deadline:
            time.sleep(0.01)
            report = worker.snapshot(self.directory, "inference")
        self.assertEqual(report["state"], "running")
        self.assertEqual(report["progressText"], "3633/7356 (49%)")
        self.wait_for()

    def test_actual_error_is_separate_from_warnings_and_is_not_retried(self):
        worker.launch(self.directory, "inference", "print('WARNING: config')\nraise ValueError('vídeo inválido')")
        report = self.wait_for()
        self.assertEqual(report["errorType"], "ValueError")
        self.assertEqual(report["error"], "vídeo inválido")
        self.assertIn("WARNING: config", report["logTail"])
        self.assertIn("raise ValueError", report["traceback"])
        self.assertEqual(worker.launch(self.directory, "inference", "pass")["state"], "failed")

    def test_diagnostic_timings_replace_older_model_progress(self):
        files = worker.paths(self.directory, "inference")
        worker.write_status(files["status"], {"state": "running"})
        files["log"].write_text("100%|████| 2/2\nBEHAVETRACKER_DIAGNOSTIC_PROGRESS=24 frames · detector 2.00s · pose 1.00s\n")
        self.assertIn("Diagnóstico: 24 frames",worker.snapshot(self.directory,"inference")["progressText"])

    def test_render_has_its_own_worker_and_lock(self):
        self.assertNotEqual(worker.paths(self.directory,"render")["status"], worker.paths(self.directory,"inference")["status"])
        with self.assertRaises(ValueError): worker.paths(self.directory,"../render")

    def test_visual_recovery_replaces_old_detector_percentage_in_progress(self):
        files = worker.paths(self.directory, "inference")
        worker.write_status(files["status"], {"state": "succeeded"})
        files["log"].write_text("100%|████| 7356/7356 [03:29<00:00]\nBEHAVETRACKER_RECOVERY_PROGRESS=240/7356\n")
        report = worker.snapshot(self.directory, "inference")
        self.assertEqual(report["progressText"], "Recuperação visual: 240/7356 frames verificados")

    def test_keyboard_interrupt_is_a_real_failure_not_a_configuration_warning(self):
        worker.launch(self.directory, "inference", "raise KeyboardInterrupt")
        report = self.wait_for()
        self.assertEqual(report["state"], "failed")
        self.assertEqual(report["errorType"], "KeyboardInterrupt")
        self.assertIn("interrompido", report["error"])

    def test_killed_process_never_becomes_successful_or_restarts(self):
        worker.launch(self.directory, "inference", "import time\ntime.sleep(60)")
        report = self.wait_for(("running",))
        os.kill(report["pid"], signal.SIGKILL)
        report = self.wait_for()
        self.assertEqual(report["state"], "failed")
        self.assertEqual(report["errorType"], "WorkerStopped")
        self.assertEqual(worker.launch(self.directory, "inference", "pass")["state"], "failed")

    def test_lost_runtime_files_are_not_treated_as_success(self):
        self.assertEqual(worker.snapshot(self.directory, "inference")["state"], "missing")
        self.assertEqual(worker.snapshot(str(Path(self.directory) / "gone"), "inference")["state"], "missing")

    def test_completion_between_status_read_and_lock_check_is_not_a_false_failure(self):
        path = worker.paths(self.directory, "inference")["status"]
        worker.write_status(path, {"state": "running"})
        def finishes_while_checking(_):
            worker.write_status(path, {"state": "succeeded"})
            return False
        with patch("worker.process_active", side_effect=finishes_while_checking):
            self.assertEqual(worker.snapshot(self.directory, "inference")["state"], "succeeded")

    def test_log_tail_is_bounded(self):
        worker.launch(self.directory, "inference", "print('w' * 50000)")
        report = self.wait_for()
        self.assertLessEqual(len(report["logTail"].encode()), worker.LOG_TAIL_BYTES)
        json.dumps(report)

    def test_compact_status_does_not_include_large_diagnostics(self):
        output = io.StringIO()
        with redirect_stdout(output):
            worker.print_report({"state": "running", "logTail": "warning\n" * 4000})
        lines = output.getvalue().splitlines()
        self.assertEqual(lines[0], lines[-1])
        self.assertNotIn("logTail", lines[0])
        self.assertTrue(lines[1].startswith("BEHAVETRACKER_WORKER_DETAILS="))


if __name__ == "__main__":
    unittest.main()
