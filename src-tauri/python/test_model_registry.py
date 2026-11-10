import tempfile
import unittest
from pathlib import Path

from hybrid.model_registry import validate_bundle


class ModelRegistryTests(unittest.TestCase):
    def test_validates_required_files_and_keypoint_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "best_detector.pth").write_bytes(b"detector")
            (root / "snapshot-hrnet_w32-001.pt").write_bytes(b"pose")
            (root / "pytorch_config.yaml").write_text("metadata:\n  bodyparts:\n" + "".join("    - p%d\n" % index for index in range(27)))
            bundle = validate_bundle(root)
            self.assertEqual(bundle["bundleId"], "wistar_df_v1")
            self.assertEqual(bundle["keypointCount"], 27)

    def test_rejects_missing_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "pytorch_config.yaml").write_text("metadata: {}")
            with self.assertRaisesRegex(ValueError, "obrigatório"):
                validate_bundle(root)


if __name__ == "__main__":
    unittest.main()
