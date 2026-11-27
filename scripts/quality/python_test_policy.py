"""Explicit platform boundaries; all other skipped tracking tests fail quality."""

WINDOWS_REPLACE_TEST = "test_opencv_engine.StatusFileTests.test_retries_atomic_replace_after_windows_reader_releases_file"
COLAB_WORKER_MODULE = "unittest.loader.ModuleSkipped.test_worker"
COLAB_WORKER_REASON = "Worker Colab POSIX: executado em Linux e macOS"


def permitted_skip(test_id, reason, platform):
    if platform != "win32":
        return (test_id == WINDOWS_REPLACE_TEST
                and reason == "Bloqueio de substituição específico do Windows")
    return test_id == COLAB_WORKER_MODULE and reason == COLAB_WORKER_REASON
