import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("prepare_local_review", Path(__file__).with_name("prepare-local-review.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReviewSelectionTests(unittest.TestCase):
    def samples(self):
        return [{"frameIndex": i, "timestampSec": i/25, "reason": "rare_loss" if i == 187 else "observed",
                 "bbox": {"x": 10, "y": 20, "width": 30, "height": 20}} for i in range(300)]

    def test_deterministic_selection_covers_time_and_rare_alerts_without_labels(self):
        selected = MODULE.select(self.samples())
        self.assertEqual(selected, MODULE.select(self.samples()))
        self.assertEqual(len(selected), 120)
        frames = [sample["frameIndex"] for sample in selected]
        self.assertEqual(len(set(frames)), 120)
        self.assertEqual((frames[0], frames[-1]), (0, 299))
        self.assertIn(187, frames)
        for sample in selected:
            self.assertIsNone(sample["humanBox"])
            self.assertIsNone(sample["annotatorId"])
            self.assertFalse(sample["approved"])

    def test_short_recording_never_duplicates_or_invents_frames(self):
        self.assertEqual(len(MODULE.select(self.samples()[:3])), 3)
        self.assertEqual(MODULE.select([]), [])

    def test_rejects_an_unbounded_review_request(self):
        with self.assertRaises(ValueError):
            MODULE.select(self.samples(), 100000)


if __name__ == "__main__":
    unittest.main()
