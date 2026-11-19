import math
import unittest

from hybrid.one_euro_filter import OneEuro2D, filter_keypoint


class OneEuroTests(unittest.TestCase):
    def test_actual_timestamps_change_smoothing_and_zero_is_valid(self):
        fast = OneEuro2D(beta=0)
        slow = OneEuro2D(beta=0)
        fast.update(0, 0, 0)
        slow.update(0, 0, 0)
        self.assertGreater(slow.update(0.2, 10, 0)[0], fast.update(0.02, 10, 0)[0])

    def test_adaptation_reduces_step_lag(self):
        fixed = OneEuro2D(beta=0)
        adaptive = OneEuro2D(beta=.02)
        for index in range(10):
            fixed.update(index/30, 0, 0)
            adaptive.update(index/30, 0, 0)
        self.assertGreater(adaptive.update(10/30, 40, 0)[0], fixed.update(10/30, 40, 0)[0])

    def test_invalid_frame_resets_without_imputation_or_input_change(self):
        samples = [(10., 20., .9), (20., 20., .9), (None, None, .1), (30., 20., .9)]
        original = list(samples)
        filtered = filter_keypoint(samples, [0, .04, .08, .12])
        self.assertEqual(samples, original)
        self.assertIsNone(filtered[2])
        self.assertEqual(filtered[3], samples[3])

    def test_long_gap_resets_and_status_rejects_observation(self):
        samples = [(0., 0., 1.), (10., 0., 1.), (20., 0., 1.), (30., 0., 1.)]
        result = filter_keypoint(samples, [0, .03, .4, .43], statuses=["valid", "valid", "valid", "missing"])
        self.assertEqual(result[2], samples[2])
        self.assertIsNone(result[3])

    def test_rejects_bad_times_and_nonfinite_values(self):
        with self.assertRaises(ValueError):
            filter_keypoint([(0., 0., 1.), (1., 1., 1.)], [0, 0])
        with self.assertRaises(ValueError):
            OneEuro2D(beta=-.01)
        with self.assertRaises(ValueError):
            OneEuro2D().update(0, math.inf, 0)


if __name__ == "__main__":
    unittest.main()
