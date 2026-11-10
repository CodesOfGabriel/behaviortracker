import unittest

from hybrid.detector_wistar import select_detection
from hybrid.quality_control import frame_quality
from hybrid.rearing_triage import candidates
from hybrid.temporal_filter import filter_keypoint


class HybridComponentTests(unittest.TestCase):
    def test_detector_selects_highest_score_and_expands_xywh(self):
        result = select_detection([
            {"score": .4, "x1": 10, "y1": 20, "x2": 30, "y2": 60},
            {"score": .9, "x1": 100, "y1": 50, "x2": 200, "y2": 150},
        ], 240, 200)
        self.assertTrue(result["observed"])
        self.assertEqual(result["bboxRaw"], {"x": 100., "y": 50., "width": 100., "height": 100.})
        self.assertEqual(result["bboxPose"], {"x": 88., "y": 38., "width": 124., "height": 124.})

    def test_detector_keeps_missing_explicit(self):
        result = select_detection([{"score": .2, "x1": 1, "y1": 1, "x2": 4, "y2": 4}], 10, 10)
        self.assertFalse(result["observed"])
        self.assertIn("detector_missing", result["qualityFlags"])

    def test_fc_filter_does_not_impute_low_confidence_gap(self):
        samples = [(10, 10, .9), (11, 10, .9), (None, None, .0), (13, 10, .9), (14, 10, .9)]
        filtered = filter_keypoint(samples)
        self.assertIsNone(filtered[2])
        self.assertIsNone(filtered[0])

    def test_quality_flags_are_explicit(self):
        flags = frame_quality({"observed": False, "qualityFlags": []}, (None, None, 0), None)
        self.assertEqual(flags, ["centro_nao_confiavel", "sem_bbox"])

    def test_rearing_is_only_a_review_candidate(self):
        frames = [
            {"timestampSec": 0, "bbox": {"height": 100}, "pose": {"head": (10, 10), "base": (10, 40)}},
            {"timestampSec": .25, "bbox": {"height": 100}, "pose": {"head": (10, 10), "base": (10, 40)}},
        ]
        self.assertEqual(candidates(frames)[0]["status"], "needs_review")


if __name__ == "__main__":
    unittest.main()
