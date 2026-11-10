import unittest

from trajectory_postprocess import POLICY, postprocess_centers


def centers(xs):
    return [(x, 100.0, .9, "valid") for x in xs]


class TrajectoryPostprocessTests(unittest.TestCase):
    def test_isolated_spike_is_removed_from_metrics_without_changing_raw_input(self):
        original = centers([100, 101, 102, 220, 104, 105, 106])
        processed, stats = postprocess_centers(original, ["detected"] * 7, 1000, 1000)
        self.assertEqual(original[3], (220, 100.0, .9, "valid"))
        self.assertEqual(processed[3], (220, 100.0, .9, "jump"))
        self.assertEqual(stats["rejectedStatistical"], 1)
        self.assertEqual(processed[2][:2], original[2][:2])
        self.assertEqual(processed[4][:2], original[4][:2])
        short, stats = postprocess_centers(centers([100, 101, 250, 103, 104]),
            ["detected"] * 5, 1000, 1000)
        self.assertEqual(short[2][3], "jump")
        self.assertEqual(stats["rejectedStatistical"], 1)

    def test_smoothing_reduces_jitter_and_preserves_linear_movement(self):
        jitter = centers([100, 110, 100, 110, 100, 110, 100])
        processed, stats = postprocess_centers(jitter, ["detected"] * 7, 1000, 1000)
        self.assertEqual(processed[0], jitter[0])
        self.assertAlmostEqual(processed[2][0], 105)
        self.assertEqual(stats["smoothedFrames"], 5)
        linear = centers([100, 110, 120, 130, 140, 150, 160])
        processed, stats = postprocess_centers(linear, ["detected"] * 7, 1000, 1000)
        self.assertEqual(processed, linear)
        self.assertEqual(stats["rejectedStatistical"], 0)

    def test_no_smoothing_or_imputation_across_missing_or_recovered_frame(self):
        points = centers([100, 110, 120, 130, 140, 150, 160])
        points[3] = (None, None, 0.0, "missing")
        processed, stats = postprocess_centers(points, ["detected"] * 7, 1000, 1000)
        self.assertEqual(processed[3], points[3])
        self.assertEqual(processed[2], points[2])
        self.assertEqual(processed[4], points[4])
        self.assertEqual(stats["rejectedStatistical"], 0)
        uncertain = centers([100, 110, 120, 130, 140, 150, 160])
        uncertain[3] = (130, 100.0, .45, "low_confidence")
        processed, stats = postprocess_centers(uncertain, ["detected"] * 7, 1000, 1000)
        self.assertEqual(processed[3], uncertain[3])
        self.assertEqual(processed[2], uncertain[2])
        self.assertEqual(processed[4], uncertain[4])
        self.assertEqual(stats["validDetectedFrames"], 6)
        recovered = centers([100, 110, 120, 130, 140, 150, 160])
        processed, stats = postprocess_centers(recovered,
            ["detected"] * 3 + ["recovered"] + ["detected"] * 3, 1000, 1000)
        self.assertEqual(processed[3], recovered[3])
        self.assertEqual(processed[2], recovered[2])
        self.assertEqual(processed[4], recovered[4])
        self.assertEqual(stats["smoothedFrames"], 2)

    def test_sustained_change_is_retained(self):
        original = centers([100, 101, 102, 200, 201, 202, 203, 204])
        processed, stats = postprocess_centers(original, ["detected"] * 8, 1000, 1000)
        self.assertEqual(stats["rejectedStatistical"], 0)
        self.assertEqual(processed[3], original[3])
        self.assertEqual(POLICY["version"], "dlc-adapted-trajectory-c-1")


if __name__ == "__main__":
    unittest.main()
