import unittest

import numpy as np

from hybrid.temporal_estimates import apply_estimates


class TemporalEstimatesTests(unittest.TestCase):
    def data(self):
        poses = np.full((5, 1, 3), -1.)
        poses[0, 0] = [40, 40, .8]
        accepted = np.array([[True], [False], [False], [False], [False]])
        tracks = np.array([[[40+i*2, 40+i]] for i in range(5)], float)
        boxes = [{"observed": True, "x": 10, "y": 10, "w": 80, "h": 80} for _ in range(5)]
        return poses, accepted, boxes, tracks

    def run_estimates(self, poses, accepted, boxes, tracks, visible=None):
        return apply_estimates(poses, accepted, boxes, ["mouse_center"], tracks,
                               np.ones((5, 1), bool) if visible is None else visible,
                               ["mouse_center"], [0], [[40, 40, .8]], 100, 100)

    def test_image_trajectories_fill_only_missing_points_and_preserve_input(self):
        poses, accepted, boxes, tracks = self.data()
        raw = poses.copy()
        selected, recovered, policy = self.run_estimates(poses, accepted, boxes, tracks)
        self.assertEqual(recovered[:, 0].tolist(), [False, True, True, True, True])
        np.testing.assert_allclose(selected[:, 0, :2], tracks[:, 0])
        np.testing.assert_array_equal(poses, raw)
        np.testing.assert_array_equal(selected[accepted], poses[accepted])
        self.assertFalse(policy["metricEligible"])

    def test_invisible_or_outside_or_missing_box_cannot_become_an_estimate(self):
        poses, accepted, boxes, tracks = self.data()
        visible = np.ones((5, 1), bool)
        visible[1] = False
        tracks[3, 0] = [200, 200]
        boxes[4] = {**boxes[4], "observed": False}
        self.assertFalse(self.run_estimates(poses, accepted, boxes, tracks, visible)[1].any())

    def test_large_jumps_and_mismatched_seeds_are_rejected(self):
        poses, accepted, boxes, tracks = self.data()
        tracks[1:, 0] = [89, 89]
        result = self.run_estimates(poses, accepted, boxes, tracks)
        self.assertFalse(result[1][1:].any())
        tracks[0, 0] = [20, 20]
        self.assertFalse(self.run_estimates(poses, accepted, boxes, tracks)[1].any())

    def test_discontinuous_tracker_requires_a_fresh_agreeing_neural_observation(self):
        poses, accepted, boxes, tracks = self.data()
        tracks[1:, 0] = [89, 89]
        poses[3, 0] = [89, 89, .85]
        accepted[3, 0] = True
        _, recovered, _ = self.run_estimates(poses, accepted, boxes, tracks)
        self.assertEqual(recovered[:, 0].tolist(), [False, False, False, False, True])

    def test_conflicting_neural_point_becomes_reviewable_estimate_without_altering_raw(self):
        poses, accepted, boxes, tracks = self.data()
        poses[2, 0] = [80, 80, .99]
        accepted[2, 0] = True
        poses[3, 0] = [46.2, 43.2, .95]
        accepted[3, 0] = True
        raw = poses.copy()
        selected, recovered, policy = self.run_estimates(poses, accepted, boxes, tracks)
        self.assertTrue(recovered[2, 0])
        np.testing.assert_allclose(selected[2, 0], [44, 42, .8])
        np.testing.assert_array_equal(poses, raw)
        self.assertFalse(recovered[3, 0])
        np.testing.assert_array_equal(selected[3, 0], poses[3, 0])
        self.assertEqual(policy["replacedNeuralPointCount"], 1)

    def test_transition_is_bounded_against_the_selected_measurement_not_only_internal_tracks(self):
        poses, accepted, boxes, tracks = self.data()
        poses[1, 0] = [54, 40, .9]
        accepted[1, 0] = True
        tracks[:, 0] = [[40, 40], [42, 40], [12, 40], [12, 40], [12, 40]]
        _, recovered, _ = self.run_estimates(poses, accepted, boxes, tracks)
        self.assertFalse(recovered.any())

    def test_future_anchors_never_backdate_predictions(self):
        poses, accepted, boxes, tracks = self.data()
        result = apply_estimates(poses, accepted, boxes, ["mouse_center"], tracks,np.ones((5,1),bool),
                                 ["mouse_center"], [3], [[46, 43, .8]], 100, 100)
        self.assertFalse(result[1][:3].any())
        with self.assertRaises(ValueError):
            apply_estimates(poses,accepted,boxes,["mouse_center"],tracks,np.ones((5,1),bool),
                            ["mouse_center"],[-1],[[40,40,.8]],100,100)


if __name__ == "__main__":
    unittest.main()
