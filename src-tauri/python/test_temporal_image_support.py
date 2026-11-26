import unittest

import cv2
import numpy as np

from hybrid.temporal_image_support import flow_support


class TemporalImageSupportTests(unittest.TestCase):
    def data(self):
        base = np.random.default_rng(17).integers(0, 256, (128, 128), dtype=np.uint8)
        images = [cv2.warpAffine(base, np.float32([[1, 0, 2*f], [0, 1, 0]]), (128, 128)) for f in range(6)]
        tracks = np.array([[[45+f*2, 70]] for f in range(6)], float)
        visible = np.array([[True], [False], [False], [False], [False], [False]])
        return images, tracks, visible

    def test_uncertain_neural_candidates_require_agreement_with_real_image_motion(self):
        images, tracks, visible = self.data()
        support = flow_support(images, tracks, visible, [[0, 45, 70]])
        self.assertEqual(support[:, 0].tolist(), [False, True, True, True, True, True])

    def test_untextured_images_cannot_support_a_hidden_point(self):
        images, tracks, visible = self.data()
        images = [np.zeros_like(image) for image in images]
        self.assertFalse(flow_support(images, tracks, visible, [[0, 45, 70]])[1:].any())

    def test_plausible_smooth_coordinates_without_matching_image_motion_are_rejected(self):
        images, tracks, visible = self.data()
        tracks[2:, 0, 0] += 12
        support = flow_support(images, tracks, visible, [[0, 45, 70]])
        self.assertTrue(support[1, 0])
        self.assertFalse(support[2:].any())

    def test_queries_cannot_backdate_evidence_or_use_mismatched_seeds(self):
        images, tracks, visible = self.data()
        support = flow_support(images, tracks, visible, [[2, 49, 70]])
        self.assertFalse(support[:2].any())
        self.assertTrue(support[2:].all())
        self.assertFalse(flow_support(images, tracks, np.zeros_like(visible), [[0, 60, 70]]).any())

    def test_candidates_outside_images_or_with_invalid_alignment_are_rejected(self):
        images, tracks, visible = self.data()
        tracks[2:, 0] = [300, 300]
        self.assertFalse(flow_support(images, tracks, visible, [[0, 45, 70]])[2:].any())
        with self.assertRaises(ValueError):
            flow_support(images[:-1], tracks, visible, [[0, 45, 70]])
        with self.assertRaises(ValueError):
            flow_support(images, tracks, visible, [[.5, 45, 70]])


if __name__ == "__main__":
    unittest.main()
