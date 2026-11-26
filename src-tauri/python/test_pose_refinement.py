import unittest

import cv2
import numpy as np

from hybrid.pose_refinement import consensus, crop_views, inverse_rotation, refine_video, validate_sequence
from hybrid.detector_wistar import select_detection


def detection(**kwargs):
    return {"observed": True, "x": 0, "y": 0, "w": 100, "h": 100, **kwargs}


class Capture:
    def __init__(self, frames):
        self.frames = list(frames)
        self.released = False

    def isOpened(self):
        return True

    def get(self, _):
        return 100

    def read(self):
        return (True, self.frames.pop(0)) if self.frames else (False, None)

    def release(self):
        self.released = True


class PoseRefinementTests(unittest.TestCase):
    def test_conflicting_clusters_are_not_averaged(self):
        point, votes = consensus([(10, 10, .9), (11, 10, .8), (80, 80, .9), (81, 80, .8)], 5)
        self.assertIsNone(point)
        self.assertEqual(votes, 0)

    def test_consensus_requires_two_views_and_keeps_conservative_score(self):
        self.assertIsNone(consensus([(10, 10, .99), (10, 10, .4)], 5)[0])
        point, votes = consensus([(10, 10, .99), (12, 10, .7), (80, 80, .95)], 5)
        np.testing.assert_allclose(point, [11, 10, .7])
        self.assertEqual(votes, 2)

    def test_rotation_matches_actual_pixels_without_swapping_joints(self):
        image = np.zeros((11, 11), np.uint8)
        image[3, 7] = 255
        for turns in range(4):
            row, col = np.argwhere(np.rot90(image, turns) == 255)[0]
            restored = inverse_rotation([[col, row, .9]], turns, 11, (20, 30))
            np.testing.assert_allclose(restored, [[27, 33, .9]])

    def test_invalid_crop_coordinates_cannot_become_valid_after_rotation(self):
        for turns in range(4):
            restored = inverse_rotation([[-1, -1, .9], [11, 0, .9], [0, float("nan"), .9]], turns, 11, (20, 30))
            self.assertTrue(np.isnan(restored[:, :2]).all())

    def test_border_crop_uses_padding_and_preserves_rgb(self):
        image = np.zeros((100, 100, 3), np.uint8)
        image[0, 0] = [255, 0, 0]
        views, side, (left, top) = crop_views(image, detection(w=20, h=10))
        self.assertLess(top, 0)
        self.assertEqual(len(views), 4)
        point = np.array([[0-left, 0-top, .9]])
        # First view is exactly numpy.rot90 of the original RGB crop.
        np.testing.assert_array_equal(views[0][side-1-int(point[0, 0]), int(point[0, 1])], [255, 0, 0])

    def test_temporal_spike_rejected_but_continuous_motion_retained(self):
        poses = np.array([[[10, 10, .9]], [[80, 10, .9]], [[12, 10, .9]]])
        accepted, reasons = validate_sequence(poses, [detection()] * 3, ["nose"], 100, 100)
        self.assertEqual(accepted[:, 0].tolist(), [True, False, True])
        self.assertEqual(reasons[1, 0], "temporal_spike")
        poses[:, 0, 0] = [10, 45, 80]
        self.assertTrue(validate_sequence(poses, [detection()] * 3, ["nose"], 100, 100)[0].all())

    def test_collapse_outside_box_and_missing_detection_are_not_observations(self):
        keys = ["nose", "mouse_center", "neck", "tail_base"]
        accepted, reasons = validate_sequence(np.tile([50, 50, .99], (1, 4, 1)), [detection()], keys, 100, 100)
        self.assertFalse(accepted.any())
        self.assertTrue((reasons == "collapsed_pose").all())
        for box in [detection(observed=False), detection(x=0, y=0, w=10, h=10)]:
            self.assertFalse(validate_sequence(np.array([[[50, 50, .99]]]), [box], ["nose"], 100, 100)[0].any())

    def run_refinement(self, raw, boxes, infer, frames=None):
        capture = Capture([np.zeros((100, 100, 3), np.uint8)] * len(raw) if frames is None else frames)
        result = refine_video("fake", raw, boxes, ["mouse_center"], infer, capture_factory=lambda _: capture)
        self.assertTrue(capture.released)
        return result

    def test_weak_pose_recovered_only_from_agreeing_same_frame_views(self):
        raw = np.array([[[50, 50, .2]]])
        untouched = raw.copy()
        def infer(items):
            self.assertEqual(len(items), 4)
            predictions = []
            for (image, context), turns in zip(items, [1, 2, 3, 0]):
                side = image.shape[0]
                np.testing.assert_allclose(context["bboxes"], [[0, 0, side, side]])
                marker = np.zeros((side, side), np.uint8)
                crop_origin = int(np.floor(50 - side / 2))
                marker[50-crop_origin, 50-crop_origin] = 1
                y, x = np.argwhere(np.rot90(marker, turns))[0]
                predictions.append({"bodyparts": np.array([[[x, y, .8]]])})
            return predictions
        selected, accepted, _, votes, sources, policy = self.run_refinement(raw, [detection()], infer)
        np.testing.assert_allclose(selected, [[[50, 50, .8]]])
        np.testing.assert_array_equal(raw, untouched)
        self.assertTrue(accepted[0, 0])
        self.assertEqual(votes[0, 0], 4)
        self.assertEqual(sources[0, 0], "view_consensus")
        self.assertEqual(policy["framesRechecked"], 1)
        self.assertEqual(policy["framesContextRechecked"], 0)

    def test_context_recovers_only_from_real_pixels_and_restores_each_crop_origin(self):
        frame = np.zeros((100, 100, 3), np.uint8)
        frame[30, 40] = [0, 0, 255]  # BGR input becomes a red pixel for the runner.
        raw = np.array([[[40, 30, .2]]])
        calls = []
        def infer(items):
            calls.append(len(items))
            self.assertLessEqual(len(items), 4)
            if len(calls) == 1:
                return [{"bodyparts": [[[-1, -1, 0]]]}]*4
            result = []
            for image, _ in items:
                red = image[:, :, 0].astype(np.int16)-image[:, :, 1].astype(np.int16)
                y, x = np.unravel_index(red.argmax(), red.shape)
                self.assertGreater(red[y, x], 0)
                result.append({"bodyparts": [[[x, y, .8]]]})
            return result
        selected, accepted, _, votes, sources, policy = self.run_refinement(raw, [detection()], infer, frames=[frame])
        self.assertEqual(calls, [4, 4])
        np.testing.assert_allclose(selected, [[[40, 30, .8]]])
        np.testing.assert_allclose(raw, [[[40, 30, .2]]])
        self.assertTrue(accepted[0, 0])
        self.assertEqual(votes[0, 0], 4)
        self.assertEqual(sources[0, 0], "view_consensus")
        self.assertEqual(policy["framesContextRechecked"], 1)

    def test_partial_context_response_fails_without_shifting_predictions(self):
        capture = Capture([np.zeros((100, 100, 3), np.uint8)])
        calls = []
        def infer(items):
            calls.append(len(items))
            return [{"bodyparts": [[[-1, -1, 0]]]}]*(4 if len(calls) == 1 else 3)
        with self.assertRaisesRegex(RuntimeError, "vistas de contexto"):
            refine_video("fake", np.array([[[40, 30, .2]]]), [detection()], ["nose"], infer,
                         capture_factory=lambda _: capture)
        self.assertTrue(capture.released)

    def test_disagreement_does_not_increase_coverage_or_invent_a_point(self):
        raw = np.array([[[50, 50, .2]]])
        def infer(items):
            return [{"bodyparts": np.array([[[-1, -1, .99]]])}] * 4
        selected, accepted, reasons, *_ = self.run_refinement(raw, [detection()], infer)
        np.testing.assert_allclose(selected, raw)
        self.assertFalse(accepted.any())
        self.assertEqual(reasons[0, 0], "view_disagreement")

    def test_missing_detections_do_not_trigger_inference(self):
        def unexpected(_):
            self.fail("A pose não precisava de nova inferência")
        raw = np.array([[[50, 50, .9]]])
        result = self.run_refinement(raw, [detection(observed=False)], unexpected)
        self.assertEqual(result[1][:, 0].tolist(), [False])

    def test_high_confidence_alone_cannot_override_view_disagreement(self):
        raw = np.array([[[50, 50, .99]]])
        result = self.run_refinement(raw, [detection()], lambda _: [{"bodyparts": [[[-1, -1, .9]]]}] * 4)
        self.assertFalse(result[1].any())
        self.assertEqual(result[-1]["framesRechecked"], 1)

    def test_incomplete_video_cannot_silently_shift_frames(self):
        capture = Capture([])
        with self.assertRaisesRegex(RuntimeError, "quadro 0"):
            refine_video("fake", np.array([[[50, 50, .9]]]), [detection()], ["nose"], None,
                         capture_factory=lambda _: capture)
        self.assertTrue(capture.released)


class DetectorPrecisionTests(unittest.TestCase):
    def box(self, score=.9, x=10, y=10, w=20, h=20):
        return {"score": score, "x1": x, "y1": y, "x2": x+w, "y2": y+h}

    def test_ambiguous_separate_animals_remain_unconfirmed(self):
        result = select_detection([self.box(x=10), self.box(x=70)], 100, 100, precision=True)
        self.assertFalse(result["observed"])
        self.assertIn("detector_ambiguous", result["qualityFlags"])

    def test_overlapping_duplicate_detections_are_not_ambiguous(self):
        self.assertTrue(select_detection([self.box(), self.box(x=11)], 100, 100, precision=True)["observed"])

    def test_reacquisition_needs_stronger_evidence_than_continuation(self):
        box = [self.box(score=.5)]
        self.assertFalse(select_detection(box, 100, 100, precision=True)["observed"])
        self.assertTrue(select_detection(box, 100, 100, precision=True, previous_box=(10, 10, 30, 30))["observed"])
        self.assertFalse(select_detection(box, 100, 100, precision=True, previous_box=(10, 10, 30, 30), frame_gap=17)["observed"])

    def test_numeric_outliers_are_rejected_and_partial_boxes_clipped(self):
        for box in [self.box(score=1.2), self.box(x=float("nan")), self.box(x=101)]:
            self.assertFalse(select_detection([box], 100, 100, precision=True)["observed"])
        result = select_detection([self.box(x=-10)], 100, 100, precision=True)
        self.assertEqual(result["bboxRaw"]["x"], 0)
        self.assertEqual(result["bboxRaw"]["width"], 10)

    def test_sudden_nonoverlapping_size_change_is_rejected(self):
        result = select_detection([self.box(x=45, y=45, w=5, h=5)], 200, 200,
                                  previous_box=(10, 10, 30, 30), precision=True)
        self.assertFalse(result["observed"])
        self.assertEqual(result["audit"]["rejected"]["shape"], 1)


if __name__ == "__main__":
    unittest.main()
