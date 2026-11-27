import copy
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
import cv2 as cv
import numpy as np
from oft_continuity import VisualContinuity,curve,initial_direction
from oft_layers import LayeredTracker
from test_oft_layers import animal,observed,video_fixture


class ContinuityTests(unittest.TestCase):
    def test_a_long_current_tail_can_correct_an_aged_direction(self):
        image,box,bg,_=animal();row=observed(image,box,bg)
        tracker=VisualContinuity(320,240)
        forward=dict(state='estimated',source='tail_silhouette',head=dict(x=190,y=120),tailBase=dict(x=130,y=120))
        tracker.update(image,row,forward)
        with patch('oft_continuity.cv.calcOpticalFlowPyrLK',return_value=(None,None,None)):
            for i in range(1,42):tracker.update(image,{**row,'frameIndex':i,'timestampSec':i/20},dict(state='ambiguous'))
            reverse={**forward,'head':forward['tailBase'],'tailBase':forward['head'],'tailTip':dict(x=245,y=120)}
            output=tracker.update(image,{**row,'frameIndex':42,'timestampSec':2.1},reverse)
        self.assertEqual(output['orientationSource'],'current_tail')
        self.assertLess(output['head']['x'],output['tailBase']['x'])

    def test_an_opposite_tail_cannot_swap_identity_during_a_single_flow_failure(self):
        image,box,bg,_=animal();row=observed(image,box,bg)
        tracker=VisualContinuity(320,240)
        forward=dict(state='estimated',source='tail_silhouette',head=dict(x=190,y=120),tailBase=dict(x=130,y=120))
        reverse={**forward,'head':forward['tailBase'],'tailBase':forward['head']}
        tracker.update(image,row,forward)
        with patch('oft_continuity.cv.calcOpticalFlowPyrLK',return_value=(None,None,None)):
            for i in range(1,8):
                output=tracker.update(image,{**row,'frameIndex':i,'timestampSec':i/20},reverse)
                if i<6:self.assertGreater(output['head']['x'],output['tailBase']['x'])
            self.assertLess(output['head']['x'],output['tailBase']['x'])

    def test_initial_unresolved_direction_uses_future_pixels_without_altering_raw_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            video,_,_=video_fixture(Path(temporary),count=3)
            tracker=LayeredTracker(320,240);rows=[]
            for i in range(3):
                image,box,bg,_=animal(center=(100+i*3,120));row=observed(image,box,bg,i)
                if i==0:
                    with patch('oft_layers.tail_evidence',return_value=None):row['oftLayers']=tracker.update(image,row)
                else:row['oftLayers']=tracker.update(image,row)
                rows.append(row)
            self.assertIsNone(rows[0]['oftLayers']['visualization']['head'])
            self.assertEqual(initial_direction(video,rows,(320,240)),1)
            visual=rows[0]['oftLayers']['visualization']
            self.assertIsNone(rows[0]['oftLayers']['orientation']['head'])
            self.assertEqual(visual['orientationSource'],'future_direction')
            self.assertEqual(visual['directionAnchorFrameIndex'],1)
            self.assertIsNotNone(visual['head']);self.assertFalse(visual['metricEligible'])

    def test_bidirectional_image_motion_rejects_a_persistent_opposite_tail_proposal(self):
        image,box,bg,_=animal();row=observed(image,box,bg)
        for x in [145,155,165,175]:cv.rectangle(image,(x,115),(x+3,120),(30,)*3,-1)
        tracker=VisualContinuity(320,240)
        forward=dict(state='estimated',source='tail_silhouette',head=dict(x=190,y=120),tailBase=dict(x=130,y=120))
        reverse={**forward,'head':forward['tailBase'],'tailBase':forward['head']}
        tracker.update(image,row,forward)
        for i in range(1,8):
            output=tracker.update(image,{**row,'frameIndex':i,'timestampSec':i/20},reverse)
            self.assertEqual(output['orientationSource'],'flow_direction')
            self.assertGreater(output['head']['x'],output['tailBase']['x'])

    def test_current_curved_body_keeps_a_path_inside_its_silhouette(self):
        mask=np.zeros((160,160),np.uint8)
        cv.ellipse(mask,(80,70),(45,45),0,0,180,255,20)
        contour=max(cv.findContours(mask,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE)[0],key=cv.contourArea)
        polygon=[dict(x=float(p[0][0]),y=float(p[0][1])) for p in contour]
        path=curve(polygon,np.array([1.,0.]))
        self.assertEqual(len(path),7)
        for a,b in zip(path,path[1:]):
            for x,y in np.linspace(a,b,12):self.assertGreaterEqual(cv.pointPolygonTest(contour,(float(x),float(y)),False),0)

    def test_axis_gaps_and_missing_boxes_are_filled_without_changing_observations(self):
        image,box,bg,_=animal();row=observed(image,box,bg)
        tracker=LayeredTracker(320,240,background=bg)
        first=tracker.update(image,row)
        self.assertIsNotNone(first['visualization']['head'])
        gap={**row,'frameIndex':1,'timestampSec':.05,'bodyAxis':{**row['bodyAxis'],'points':[],'state':'ambiguous','reason':'concave_body'}}
        before=copy.deepcopy(gap)
        estimate=tracker.update(image,gap)['visualization']
        self.assertEqual(estimate['source'],'current_silhouette')
        self.assertEqual(len(estimate['points']),7)
        self.assertIsNotNone(estimate['head'])
        self.assertEqual(gap,before)
        for i in range(2,30):
            missing=dict(frameIndex=i,timestampSec=i/20,source='predicted',status='missing',reason='no_contour')
            with patch('oft_continuity.cv.calcOpticalFlowPyrLK',return_value=(None,None,None)):
                estimate=tracker.update(image,missing)['visualization']
            self.assertEqual(estimate['source'],'held_estimate')
            self.assertEqual(len(estimate['points']),7)
            self.assertIsNotNone(estimate['box'])
            self.assertFalse(estimate['metricEligible'])
            self.assertGreater(estimate['ageSec'],0)
        self.assertGreater(estimate['ageSec'],1)
        self.assertLess(estimate['supportScore'],.15)

    def test_display_never_extends_past_researcher_intervention(self):
        image,box,bg,_=animal();row=observed(image,box,bg)
        tracker=LayeredTracker(320,240);tracker.update(image,row)
        for i,reason in enumerate(['researcher_intervention','observed'],1):
            output=tracker.update(image,{**row,'frameIndex':i,'timestampSec':i/20,'reason':reason})['visualization']
            self.assertEqual(output['state'],'stopped');self.assertEqual(output['points'],[])

    def test_middle_appendage_and_static_grid_cannot_assign_tail_identity(self):
        image,box,bg,_=animal(tail=False)
        cv.line(image,(160,130),(160,195),(210,)*3,3)
        row=observed(*animal(tail=False)[:3])
        output=LayeredTracker(320,240,background=bg).update(image,row)
        self.assertEqual(output['orientation']['state'],'ambiguous')
        self.assertIsNone(output['visualization']['head'])

    def test_tail_with_opposite_contrast_from_fur_is_detected_against_reference(self):
        image,box,bg,_=animal(tail=False)
        bg[:]=120
        image=np.where((image==40),120,image).astype(np.uint8)
        cv.line(image,(125,120),(90,120),(25,)*3,3)
        row=observed(image,box,bg)
        output=LayeredTracker(320,240,background=bg).update(image,row)
        self.assertEqual(output['orientation']['source'],'tail_silhouette')
        self.assertGreater(output['orientation']['head']['x'],output['orientation']['tailBase']['x'])


if __name__=='__main__':unittest.main()
