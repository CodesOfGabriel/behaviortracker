import unittest
import arena
from diagnostic import frame_evidence, summary


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.geometry = {"cropping": [20, 220, 40, 240], "videoWidth": 300, "videoHeight": 300}
        self.api = vars(arena)
        self.names = ["nose", "mid_back", "hip"]

    def evidence(self, points, box=(5, 6, 80, 90)):
        return frame_evidence(28, 24, self.names, points, box, .9, self.geometry, self.api)

    def test_detector_missing_is_distinct_from_box_with_no_pose(self):
        missing = [(-1, -1, -1)] * 3
        self.assertEqual(self.evidence(missing, None)[0]["state"], "detector_missing")
        self.assertEqual(self.evidence(missing)[0]["state"], "pose_missing")

    def test_raw_points_can_exist_without_a_canonical_center(self):
        data, points = self.evidence([(20, 30, .9), (-1, -1, -1), (-1, -1, -1)])
        self.assertEqual(data["state"], "center_missing")
        self.assertEqual(data["availablePoints"], 1)
        self.assertEqual(points["nose"][:2], (40, 70))
        self.assertEqual(data["bbox"], {"x": 25., "y": 46., "width": 80., "height": 90., "score": .9})

    def test_partial_points_are_not_marked_accurate(self):
        partial, _ = self.evidence([(20, 30, .4), (30, 40, .9), (-1, -1, -1)])
        self.assertEqual(partial["state"], "partial")
        self.assertTrue(partial["canonicalCenterAvailable"])
        full, _ = self.evidence([(20,30,.9), (30,40,.9), (40,50,.9)])
        self.assertEqual(full["state"], "points_available")
        report = summary([partial, full, self.evidence([(-1,-1,-1)]*3, None)[0]])
        self.assertFalse(report["accuracyMeasured"])
        self.assertAlmostEqual(report["detectorCoveragePct"], 200/3)
        self.assertAlmostEqual(report["centerCoveragePct"], 200/3)
        self.assertEqual(summary([])["frameCount"], 0)

    def test_points_rejected_by_geometry_are_not_misreported_as_model_producing_no_points(self):
        data, _ = self.evidence([(999,999,.9)]*3)
        self.assertEqual(data["state"],"adapter_rejected")
        self.assertEqual(data["rawAvailablePoints"],3)
        self.assertEqual(data["adapterRejectedPoints"],3)


if __name__ == "__main__":
    unittest.main()
