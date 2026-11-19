import importlib.util
from pathlib import Path
import random
import unittest


MODULE = Path(__file__).with_name("select-validation-pilot.py")
SPEC = importlib.util.spec_from_file_location("select_validation_pilot", MODULE)
selector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(selector)


class SelectionTests(unittest.TestCase):
    def test_temporal_strata_are_deterministic_and_unique(self):
        first = selector.choose_indices(1000, 100, random.Random(5))
        second = selector.choose_indices(1000, 100, random.Random(5))
        self.assertEqual(first, second)
        self.assertEqual(len(set(first)), 100)
        self.assertEqual(first, sorted(first))

    def test_clips_do_not_share_four_second_bins(self):
        times = [frame / 25 for frame in range(5000)]
        clips = selector.choose_clips(times, 10, random.Random(5))
        self.assertEqual(len(clips), 10)
        self.assertTrue(all(a["endFrame"] < b["startFrame"] for a, b in zip(clips, clips[1:])))
        for clip in clips:
            self.assertEqual([frame["frameIndex"] for frame in clip["frames"]],
                             list(range(clip["startFrame"], clip["endFrame"] + 1)))
            self.assertEqual(clip["frames"][0]["timestampSec"], clip["startSec"])


if __name__ == "__main__":
    unittest.main()
