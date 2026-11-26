import unittest

import cv2
import numpy as np

from hybrid.pose_continuity import recover_points, gray_frames, coverage_summary


def box(observed=True):
    return {"observed": observed, "x": 5, "y": 5, "w": 90, "h": 90}


class PoseContinuityTests(unittest.TestCase):
    def test_coverage_audits_leading_internal_and_trailing_gaps_without_promoting_recovery(self):
        accepted = np.array([[1, 0], [0, 1], [0, 0], [1, 1], [1, 1], [0, 1]], dtype=bool)
        recovered = np.zeros_like(accepted)
        recovered[3, 0] = True
        report = coverage_summary(accepted, recovered, ["mouse_center", "nose"], 2.)
        self.assertFalse(report["accuracyMeasured"])
        self.assertFalse(report["completeVisualCoverage"])
        self.assertEqual(report["framesWithoutAnyVisualPoint"], 1)
        self.assertEqual(report["framesWithoutFullVisualPose"], 4)
        center = report["perKeypoint"]["mouse_center"]
        self.assertEqual(center["neural"]["acceptedFrames"], 2)
        self.assertEqual(center["neural"]["maxGapFrames"], 3)
        self.assertEqual(center["visualIncludingRecovery"]["maxGapFrames"], 2)
        self.assertEqual(center["visualIncludingRecovery"]["maxGapSec"], 1.)
        self.assertEqual(center["visualIncludingRecovery"]["longestGap"], {"startFrame": 1, "endFrameExclusive": 3})
        nose = report["perKeypoint"]["nose"]["neural"]
        self.assertEqual(nose["gapCount"], 2)

    def test_empty_or_invalid_coverage_cannot_claim_complete_tracking(self):
        self.assertFalse(coverage_summary(np.zeros((0, 1)), np.zeros((0, 1)), ["nose"], 16)["completeVisualCoverage"])
        report = coverage_summary(np.ones((3, 1)), np.zeros((3, 1)), ["nose"], 16)
        self.assertTrue(report["completeVisualCoverage"])
        self.assertIsNone(report["perKeypoint"]["nose"]["neural"]["longestGap"])
        with self.assertRaises(ValueError):
            coverage_summary(np.zeros((1, 1)), np.ones((1, 1)), ["nose"], 16)

    def data(self):
        image = np.zeros((100, 100), np.uint8)
        image[20:80, 20:80] = np.random.default_rng(7).integers(0, 255, (60, 60), dtype=np.uint8)
        frames = [cv2.warpAffine(image, np.float32([[1, 0, i*2], [0, 1, i]]), (100, 100)) for i in range(5)]
        poses = np.full((5, 1, 3), -1., dtype=float)
        poses[0, 0] = [40, 40, .9]
        poses[4, 0] = [48, 44, .8]
        accepted = np.array([[True], [False], [False], [False], [True]])
        reader = lambda reverse: [(i, frames[i]) for i in (range(4, -1, -1) if reverse else range(5))]
        return poses, accepted, reader

    def test_real_optical_flow_recovers_a_translating_point_from_both_anchors(self):
        poses, accepted, reader = self.data()
        raw = poses.copy()
        selected, recovered, audit = recover_points("fake", poses, accepted, [box()]*5, ["nose"], 16, frames=reader)
        self.assertEqual(recovered[:, 0].tolist(), [False, True, True, True, False])
        np.testing.assert_allclose(selected[:, 0, :2], [[40+i*2, 40+i] for i in range(5)], atol=.1)
        np.testing.assert_array_equal(poses, raw)
        np.testing.assert_array_equal(selected[accepted], poses[accepted])
        self.assertTrue((selected[recovered, 2] == .8).all())
        self.assertTrue((audit["before"][recovered] == 0).all())
        self.assertTrue((audit["after"][recovered] == 4).all())
        self.assertLess(float(audit["error"][recovered].max()), .1)
        self.assertIs(audit["policy"]["metricEligible"], False)

    def test_one_anchor_cannot_be_held_indefinitely_as_a_pose(self):
        poses, accepted, _ = self.data()
        accepted[4] = False
        _, recovered, _ = recover_points("fake", poses, accepted, [box()]*5, ["nose"], 16,
                                         frames=lambda _: self.fail("Sem duas âncoras não deve haver recuperação"))
        self.assertFalse(recovered.any())

    def test_blank_images_cannot_validate_motion(self):
        poses, accepted, _ = self.data()
        frames = lambda reverse: [(i, np.zeros((100, 100), np.uint8)) for i in (range(4, -1, -1) if reverse else range(5))]
        self.assertFalse(recover_points("fake", poses, accepted, [box()]*5, ["nose"], 16, frames=frames)[1].any())

    def test_conflicting_anchor_locations_are_not_averaged(self):
        poses, accepted, reader = self.data()
        poses[4, 0, 0] += 15
        self.assertFalse(recover_points("fake", poses, accepted, [box()]*5, ["nose"], 16, frames=reader)[1].any())

    def test_long_gap_or_missing_box_cannot_be_bridged(self):
        poses, accepted, reader = self.data()
        self.assertFalse(recover_points("fake", poses, accepted, [box()]*5, ["nose"], 2, frames=reader)[1].any())
        boxes = [box()]*5
        boxes[2] = box(False)
        self.assertFalse(recover_points("fake", poses, accepted, boxes, ["nose"], 16, frames=reader)[1].any())

    def test_out_of_order_and_truncated_frames_fail_explicitly(self):
        poses, accepted, reader = self.data()
        for damaged in [reader(False)[:-1], reader(False)[1:]]:
            with self.assertRaisesRegex(RuntimeError, "quadros|Quadros"):
                recover_points("fake", poses, accepted, [box()]*5, ["nose"], 16, frames=lambda _: damaged)

    def test_reverse_decoder_keeps_correct_indices_across_block_boundaries(self):
        captures = []
        class Capture:
            def __init__(self, _):
                self.index = 0
                self.released = False
                captures.append(self)
            def isOpened(self): return True
            def get(self, _): return self.index
            def set(self, _, value):
                self.index = value
                return True
            def read(self):
                self.index += 1
                return (True, np.full((3, 3, 3), self.index-1, np.uint8)) if self.index <= 100 else (False, None)
            def release(self): self.released = True
        frames = list(gray_frames("fake", 100, True, capture_factory=Capture))
        self.assertEqual([i for i, _ in frames], list(range(99, -1, -1)))
        self.assertEqual([int(gray[0, 0]) for _, gray in frames], list(range(99, -1, -1)))
        self.assertTrue(captures[0].released)


if __name__ == "__main__":
    unittest.main()
