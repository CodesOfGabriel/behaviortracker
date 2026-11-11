import tempfile
import unittest
from pathlib import Path

from hybrid.model_registry import validate_bundle
from hybrid.model_registry import sha256


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

    def test_v2_manifest_requires_all_hashes_and_sizes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "best_detector.pth").write_bytes(b"v2")
            (root / "snapshot-hrnet_w32-001.pt").write_bytes(b"pose")
            (root / "pytorch_config.yaml").write_text("metadata:\n  bodyparts:\n" + "".join(f"    - p{i}\n" for i in range(27)))
            manifest = {"bundleId": "wistar_df_v2", "keypointCount": 27,
                        "detectorClasses": ["background", "wistar"],
                        "files": {name: {"sizeBytes": (root / name).stat().st_size, "sha256": sha256(root / name)}
                                  for name in ("best_detector.pth", "snapshot-hrnet_w32-001.pt", "pytorch_config.yaml")}}
            self.assertEqual(validate_bundle(root, manifest)["bundleId"], "wistar_df_v2")
            manifest["files"]["best_detector.pth"]["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "Hash"):
                validate_bundle(root, manifest)


if __name__ == "__main__":
    unittest.main()
