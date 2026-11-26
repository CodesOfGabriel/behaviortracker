"""Known synthetic geometry tests; not independent biological validation."""
import unittest

import cv2
import numpy as np

from opencv_engine import BodyFlow, HybridSegmenter, RobustSegmenter
from test_opencv_engine import config


def settings(**overrides):
    value = config()
    value.update(strategy="classical_roi_v1", mode="background", threshold=25, useOpenCL=False)
    value.update(overrides)
    return value


def frame(x=100, y=110, color=(200, 200, 200), axes=(12, 8), background=40):
    image = np.full((240, 320, 3), background, np.uint8)
    if x is not None:
        cv2.ellipse(image, (x, y), axes, 0, 0, 360, color, -1)
    return image


class PrecisionTests(unittest.TestCase):
    def test_small_floor_fragment_recovers_wall_head_after_tracking_gap(self):
        from test_arena import quad
        background=frame(None)
        background[:80]=170
        cfg=settings(protocol="open_field")
        cfg["arena"]={"cornersPx":quad(40,80,280,220),"rimCornersPx":quad(20,15,300,225)}
        detector=RobustSegmenter(cfg,background)
        before=background.copy()
        cv2.ellipse(before,(160,115),(12,23),0,0,360,(200,)*3,-1)
        detector.process(before,0)
        self.assertTrue(detector.process(before,.04)["trackingAccepted"])
        image=background.copy()
        cv2.ellipse(image,(160,90),(10,9),0,0,360,(200,)*3,-1)
        cv2.rectangle(image,(157,62),(163,90),(185,)*3,-1)
        cv2.ellipse(image,(160,62),(9,15),0,0,360,(185,)*3,-1)
        # The full historical body, rather than its small floor fragment,
        # bounds pixel recovery even when identity needs reacquisition.
        result=detector.process(image,1.)
        self.assertGreater(result["wallExtension"]["addedAreaPx"],250)
        self.assertLess(result["bbox"]["y"],50)
        self.assertNotEqual(result["status"],"valid")
        self.assertNotEqual(result["localQuality"]["geometry"],"floor")

    def test_low_contrast_head_on_wall_is_recovered_without_static_wall_or_thin_tail(self):
        from test_arena import quad
        from body_axis import BodyAxisFilter
        from oft_layers import LayeredTracker
        background=frame(None)
        background[:80]=170
        cfg=settings(protocol="open_field",initialBox=dict(x=140,y=90,width=40,height=60))
        cfg["arena"]={"cornersPx":quad(40,80,280,220),"rimCornersPx":quad(20,15,300,225)}
        image=background.copy()
        cv2.ellipse(image,(160,115),(12,23),0,0,360,(200,)*3,-1)
        cv2.rectangle(image,(157,65),(163,105),(185,)*3,-1)
        cv2.ellipse(image,(160,65),(7,9),0,0,360,(185,)*3,-1)
        cv2.line(image,(160,138),(160,190),(150,)*3,1)
        # Another head-sized object on the wall is disconnected from the body.
        cv2.ellipse(image,(210,55),(8,10),0,0,360,(185,)*3,-1)
        detector=RobustSegmenter(cfg,background)
        result=detector.process(image,0)
        self.assertGreater(result["wallExtension"]["addedAreaPx"],20)
        self.assertLess(result["bbox"]["y"],65)
        self.assertLess(result["bbox"]["x"]+result["bbox"]["width"],190)
        self.assertLess(result["bbox"]["y"]+result["bbox"]["height"],155)
        self.assertEqual(result["status"],"low_confidence")
        self.assertNotEqual(result["localQuality"]["geometry"],"floor")
        row={**result,"frameIndex":0,"timestampSec":0}
        row["bodyAxis"]=BodyAxisFilter().update(row)
        # Wall proximity by itself must not assign an anatomical direction.
        from unittest.mock import patch
        with patch("oft_layers.tail_evidence",return_value=(np.array([160.,138.]),np.array([160.,190.]))):
            orientation=LayeredTracker(320,240,cfg["arena"]).update(image,row)["orientation"]
        self.assertEqual(orientation["state"],"estimated")
        self.assertLess(orientation["head"]["y"],80)
        self.assertEqual(orientation["headRegion"],"wall_projection")
        self.assertFalse(orientation["metricEligible"])

    def test_rearing_body_crosses_floor_and_keeps_tracking_on_visible_wall(self):
        from test_arena import quad
        from body_axis import BodyAxisFilter
        cfg=settings(protocol="open_field")
        cfg["arena"]={"cornersPx":quad(70,80,250,210),"rimCornersPx":quad(30,20,290,225)}
        before=__import__("copy").deepcopy(cfg["arena"])
        detector=HybridSegmenter(cfg,RobustSegmenter(cfg,frame(None)))
        axis=BodyAxisFilter()
        for i,y in enumerate([105,105,90,75,60,55]):
            result=detector.process(frame(140,y,axes=(12,30)),i/20)
            body=axis.update({**result,"frameIndex":i,"timestampSec":i/20})
            if i:
                self.assertTrue(result["trackingAccepted"],result["reason"])
                self.assertAlmostEqual(result["bbox"]["y"],y-30,delta=2)
                self.assertGreaterEqual(result["bbox"]["y"]+result["bbox"]["height"],y+30)
                self.assertEqual(result["status"],"low_confidence")
                self.assertNotEqual(result["localQuality"]["geometry"],"floor")
        self.assertLess(result["floorOverlapFraction"],.15)
        self.assertEqual(body["state"],"reliable")
        self.assertLess(min(p["y"] for p in body["points"]),80)
        self.assertEqual(cfg["arena"],before)

    def test_without_rim_the_metric_floor_does_not_crop_the_wall(self):
        from test_arena import quad
        cfg=settings(protocol="open_field",initialBox=dict(x=120,y=30,width=40,height=65))
        cfg["arena"]={"cornersPx":quad(70,80,250,210)}
        spatial=RobustSegmenter(cfg,frame(None))
        result=spatial.process(frame(140,60,axes=(12,30)),0)
        self.assertTrue(result["trackingAccepted"],result["reason"])
        self.assertLess(result["bbox"]["y"],40)
        self.assertEqual(result["spatialRegion"],"wall_projection")
        self.assertEqual(result["status"],"low_confidence")

    def test_ram_walkability_gates_center_without_clipping_body_to_arm(self):
        polygon = [{"x": 146, "y": 30}, {"x": 174, "y": 30}, {"x": 174, "y": 210}, {"x": 146, "y": 210}]
        cfg = settings(protocol="radial_arm_maze", walkablePolygonPx=polygon, maxAreaFraction=.8)
        spatial = RobustSegmenter(cfg, frame(None))
        detector = HybridSegmenter(cfg, spatial)
        image = frame(160, 120, axes=(20, 30))
        detector.process(image, 0)
        result = detector.process(image, .04)
        self.assertTrue(result["trackingAccepted"])
        self.assertNotIn("silhouette_clipped", result["localQuality"]["reasons"])
        self.assertLess(result["bbox"]["x"], 146)
        self.assertGreater(result["bbox"]["x"]+result["bbox"]["width"], 174)
        self.assertEqual(result["localQuality"]["geometry"], "boundary")
        self.assertEqual(result["status"], "low_confidence")
        self.assertEqual(cfg["walkablePolygonPx"], polygon)
        outside = RobustSegmenter(cfg, frame(None)).process(frame(140, 120, axes=(12, 20)), 0)
        self.assertEqual(outside["status"], "missing")

    def detector(self, **options):
        cfg = settings(**options)
        spatial = RobustSegmenter(cfg, frame(None))
        return HybridSegmenter(cfg, spatial), spatial

    def test_legacy_uncertain_boxes_cannot_initialize_kalman_without_quality_metadata(self):
        class LegacyObservation:
            def process(self, image, timestamp, guide_box=None):
                return {"source": "segmented", "status": "low_confidence", "reason": "area_changed",
                        "xPx": 100, "yPx": 110, "bbox": {"x": 90, "y": 100, "width": 20, "height": 20}}
        detector = HybridSegmenter(settings(), LegacyObservation())
        for timestamp in [0, .04, .08]:
            result = detector.process(frame(), timestamp)
            self.assertFalse(result["kalmanUpdated"])
        self.assertIsNone(detector.kalman.last_observed)

    def test_identity_bootstrap_requires_consecutive_visual_evidence(self):
        detector, spatial = self.detector()
        first = detector.process(frame(), 0)
        self.assertEqual(first["localQuality"]["identity"], "unverified")
        self.assertFalse(first["trackingAccepted"])
        self.assertIsNone(detector.kalman.last_observed)
        self.assertIsNone(spatial.appearance)
        second = detector.process(frame(102), .04)
        self.assertTrue(second["trackingAccepted"])
        self.assertTrue(second["kalmanUpdated"])
        self.assertEqual(second["status"], "valid")

    def test_floor_boundary_is_tracked_but_stays_out_of_floor_metrics(self):
        cfg = settings()
        cfg["arena"] = {"cornersPx": [{"x": 40, "y": 40}, {"x": 280, "y": 40},
                                      {"x": 280, "y": 200}, {"x": 40, "y": 200}],
                        "rimCornersPx": [{"x": 10, "y": 10}, {"x": 310, "y": 10},
                                         {"x": 310, "y": 230}, {"x": 10, "y": 230}]}
        spatial = RobustSegmenter(cfg, frame(None))
        detector = HybridSegmenter(cfg, spatial)
        detector.process(frame(45), 0)
        result = detector.process(frame(45), .04)
        self.assertEqual(result["localQuality"]["tracking"], "observed")
        self.assertEqual(result["localQuality"]["geometry"], "boundary")
        self.assertTrue(result["kalmanUpdated"])
        self.assertEqual(result["status"], "low_confidence")
        self.assertEqual(detector.kalman.last_observed, .04)

    def test_doubtful_measurement_does_not_correct_kalman_or_identity(self):
        detector, spatial = self.detector()
        detector.process(frame(), 0)
        detector.process(frame(), .04)
        appearance = spatial.appearance.copy()
        area, box = spatial.last_area, dict(spatial.last_box)
        for index in range(2, 6):
            result = detector.process(frame(105, color=(30, 180, 60)), index*.04)
            self.assertFalse(result["trackingAccepted"])
            self.assertFalse(result["kalmanUpdated"])
            self.assertIn("appearance_changed", result["localQuality"]["reasons"])
        self.assertEqual(detector.kalman.last_observed, .04)
        self.assertEqual(spatial.tracker.last[2], .04)
        self.assertEqual(spatial.last_area, area)
        self.assertEqual(spatial.last_box, box)
        np.testing.assert_array_equal(spatial.appearance, appearance)

    def test_nonoverlapping_prediction_can_still_match_a_consistent_body(self):
        detector, _ = self.detector()
        detector.process(frame(), 0)
        detector.process(frame(), .04)
        result = detector.process(frame(130), .08)
        self.assertTrue(result["trackingAccepted"])
        self.assertAlmostEqual(result["xPx"], 130, delta=1)
        self.assertTrue(result["kalmanUpdated"])

    def test_global_brightness_change_keeps_fixed_reference_and_body(self):
        cfg = settings()
        background = frame(None, background=80)
        spatial = RobustSegmenter(cfg, background, [background]*5)
        original_background = spatial.background.copy()
        detector = HybridSegmenter(cfg, spatial)
        detector.process(frame(background=80), 0)
        detector.process(frame(background=80), .04)
        image = cv2.add(frame(background=80), np.full_like(background, 30))
        result = detector.process(image, .08)
        self.assertTrue(result["trackingAccepted"])
        self.assertAlmostEqual(result["illuminationShift"], 30, delta=1)
        self.assertAlmostEqual(result["xPx"], 100, delta=1)
        np.testing.assert_array_equal(spatial.background, original_background)

    def test_reacquisition_requires_new_consensus_without_forgetting_appearance(self):
        detector, spatial = self.detector()
        detector.process(frame(), 0)
        detector.process(frame(), .04)
        reference = spatial.appearance.copy()
        detector.process(frame(None), .5)
        first = detector.process(frame(220), .6)
        self.assertFalse(first["trackingAccepted"])
        self.assertIn("reacquisition_pending", first["localQuality"]["reasons"])
        self.assertEqual(detector.kalman.last_observed, .04)
        second = detector.process(frame(220), .64)
        self.assertTrue(second["trackingAccepted"])
        self.assertEqual(detector.kalman.last_observed, .64)
        np.testing.assert_array_equal(spatial.appearance, reference)

    def test_multiple_equal_candidates_cannot_seed_identity(self):
        detector, spatial = self.detector()
        image = frame()
        cv2.ellipse(image, (220, 110), (12, 8), 0, 0, 360, (200,)*3, -1)
        for index in range(5):
            result = detector.process(image, index*.04)
            self.assertIn("ambiguous_candidates", result["localQuality"]["reasons"])
            self.assertFalse(result["trackingAccepted"])
        self.assertIsNone(spatial.appearance)
        self.assertIsNone(detector.kalman.last_observed)

    def test_initial_box_selects_one_candidate_without_promoting_a_wall_measurement(self):
        detector, _ = self.detector(initialBox={"x": 80, "y": 90, "width": 40, "height": 40})
        image = frame()
        cv2.ellipse(image, (220, 110), (12, 8), 0, 0, 360, (200,)*3, -1)
        result = detector.process(image, 0)
        self.assertTrue(result["trackingAccepted"])
        self.assertEqual(result["localQuality"]["identity"], "seeded")
        self.assertAlmostEqual(result["xPx"], 100, delta=1)

    def test_enclosure_clipping_and_area_growth_never_update_trusted_state(self):
        detector, spatial = self.detector()
        detector.process(frame(), 0)
        detector.process(frame(), .04)
        previous = spatial.last_area
        result = detector.process(frame(100, axes=(26, 18)), .08)
        self.assertIn("area_changed", result["localQuality"]["reasons"])
        self.assertFalse(result["kalmanUpdated"])
        self.assertEqual(spatial.last_area, previous)
        clipped, _ = self.detector()
        result = clipped.process(frame(12), 0)
        self.assertIn("silhouette_clipped", result["localQuality"]["reasons"])
        self.assertFalse(result["trackingAccepted"])

    def test_floor_support_prevents_bootstrap_on_a_larger_mirror_candidate(self):
        cfg = settings()
        cfg["arena"] = {"cornersPx": [{"x": 70, "y": 40}, {"x": 280, "y": 40},
                                      {"x": 280, "y": 200}, {"x": 70, "y": 200}],
                        "rimCornersPx": [{"x": 10, "y": 10}, {"x": 310, "y": 10},
                                         {"x": 310, "y": 230}, {"x": 10, "y": 230}]}
        detector = HybridSegmenter(cfg, RobustSegmenter(cfg, frame(None)))
        image = frame(100)
        cv2.ellipse(image, (35, 110), (17, 13), 0, 0, 360, (200,)*3, -1)
        detector.process(image, 0)
        result = detector.process(image, .04)
        self.assertTrue(result["trackingAccepted"])
        self.assertAlmostEqual(result["xPx"], 100, delta=1)
        self.assertGreater(result["floorOverlapFraction"], .95)

    def test_equal_luminance_color_difference_recovers_body(self):
        cfg = settings()
        background = frame(None, background=80)
        spatial = RobustSegmenter(cfg, background, [background]*3)
        detector = HybridSegmenter(cfg, spatial)
        image = frame(color=(160, 80, 50), background=80)
        self.assertLess(abs(int(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)[110, 100])-80), 10)
        detector.process(image, 0)
        result = detector.process(image, .04)
        self.assertTrue(result["trackingAccepted"])
        self.assertAlmostEqual(result["xPx"], 100, delta=1)

    def test_thin_tail_does_not_enlarge_body_box(self):
        detector, _ = self.detector()
        image = frame()
        cv2.line(image, (20, 110), (90, 110), (200,)*3, 1)
        detector.process(image, 0)
        result = detector.process(image, .04)
        self.assertTrue(result["trackingAccepted"])
        self.assertGreater(result["bbox"]["x"], 80)
        self.assertLess(result["bbox"]["width"], 32)

    def test_small_fragment_inside_initial_box_cannot_seed_identity(self):
        detector, spatial = self.detector(initialBox={"x": 70, "y": 70, "width": 90, "height": 90})
        result = detector.process(frame(100, axes=(7, 5)), 0)
        self.assertFalse(result["trackingAccepted"])
        self.assertIsNone(spatial.appearance)

    def test_bidirectional_flow_is_short_lived_guidance_only(self):
        flow = BodyFlow(.25)
        rng = np.random.default_rng(10)
        gray = np.zeros((120, 160), np.uint8)
        gray[40:80, 50:90] = rng.integers(40, 220, (40, 40), dtype=np.uint8)
        mask = np.zeros_like(gray); mask[40:80, 50:90] = 255
        flow.observe(gray, mask, {"x": 50, "y": 40, "width": 40, "height": 40}, 0)
        moved = cv2.warpAffine(gray, np.float32([[1, 0, 6], [0, 1, 3]]), (160, 120))
        estimate = flow.predict(moved, .04)
        self.assertIsNotNone(estimate)
        self.assertAlmostEqual(estimate["x"], 56, delta=.5)
        self.assertAlmostEqual(estimate["y"], 43, delta=.5)
        self.assertIsNone(flow.predict(moved, .3))
        detector, _ = self.detector()
        detector.process(frame(), 0); detector.process(frame(), .04)
        result = detector.process(frame(None), .08)
        self.assertFalse(result["trackingAccepted"])
        self.assertFalse(result["kalmanUpdated"])


if __name__ == "__main__":
    unittest.main()
