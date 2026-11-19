import csv
import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE = Path(__file__).with_name("compare-pose-filters.py")
SPEC = importlib.util.spec_from_file_location("compare_pose_filters", MODULE)
compare_pose_filters = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compare_pose_filters)


class ComparisonTests(unittest.TestCase):
    def test_only_approved_references_produce_error_on_common_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            pose = Path(directory) / "pose.csv"
            with pose.open("w", newline="") as output:
                writer = csv.writer(output)
                writer.writerow(("frame_index", "timestamp_sec", "animal_id", "keypoint", "x_px", "y_px", "likelihood", "status", "source"))
                for index in range(6):
                    writer.writerow((index, index / 25, "animal_1", "mouse_center", index * 2, 10, .9,
                                     "low_confidence" if index == 2 else "valid", "detected"))
            reference = Path(directory) / "reference.csv"
            with reference.open("w", newline="") as output:
                writer = csv.writer(output)
                writer.writerow(("frame_index", "animal_id", "keypoint", "x_px", "y_px", "approved",
                                 "visibility", "annotator_id", "reviewer_id", "video_sha256", "status", "annotation_source", "timestamp_sec"))
                writer.writerows((index, "animal_1", "mouse_center", index * 2, 10,
                                  "true" if index != 2 else "false", "visible", "observer_1", "reviewer_1",
                                  "a" * 64, "approved" if index != 2 else "draft", "human", index / 25)
                                 for index in range(6))
            no_truth = compare_pose_filters.compare(pose)
            self.assertIsNone(no_truth["series"][0]["oneEuro"]["maeOnCommonApprovedFramesPx"])
            result = compare_pose_filters.compare(pose, reference, video_sha256="a" * 64)
            self.assertEqual(result["status"], "HUMAN_REFERENCE_PAIRED_EXPERIMENTAL")
            group = result["series"][0]
            self.assertEqual(group["raw"]["validFrames"], 5)
            self.assertEqual(group["oneEuro"]["validFrames"], 5)
            self.assertEqual(group["raw"]["internalGapRuns"], 1)
            self.assertEqual(group["raw"]["longestInternalGapFrames"], 1)
            self.assertEqual(group["raw"]["consecutivePairCount"], 3)
            self.assertEqual(group["raw"]["largeStepPairs"], 0)
            self.assertGreater(group["commonApprovedReferenceFrames"], 0)
            self.assertLess(group["commonApprovedReferenceFrames"], group["raw"]["validFrames"])
            self.assertEqual(group["raw"]["maeOnCommonApprovedFramesPx"], 0)
            self.assertEqual(group["raw"]["rmseOnCommonApprovedFramesPx"], 0)
            self.assertEqual(group["raw"]["pckAt5PxOnCommonApprovedFramesPct"], 100)
            report = Path(directory) / "comparison.json"
            compare_pose_filters.write_sidecars(report, result)
            with report.with_suffix(".summary.csv").open(newline="") as output:
                rows = list(csv.DictReader(output))
            self.assertEqual(rows[0]["videoSha256"], "a" * 64)
            self.assertEqual(rows[0]["variant"], "raw")
            self.assertEqual(rows[0]["maeOnCommonApprovedFramesPx"], "0.0")
            with report.with_suffix(".paired.csv").open(newline="") as output:
                paired = list(csv.DictReader(output))
            self.assertEqual(len(paired), group["commonApprovedReferenceFrames"])

    def test_large_steps_only_count_adjacent_valid_frames(self):
        values = [(0, 0), (20, 0), None, (100, 0), (101, 0), None]
        raw = [(0, 0), (19, 0), None, (100, 0), (101, 0), None]
        result = compare_pose_filters.summary(values, raw, {}, ("animal_1", "mouse_center"), [], 15)
        self.assertEqual(result["largeStepPairs"], 1)
        self.assertEqual(result["changedFromRawFrames"], 1)
        self.assertEqual(result["consecutivePairCount"], 2)
        self.assertEqual(result["internalGapRuns"], 1)
        self.assertEqual(result["longestInternalGapFrames"], 1)

    def test_duplicate_approved_observers_require_explicit_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            reference = Path(directory) / "reference.csv"
            with reference.open("w", newline="") as output:
                writer = csv.writer(output)
                writer.writerow(("frame_index", "animal_id", "keypoint", "x_px", "y_px", "approved",
                                 "visibility", "annotator_id", "reviewer_id", "video_sha256", "status", "annotation_source", "timestamp_sec"))
                for observer in ("observer_1", "observer_2"):
                    writer.writerow((2, "animal_1", "nose", 10, 12, "true", "visible", observer,
                                     "reviewer", "b" * 64, "approved", "human", 0.08))
            with self.assertRaisesRegex(ValueError, "selecione --annotator"):
                compare_pose_filters.read_reference(reference, "b" * 64)
            selected = compare_pose_filters.read_reference(reference, "b" * 64, "observer_1")
            self.assertEqual(selected[("animal_1", "nose", 2)], (10, 12, 0.08))

    def test_rejects_reference_with_different_frame_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            pose = Path(directory) / "pose.csv"
            pose.write_text("frame_index,timestamp_sec,animal_id,keypoint,x_px,y_px,likelihood,status,source\n"
                            "0,0,animal_1,nose,10,12,0.9,valid,detected\n"
                            "1,0.04,animal_1,nose,10,12,0.9,valid,detected\n")
            reference = Path(directory) / "reference.csv"
            reference.write_text("frame_index,animal_id,keypoint,x_px,y_px,approved,visibility,annotator_id,"
                                 "reviewer_id,video_sha256,status,annotation_source,timestamp_sec\n"
                                 f"1,animal_1,nose,10,12,true,visible,observer,reviewer,{'a'*64},approved,human,0.08\n")
            with self.assertRaisesRegex(ValueError, "mesmo relógio"):
                compare_pose_filters.compare(pose, reference, video_sha256="a" * 64)


if __name__ == "__main__":
    unittest.main()
