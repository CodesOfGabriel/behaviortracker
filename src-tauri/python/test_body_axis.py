import copy
import math
import unittest

from body_axis import BodyAxisFilter, angle_delta, appearance_contour, inside, measure


def ellipse(angle=0, frame=0, scale=1, offset=0):
    c, s = math.cos(angle), math.sin(angle)
    contour = [{"x": 80+offset+scale*(35*math.cos(t)*c-10*math.sin(t)*s),
                "y": 80+scale*(35*math.cos(t)*s+10*math.sin(t)*c)}
               for t in [i*math.tau/64 for i in range(64)]]
    return dict(frameIndex=frame, timestampSec=frame*.04, source="segmented", status="valid",
                bbox=dict(x=40, y=40, width=80, height=80), contour=contour)


class BodyAxisTests(unittest.TestCase):
    def test_round_body_has_no_invented_direction(self):
        circle = [{"x": 50+20*math.cos(t), "y": 50+20*math.sin(t)}
                  for t in [i*math.tau/64 for i in range(64)]]
        self.assertEqual(measure(circle)["reason"], "ambiguous_orientation")
        self.assertEqual(measure(circle)["points"], [])

    def test_thin_vertical_appendage_does_not_rotate_horizontal_body(self):
        contour = [dict(x=x, y=y) for x, y in [(10, 60), (45, 60), (46, 0), (49, 0),
                    (50, 60), (90, 60), (90, 85), (10, 85)]]
        result = measure(contour)
        self.assertEqual(len(result["points"]), 7)
        self.assertLess(abs(angle_delta(result["angleRad"], 0)), math.radians(5))
        self.assertTrue(all(p["y"] > 60 for p in result["points"]))

    def test_isolated_perpendicular_axis_is_hidden_and_real_turn_is_confirmed(self):
        filt = BodyAxisFilter()
        for i in range(5):
            self.assertEqual(filt.update(ellipse(frame=i))["state"], "reliable")
        outlier = filt.update(ellipse(math.pi/2, 5))
        self.assertEqual((outlier["reason"], outlier["points"]), ("orientation_outlier", []))
        self.assertEqual(filt.update(ellipse(frame=6))["state"], "reliable")
        for i in (7, 8):
            self.assertEqual(filt.update(ellipse(math.pi/2, i))["points"], [])
        confirmed = filt.update(ellipse(math.pi/2, 9))
        self.assertEqual(confirmed["reason"], "change_confirmed")
        self.assertLess(abs(angle_delta(confirmed["angleRad"], math.pi/2)), .01)

    def test_wrap_is_undirected_and_smoothing_stays_in_current_silhouette(self):
        filt = BodyAxisFilter()
        for i, degrees in enumerate((80, 85, 89, 93, 100, 110, 120)):
            row = ellipse(math.radians(degrees), i)
            result = filt.update(row)
            self.assertEqual(result["state"], "reliable")
            self.assertLessEqual(abs(angle_delta(result["angleRad"], result["rawAngleRad"])), math.radians(8)+1e-6)
            for a, b in zip(result["points"], result["points"][1:]):
                for j in range(33):
                    self.assertTrue(inside((a["x"]+(b["x"]-a["x"])*j/32,
                                            a["y"]+(b["y"]-a["y"])*j/32), row["contour"]))

    def test_size_and_position_spikes_are_hidden_without_altering_tracking(self):
        for change, reason in ((dict(scale=2), "area_outlier"), (dict(offset=100), "position_outlier")):
            filt = BodyAxisFilter()
            for i in range(5):
                filt.update(ellipse(frame=i))
            row = ellipse(frame=5, **change)
            original = copy.deepcopy(row)
            self.assertEqual(filt.update(row)["reason"], reason)
            self.assertEqual(row, original)
            self.assertEqual(filt.update(ellipse(frame=6))["state"], "reliable")

    def test_gaps_and_uncertain_observations_reset_without_drawing_predictions(self):
        filt = BodyAxisFilter()
        filt.update(ellipse(frame=0))
        self.assertEqual(filt.update(ellipse(math.pi/2, 10))["state"], "reliable")
        for change in (dict(source="predicted"), dict(source="recovered"), dict(status="missing"),
                       dict(reason="silhouette_clipped"), dict(localQuality={"reasons": ["camera_shift"]})):
            row = {**ellipse(frame=11), **change}
            self.assertEqual(filt.update(row)["points"], [])

    def test_current_pixels_remove_a_sideways_ghost_for_light_and_dark_animals(self):
        import cv2 as cv
        import numpy as np
        for background_light, body_light in ((25, 200), (220, 35)):
            lab = np.full((100, 110, 3), [background_light, 128, 128], np.uint8)
            body = np.zeros(lab.shape[:2], np.uint8)
            cv.ellipse(body, (35, 50), (12, 35), 0, 0, 360, 255, -1)
            lab[body > 0] = [body_light, 128, 128]
            # An old foreground region is connected to the actual body. There
            # is no animal in that region in the current image.
            component = body.copy()
            cv.rectangle(component, (30, 40), (100, 65), 255, -1)
            contour, evidence = appearance_contour(lab, component, np.array([body_light,128,128]),
                                                   0, [0,0], 1, (0,0))
            self.assertTrue(evidence["supported"])
            result = measure(contour)
            self.assertEqual(len(result["points"]), 7)
            self.assertLess(abs(angle_delta(result["angleRad"], math.pi/2)), math.radians(3))
            self.assertTrue(all(body[round(p["y"]),round(p["x"])] for p in result["points"]))

    def test_a_branched_body_cannot_become_a_confident_perpendicular_axis(self):
        contour = [dict(x=x,y=y) for x,y in [(10,10),(35,10),(35,40),(80,40),
                   (80,65),(35,65),(35,90),(10,90)]]
        self.assertIn(measure(contour)["reason"], {"concave_body", "fragmented_body"})


if __name__ == "__main__":
    unittest.main()
