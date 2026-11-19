import importlib.util
from pathlib import Path
import unittest


MODULE = Path(__file__).with_name("benchmark-pose-filters-synthetic.py")
SPEC = importlib.util.spec_from_file_location("benchmark_pose_filters_synthetic", MODULE)
benchmark_pose_filters_synthetic = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark_pose_filters_synthetic)


class SyntheticBenchmarkTests(unittest.TestCase):
    def test_known_reference_error(self):
        reference = [(0, 0), (0, 0), (10, 0), (10, 0)]
        observed = [(0, 0), None, (0, 0), (10, 0)]
        result = benchmark_pose_filters_synthetic.metrics(observed, reference)
        self.assertEqual(result["validFrames"], 3)
        self.assertAlmostEqual(result["meanErrorToSyntheticTruthPx"], 10 / 3)

    def test_report_retains_missing_frames_and_marks_synthetic_scope(self):
        report = benchmark_pose_filters_synthetic.benchmark()
        self.assertEqual(report["status"], "SYNTHETIC_ONLY_NOT_ANATOMICAL_VALIDATION")
        case = report["cases"]["stationary_noisy_gap"]
        self.assertEqual(case["raw"]["validFrames"], 245)
        self.assertEqual(case["oneEuroBeta0001"]["validFrames"], 245)
        self.assertEqual(report["cases"]["step_clean"]["raw"]["halfStepDelayFrames"], 0)


if __name__ == "__main__":
    unittest.main()
