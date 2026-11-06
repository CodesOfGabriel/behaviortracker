import types
import unittest
from unittest.mock import patch

from environment import probe_environment


def fake_inference(videos, superanimal_name, model_name, detector_name, video_adapt, cropping):
    pass


class EnvironmentTests(unittest.TestCase):
    def modules(self, name):
        if name == "deeplabcut.modelzoo.video_inference":
            return types.SimpleNamespace(video_inference_superanimal=fake_inference)
        if name == "torch":
            return types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True),
                                         __version__="2.5.0", version=types.SimpleNamespace(cuda="12.1"))
        return types.SimpleNamespace()

    @patch("environment.importlib.metadata.version", return_value="3.0.0")
    def test_reuses_an_importable_environment_with_cuda(self, _):
        with patch("environment.importlib.import_module", side_effect=self.modules):
            report = probe_environment()
        self.assertTrue(report["ready"])
        self.assertFalse(report["installNeeded"])
        self.assertEqual(report["version"], "3.0.0")

    @patch("environment.importlib.metadata.version", side_effect=ModuleNotFoundError("deeplabcut"))
    def test_missing_package_requires_installation(self, _):
        self.assertTrue(probe_environment()["installNeeded"])

    @patch("environment.importlib.metadata.version", return_value="2.3.0")
    def test_old_api_requires_preparation(self, _):
        report = probe_environment()
        self.assertFalse(report["ready"])
        self.assertTrue(report["installNeeded"])

    @patch("environment.importlib.metadata.version", return_value="3.0.0")
    def test_cuda_failure_does_not_request_repeated_package_installation(self, _):
        def no_cuda(name):
            module = self.modules(name)
            if name == "torch":
                module.cuda.is_available = lambda: False
            return module
        with patch("environment.importlib.import_module", side_effect=no_cuda):
            report = probe_environment()
        self.assertFalse(report["ready"])
        self.assertFalse(report["installNeeded"])


if __name__ == "__main__":
    unittest.main()
