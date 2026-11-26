import unittest
from unittest.mock import patch

import cv2
import numpy as np

from hybrid.temporal_runtime import frame_windows, image_frames, recover_sequence


class TemporalRuntimeTests(unittest.TestCase):
    def data(self, count):
        poses = np.full((count, 1, 3), np.nan)
        accepted = np.zeros((count, 1), bool)
        boxes = [{"observed": True, "x": 0, "y": 0, "w": 200, "h": 200} for _ in range(count)]
        return poses, accepted, boxes

    def run_sequence(self, poses, accepted, boxes, infer=None):
        def trajectory(frames, queries):
            # Synthetic image content encodes the true frame index. Tracking is
            # evaluated in both directions; the orchestration is production code.
            return np.array([[[40+frame*.1, 40] for _ in queries] for frame in frames]), np.ones((len(frames), len(queries)), bool)
        return recover_sequence(poses, accepted, boxes, ["mouse_center"], 200, 200,
            lambda reverse: iter(range(len(poses)-1, -1, -1) if reverse else range(len(poses))), infer or trajectory)

    def test_short_and_partial_windows_cover_every_frame_with_bounded_input(self):
        for count in (0, 1, 7, 8, 9, 16, 17, 63, 64, 65, 80, 112, 113, 260):
            with self.subTest(count=count):
                covered = set()
                for start, frames in frame_windows(iter(range(count))):
                    self.assertLessEqual(len(frames), 64)
                    self.assertEqual(frames, list(range(start, start+len(frames))))
                    covered.update(frames)
                self.assertEqual(covered, set(range(count)))

    def test_overlap_carries_estimates_without_turning_them_into_new_observations(self):
        poses, accepted, boxes = self.data(161)
        poses[0, 0] = [40, 40, .8]
        accepted[0, 0] = True
        raw = poses.copy()
        selected, recovered, policy, anchors, _support = self.run_sequence(poses, accepted, boxes)
        self.assertTrue(recovered[1:].all())
        self.assertFalse(recovered[0].any())
        np.testing.assert_allclose(selected[:, 0, 0], 40+np.arange(161)*.1)
        self.assertTrue((anchors[recovered] == 0).all())
        np.testing.assert_equal(poses, raw)
        self.assertFalse(policy["metricEligible"])

    def test_reverse_pass_recovers_before_first_neural_anchor(self):
        poses, accepted, boxes = self.data(17)
        poses[10, 0] = [41, 40, .85]
        accepted[10, 0] = True
        selected, recovered, _, anchors, _support = self.run_sequence(poses, accepted, boxes)
        self.assertTrue(recovered[:10].all())
        self.assertTrue(recovered[11:].all())
        self.assertFalse(recovered[10].any())
        self.assertTrue((anchors[recovered] == 10).all())
        np.testing.assert_allclose(selected[:, 0, 0], 40+np.arange(17)*.1)

    def test_overlapping_image_tracks_cannot_introduce_a_jump_at_the_window_boundary(self):
        poses, accepted, boxes = self.data(80)
        poses[0, 0] = [40, 30, .8]
        accepted[0, 0] = True
        boxes = [{**box, "w": 180, "h": 40} for box in boxes]
        def inference(frames, queries):
            # Two individually continuous image trajectories differ within the
            # overlap. Keeping only the old overlap creates an 80.5px seam jump.
            x = np.array(frames, float)*.5+40
            if frames[0] == 48:
                x += 80*np.minimum((np.array(frames)-48)/16, 1)
            return np.stack([x, np.full(len(frames), 30.)], axis=-1)[:, None], np.ones((len(frames), 1), bool)
        selected, recovered, policy, anchors, _support = self.run_sequence(poses, accepted, boxes, inference)
        jumps = np.linalg.norm(np.diff(selected[:, 0, :2], axis=0), axis=1)
        self.assertLessEqual(float(jumps.max()), policy["maxStepFractionOfBoxDiagonal"]*np.hypot(180, 40))
        self.assertTrue(recovered[1:].all())
        self.assertTrue((anchors[recovered] == 0).all())

    def test_missing_anatomical_seeds_do_not_fabricate_box_centres(self):
        poses, accepted, boxes = self.data(80)
        def forbidden(*_): raise AssertionError("No seed exists")
        _, recovered, policy, _, _support = self.run_sequence(poses, accepted, boxes, forbidden)
        self.assertFalse(recovered.any())
        self.assertEqual(policy["inferenceWindowCount"], 0)

    def test_new_agreeing_neural_observation_replaces_an_older_overlap_estimate(self):
        poses, accepted, boxes = self.data(80)
        boxes = [{**box, "w": 180, "h": 40} for box in boxes]
        poses[0, 0], poses[50, 0] = [40, 30, .8], [70, 30, .9]
        accepted[[0, 50], 0] = True
        def inference(frames, queries):
            x = np.array(frames, float)*.1+40
            if frames[0] == 48:
                x += 25*np.minimum((np.array(frames)-48)/2, 1)
            return np.stack([x, np.full(len(frames), 30.)], axis=-1)[:, None], np.ones((len(frames), 1), bool)
        selected, recovered, _, anchors, _support = self.run_sequence(poses, accepted, boxes, inference)
        self.assertFalse(recovered[50, 0])
        np.testing.assert_allclose(selected[50, 0], poses[50, 0])
        self.assertEqual(anchors[50, 0], -1)

    def test_invisibility_in_a_new_window_cannot_promote_a_previously_rejected_neural_point(self):
        poses, accepted, boxes = self.data(80)
        boxes = [{**box, "w": 180, "h": 40} for box in boxes]
        poses[0, 0], poses[50, 0] = [40, 30, .8], [120, 30, .99]
        accepted[[0, 50], 0] = True
        def inference(frames, queries):
            x = np.array(frames, float)*.1+40
            return np.stack([x, np.full(len(frames), 30.)], axis=-1)[:, None], np.full((len(frames), 1), frames[0] != 48, bool)
        selected, recovered, _, anchors, _support = self.run_sequence(poses, accepted, boxes, inference)
        self.assertTrue(recovered[50, 0])
        np.testing.assert_allclose(selected[50, 0], [45, 30, .8])
        self.assertEqual(anchors[50, 0], 0)

    def test_invisible_and_missing_detection_stay_untrusted(self):
        poses, accepted, boxes = self.data(5)
        poses[0, 0] = [40, 40, .8]
        accepted[0, 0] = True
        boxes[2] = {**boxes[2], "observed": False}
        def inference(frames, queries):
            tracks = np.array([[[40+f*.1, 40]] for f in frames])
            visible = np.array([[f != 1] for f in frames])
            return tracks, visible
        self.assertFalse(self.run_sequence(poses, accepted, boxes, inference)[1].any())

    def test_independent_image_support_is_identified_without_becoming_a_neural_measurement(self):
        poses, accepted, boxes = self.data(5)
        poses[0, 0] = [40, 40, .8]
        accepted[0, 0] = True
        def inference(frames, queries):
            tracks = np.array([[[40+f*.1, 40]] for f in frames])
            visible = np.array([[f != 1] for f in frames])
            support = np.array([[f == 1] for f in frames])
            return tracks, visible, support
        _, recovered, policy, _, evidence = self.run_sequence(poses, accepted, boxes, inference)
        self.assertTrue(recovered[1:].all())
        self.assertEqual(evidence[1, 0], "bidirectional_flow")
        self.assertEqual(policy["flowSupportedEstimateCount"], 1)
        self.assertFalse(policy["metricEligible"])

    def test_disagreeing_neural_outlier_is_an_estimate_with_original_anchor_lineage(self):
        poses, accepted, boxes = self.data(65)
        poses[0, 0] = [40, 40, .8]
        poses[50, 0] = [150, 150, .99]
        accepted[[0, 50], 0] = True
        selected, recovered, policy, anchors, _support = self.run_sequence(poses, accepted, boxes)
        self.assertTrue(recovered[50, 0])
        self.assertEqual(anchors[50, 0], 0)
        np.testing.assert_allclose(selected[50, 0], [45, 40, .8])
        self.assertEqual(policy["replacedNeuralPointCount"], 1)

    def test_reverse_cannot_reseed_from_a_neural_point_rejected_by_forward_tracking(self):
        poses, accepted, boxes = self.data(17)
        poses[0, 0] = [40, 40, .8]
        poses[10, 0] = [150, 150, .99]
        accepted[[0, 10], 0] = True
        calls = []
        def inference(frames, queries):
            calls.append(queries.copy())
            return np.array([[[40+f*.1, 40]] for f in frames]), np.ones((len(frames), 1), bool)
        selected, recovered, _, anchors, _support = self.run_sequence(poses, accepted, boxes, inference)
        self.assertEqual(calls[1][0, 0], 16)  # Reverse anchor is real frame zero.
        self.assertFalse(recovered[0, 0])
        self.assertTrue(recovered[10, 0])
        self.assertEqual(anchors[10, 0], 0)

    def test_reverse_cannot_replace_measurements_already_confirmed_by_forward_images(self):
        poses, accepted, boxes = self.data(17)
        for frame in [0, 1, 2]:
            poses[frame, 0] = [40+frame*.1, 40, .8]
        poses[10, 0] = [150, 150, .99]
        accepted[[0, 1, 2, 10], 0] = True
        calls = []
        def inference(frames, queries):
            calls.append(queries.copy())
            if frames[0] == 0:
                tracks = np.array([[[40+f*.1, 40]] for f in frames])
                visible = np.array([[f < 10] for f in frames])
            else:
                # A later anatomical label has flipped to another image feature.
                # That feature still makes a smooth, visible reverse track.
                time, x, y = queries[0]
                source_frame = frames[int(time)]
                tracks = np.array([[[x+(f-source_frame)*.1, y]] for f in frames])
                visible = np.ones((len(frames), 1), bool)
            return tracks, visible
        selected, recovered, _, _, _support = self.run_sequence(poses, accepted, boxes, inference)
        np.testing.assert_allclose(selected[:3], poses[:3])
        self.assertFalse(recovered[:3].any())

    def test_reverse_hypothesis_must_agree_at_the_other_confirmed_end_of_a_gap(self):
        poses, accepted, boxes = self.data(17)
        boxes = [{**box, "w": 180, "h": 40} for box in boxes]
        poses[0, 0], poses[10, 0] = [40, 30, .8], [41, 30, .9]
        accepted[[0, 10], 0] = True
        def inference(frames, queries):
            if frames[0] == 0:
                x = np.array(frames)*.1+40
                visible = np.array([[f == 0 or f >= 10] for f in frames])
            else:
                x = np.array([41+8*(10-f) if f <= 10 else 40+f*.1 for f in frames])
                visible = np.ones((len(frames), 1), bool)
            return np.stack([x, np.full(len(frames), 30.)], axis=-1)[:, None], visible
        selected, recovered, _, _, _ = self.run_sequence(poses, accepted, boxes, inference)
        self.assertFalse(recovered[1:10].any())
        np.testing.assert_allclose(selected[[0, 10]], poses[[0, 10]])

    def test_smooth_image_track_cannot_override_a_majority_of_named_neural_observations(self):
        poses, accepted, boxes = self.data(8)
        boxes = [{**box, "x": 10, "y": 10, "w": 80, "h": 80} for box in boxes]
        for frame in range(5):
            poses[frame, 0] = [40+frame*2, 40, .8]
            accepted[frame, 0] = True
        def inference(frames, queries):
            x = np.array([40 if f == 0 else 70+2*f for f in frames], float)
            return np.stack([x, np.full(len(frames), 40.)], axis=-1)[:, None], np.ones((len(frames), 1), bool)
        selected, recovered, policy, _, _ = self.run_sequence(poses, accepted, boxes, inference)
        np.testing.assert_allclose(selected[:5], poses[:5])
        self.assertFalse(recovered.any())
        self.assertGreaterEqual(policy["rejectedInconsistentTrackCount"], 1)

    def test_reverse_run_must_connect_to_a_named_measurement_outside_its_window(self):
        poses, accepted, boxes = self.data(80)
        boxes = [{**box, "x": 10, "y": 10, "w": 80, "h": 80} for box in boxes]
        poses[0, 0], poses[15, 0], poses[79, 0] = [45, 40, .9], [40, 40, .9], [80, 40, .9]
        accepted[[0, 15, 79], 0] = True
        def inference(frames, queries):
            if frames[0] == 79:
                tracks = np.array([[[80, 40]] for _ in frames], float)
                visible = np.ones((len(frames), 1), bool)
            else:
                tracks = np.array([[[45+f*.1, 40]] for f in frames])
                visible = np.array([[f < 15] for f in frames])
            return tracks, visible
        selected, recovered, policy, _, _ = self.run_sequence(poses, accepted, boxes, inference)
        self.assertFalse(recovered[16:79].any())
        np.testing.assert_allclose(selected[[0, 15, 79]], poses[[0, 15, 79]])
        self.assertGreater(policy["rejectedDisconnectedEstimateCount"], 0)

    def test_truncated_or_excess_frames_cannot_shift_alignment(self):
        poses, accepted, boxes = self.data(17)
        for frames in (range(16), range(18)):
            with self.assertRaises(RuntimeError):
                recover_sequence(poses, accepted, boxes, ["mouse_center"], 200, 200,
                                 lambda _: iter(frames), lambda *_: None)

    def test_reverse_reader_releases_capture_and_transforms_before_buffering(self):
        calls = []
        class Capture:
            def __init__(self, _): self.index = 0
            def isOpened(self): return True
            def set(self, prop, index): self.index = index; return True
            def get(self, _): return self.index
            def read(self):
                self.index += 1
                return True, np.array([self.index-1])
            def release(self): calls.append("released")
        result = list(image_frames("fixture", 101, True, lambda frame: int(frame[0]), Capture))
        self.assertEqual(result, list(range(100, -1, -1)))
        self.assertEqual(calls, ["released"])
        class BadSeek(Capture):
            def get(self, _): return self.index+1
        with self.assertRaises(RuntimeError):
            list(image_frames("fixture", 101, True, lambda frame: frame, BadSeek))
        self.assertEqual(calls, ["released", "released"])


if __name__ == "__main__":
    unittest.main()
