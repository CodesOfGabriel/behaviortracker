import unittest
import cv2
import numpy as np
from opencv_engine import Segmenter
from ram_color import RamColorSegmenter


def config(**overrides):
    return dict(width=320, height=240, maxWidth=320, mode='light', threshold=80,
        minAreaFraction=.0001, maxAreaFraction=.2, useOpenCL=False,
        walkablePolygonPx=[dict(x=20,y=20),dict(x=300,y=20),dict(x=300,y=220),dict(x=20,y=220)],
        arena={'cornersPx':[dict(x=20,y=20),dict(x=300,y=20),dict(x=300,y=220),dict(x=20,y=220)]}, **overrides)


def frame(x=100, second=None, color=(90,140,180)):
    image=np.zeros((240,320,3),np.uint8)
    if x is not None: cv2.ellipse(image,(x,100),(16,10),20,0,360,color,-1)
    if second: cv2.ellipse(image,(second,100),(16,10),20,0,360,color,-1)
    return image


class RamColorTests(unittest.TestCase):
    def tracker(self, **options):
        c=config(**options)
        return RamColorSegmenter(c, Segmenter(c))

    def test_body_observation_is_not_anatomical_pose_or_full_animal(self):
        tracker=self.tracker()
        result=tracker.process(frame(),0)
        self.assertEqual(result['observationState'],'observed')
        self.assertIsNone(result['pose'])
        self.assertIsNone(result['fullAnimalBbox'])
        self.assertEqual(result['bodyBbox'],result['bbox'])
        self.assertAlmostEqual(result['xPx'],100,delta=2)

    def test_missing_and_large_jump_never_become_observations(self):
        tracker=self.tracker()
        tracker.process(frame(),0)
        missing=tracker.process(frame(None),.04)
        self.assertEqual(missing['observationState'],'missing')
        self.assertIsNone(missing['xPx'])
        jumped=tracker.process(frame(240),.08)
        self.assertEqual(jumped['observationState'],'uncertain')
        self.assertEqual(jumped['reason'],'temporal_discontinuity')
        self.assertIsNone(jumped['prediction'])

    def test_similar_candidates_require_review(self):
        result=self.tracker().process(frame(100,200),0)
        self.assertEqual(result['reason'],'ambiguous_candidates')
        self.assertEqual(result['observationState'],'uncertain')

    def test_spatial_mask_is_exact_after_morphology(self):
        tracker=self.tracker()
        tracker.process(frame(20),0)
        self.assertEqual(np.count_nonzero(tracker.foreground[tracker.spatial.roi==0]),0)
        self.assertEqual(self.tracker().process(frame(5),0)['observationState'],'missing')

    def test_session_thresholds_do_not_change_other_sessions(self):
        self.assertEqual(self.tracker(ramColor={'valueMin':254}).process(frame(),0)['observationState'],'missing')
        self.assertEqual(self.tracker().process(frame(),0)['observationState'],'observed')

    def test_reacquisition_remains_uncertain_then_checks_continuity(self):
        tracker=self.tracker()
        tracker.process(frame(),0)
        self.assertEqual(tracker.process(frame(200),1)['observationState'],'uncertain')
        self.assertEqual(tracker.process(frame(200),1.04)['observationState'],'observed')
