import unittest
from quality.python_test_policy import (
    COLAB_WORKER_MODULE, COLAB_WORKER_REASON, WINDOWS_REPLACE_TEST, permitted_skip,
)


class PlatformSkipPolicyTests(unittest.TestCase):
    def test_posix_worker_must_run_on_linux_and_macos(self):
        for platform in ("linux", "darwin"):
            self.assertFalse(permitted_skip(COLAB_WORKER_MODULE, COLAB_WORKER_REASON, platform))
        self.assertTrue(permitted_skip(COLAB_WORKER_MODULE, COLAB_WORKER_REASON, "win32"))

    def test_windows_file_lock_test_must_run_on_windows(self):
        reason = "Bloqueio de substituição específico do Windows"
        self.assertFalse(permitted_skip(WINDOWS_REPLACE_TEST, reason, "win32"))
        self.assertTrue(permitted_skip(WINDOWS_REPLACE_TEST, reason, "linux"))
        self.assertTrue(permitted_skip(WINDOWS_REPLACE_TEST, reason, "darwin"))

    def test_other_skips_cannot_reuse_an_allowed_reason(self):
        for platform in ("win32", "linux", "darwin"):
            for reason in (COLAB_WORKER_REASON, "Bloqueio de substituição específico do Windows", "missing numpy"):
                self.assertFalse(permitted_skip("test_local_precision.TrackingTests.test_tracking", reason, platform))
            self.assertFalse(permitted_skip(COLAB_WORKER_MODULE, "missing dependency", platform))
