import unittest

from arena import prepare_geometry, restore_point, spatial_region, torso_center


def quad(left, top, right, bottom):
    return [{"x": left, "y": top}, {"x": right, "y": top},
            {"x": right, "y": bottom}, {"x": left, "y": bottom}]


class ArenaTests(unittest.TestCase):
    def setUp(self):
        self.arena = {"revision": 2, "cornersPx": quad(200, 300, 700, 800),
                      "rimCornersPx": quad(150, 100, 750, 650)}
        self.geometry = prepare_geometry(self.arena, 1000, 1000)

    def test_roi_contains_floor_and_rim_with_margin_even_when_not_nested(self):
        self.assertEqual(self.geometry["cropping"], [120, 780, 65, 835])
        self.assertEqual(self.geometry["postureClassification"], "not_performed")

    def test_legacy_floor_does_not_crop_away_walls(self):
        del self.arena["rimCornersPx"]
        geometry = prepare_geometry(self.arena, 1000, 1000)
        self.assertIsNone(geometry["cropping"])
        self.assertEqual(spatial_region(100, 100, geometry), "unknown")
        self.assertIsNone(prepare_geometry(None, 1000, 1000)["cropping"])

    def test_margin_is_clamped_to_video_bounds(self):
        self.arena["rimCornersPx"] = quad(0, 0, 1000, 1000)
        self.assertEqual(prepare_geometry(self.arena, 1000, 1000)["cropping"], [0, 1000, 0, 1000])

    def test_video_must_match_the_calibrated_resolution(self):
        self.arena.update(videoWidth=1000, videoHeight=1000)
        with self.assertRaisesRegex(ValueError, "resolução"):
            prepare_geometry(self.arena, 1920, 1080)

    def test_refuses_invalid_geometry_instead_of_running_with_wrong_coordinates(self):
        for points in [quad(-1, 0, 100, 100), quad(0, 0, 1001, 100), quad(1, 1, 2, 2),
                       [{"x": 0, "y": 0}, {"x": 100, "y": 100}, {"x": 0, "y": 100}, {"x": 100, "y": 0}]]:
            with self.subTest(points=points), self.assertRaises(ValueError):
                prepare_geometry(dict(self.arena, rimCornersPx=points), 1000, 1000)

    def test_restores_crop_offset_exactly_once(self):
        self.assertEqual(restore_point(280, 335, .9, self.geometry), (400, 400, .9, "valid"))

    def test_missing_sentinels_never_become_real_points_after_offset(self):
        self.assertEqual(restore_point(-1, -1, -1, self.geometry), (None, None, 0.0, "missing"))
        self.assertEqual(restore_point(-1, 200, .9, self.geometry), (None, None, .9, "missing"))
        for value in [float("nan"), float("inf"), None]:
            self.assertEqual(restore_point(value, 10, .9, self.geometry)[3], "missing")

    def test_wall_projection_is_retained_without_being_a_posture_label(self):
        point = restore_point(80, 85, .95, self.geometry)
        self.assertEqual(point[3], "valid")
        self.assertEqual(spatial_region(point[0], point[1], self.geometry), "wall_projection")
        self.assertEqual(spatial_region(400, 400, self.geometry), "floor")
        self.assertEqual(spatial_region(20, 20, self.geometry), "outside")
        self.assertEqual(spatial_region(None, None, self.geometry), "unknown")

    def test_partial_torso_preserves_visible_points_without_filling_occluded_ones(self):
        missing = (None, None, 0, "missing")
        visible = (400, 500, .9, "valid")
        self.assertEqual(torso_center([missing, visible]), (400, 500, .9, "low_confidence"))
        self.assertEqual(torso_center([missing, missing]), (None, None, 0.0, "missing"))

    def test_complete_torso_is_an_explicit_average_not_a_probability_of_correctness(self):
        self.assertEqual(torso_center([(400, 500, .8, "valid"), (420, 540, 1.0, "valid")]),
                         (410, 520, .9, "valid"))


if __name__ == "__main__":
    unittest.main()
