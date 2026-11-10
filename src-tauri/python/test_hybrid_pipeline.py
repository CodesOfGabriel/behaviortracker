import tempfile
import unittest
from pathlib import Path

from hybrid.pipeline import prepare_manifest


class HybridPipelineTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "best_detector.pth").write_bytes(b"detector")
        (self.root / "snapshot-hrnet_w32-001.pt").write_bytes(b"pose")
        (self.root / "pytorch_config.yaml").write_text(
            "metadata:\n  bodyparts:\n" + "".join(f"    - p{index}\n" for index in range(27))
        )
        self.addCleanup(self.directory.cleanup)

    def rows(self, count):
        return (
            [{"normalizedFrameIndex": index} for index in range(count)],
            [{"frameIndex": index} for index in range(count)],
            [{"frameIndex": index} for index in range(count)],
        )

    def test_manifest_records_engine_bundle_and_artifacts(self):
        frame_map, detections, poses = self.rows(2)
        manifest = prepare_manifest(
            self.root, "a" * 64, {"width": 1280, "height": 720}, frame_map, detections, poses
        )
        self.assertEqual(manifest["engineId"], "wistar_superanimal_hybrid_v1")
        self.assertEqual(manifest["frameCounts"]["poses"], 2)
        self.assertEqual(manifest["artifacts"]["frameMap"], "frame_map.csv")

    def test_rejects_mismatched_frame_counts(self):
        frame_map, detections, poses = self.rows(2)
        with self.assertRaisesRegex(ValueError, "incompatíveis"):
            prepare_manifest(self.root, "a" * 64, {"width": 1, "height": 1}, frame_map, detections, poses[:1])


if __name__ == "__main__":
    unittest.main()
