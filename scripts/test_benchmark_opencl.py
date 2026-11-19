import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE = Path(__file__).with_name("benchmark-opencl.py")
SPEC = importlib.util.spec_from_file_location("benchmark_opencl", MODULE)
benchmark_opencl = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark_opencl)


class OpenClBenchmarkTests(unittest.TestCase):
    def test_summary_keeps_unavailable_process_samples_explicit(self):
        runs = [{"wallSec": 10, "throughputFps": 20, "cpuMeanPctOfOneCore": 180,
                 "cpuMaxSampledPctOfOneCore": None, "peakSimultaneousRssSampledMiB": None},
                {"wallSec": 12, "throughputFps": 18, "cpuMeanPctOfOneCore": 170,
                 "cpuMaxSampledPctOfOneCore": None, "peakSimultaneousRssSampledMiB": None}]
        result = benchmark_opencl.summarize(runs)
        self.assertEqual(result["wallSec"], 11)
        self.assertIsNone(result["cpuMaxSampledPctOfOneCore"])
        self.assertIsNone(result["peakSimultaneousRssSampledMiB"])

    def test_paired_difference_uses_same_frame_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            left, right = Path(directory) / "left.jsonl", Path(directory) / "right.jsonl"
            a = [{"frameIndex": 0, "timestampSec": 0, "xPx": 1, "yPx": 2, "status": "valid", "source": "segmented"},
                 {"frameIndex": 1, "timestampSec": .04, "xPx": None, "yPx": None, "status": "missing", "source": "segmented"}]
            b = [{**a[0], "xPx": 4}, {**a[1], "status": "low_confidence"}]
            left.write_text("\n".join(map(json.dumps, a)) + "\n")
            right.write_text("\n".join(map(json.dumps, b)) + "\n")
            result = benchmark_opencl.sample_difference(left, right)
            self.assertEqual(result["pairedCoordinates"], 1)
            self.assertEqual(result["coordinateChanges"], 1)
            self.assertEqual(result["pairedValidObservedCoordinates"], 1)
            self.assertEqual(result["validObservedCoordinateChanges"], 1)
            self.assertEqual(result["maxValidObservedCoordinateDifferencePx"], 3)
            self.assertEqual(result["statusChanges"], 1)
            self.assertEqual(result["maxCoordinateDifferencePx"], 3)
            self.assertEqual(benchmark_opencl.technical_counts(left)["validObservedFrames"], 1)
            self.assertEqual(benchmark_opencl.technical_counts(left)["missingFrames"], 1)
            b[1]["timestampSec"] = .05
            right.write_text("\n".join(map(json.dumps, b)) + "\n")
            with self.assertRaisesRegex(ValueError, "Relógios diferentes"):
                benchmark_opencl.sample_difference(left, right)


if __name__ == "__main__":
    unittest.main()
