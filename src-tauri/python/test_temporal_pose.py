"""Offline recovery regressions; synthetic anatomy is known, no learned labels."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
import numpy as np
from temporal_pose import refine
from temporal_pose.orientation_viterbi import decode
from temporal_pose.kalman_smoother import smooth


def sequence(count=20):
    rows = []
    for i in range(count):
        path = [dict(x=float(30+j*10), y=50.) for j in range(7)]
        v = dict(version="image_flow_and_mask_v1", state="estimated", source="observed_geometry", points=path,
                 head=path[-1], tailBase=path[0], box=dict(x=25,y=40,width=70,height=20),
                 orientationSource="previous_direction", ageSec=i/20, supportScore=.4, metricEligible=False)
        rows.append(dict(frameIndex=i,timestampSec=i/20,source="segmented",status="valid",reason="observed",
            xPx=60.,yPx=50.,trackingAccepted=True,bodyAxis=dict(points=copy.deepcopy(path),state="reliable"),
            contour=[dict(x=25,y=40),dict(x=95,y=40),dict(x=95,y=60),dict(x=25,y=60)],
            oftLayers=dict(visualization=v,orientation=dict(source=None,head=None,tailBase=None,tailTip=None))))
    return rows


def anchor(row, reverse=False, length=55):
    row['oftLayers']['orientationEvidence']=dict(source='tail_silhouette',
        head=dict(x=30 if reverse else 90,y=50),tailBase=dict(x=90 if reverse else 30,y=50),
        tailTip=dict(x=90+length if reverse else 30-length,y=50))


class TemporalPoseTests(unittest.TestCase):
    def test_unknown_retains_both_identities_even_when_optical_flow_is_missing(self):
        rows=sequence(40)
        for i,row in enumerate(rows):anchor(row,reverse=15<=i<25)
        refine(rows)
        for row in rows:
            v=row['oftLayers']['visualization']
            if v['head'] is not None:self.assertGreater(v['head']['x'],v['tailBase']['x'])
        self.assertTrue(any(r['oftLayers']['visualization']['head'] is None for r in rows[15:25]))

    def test_unknown_frames_cannot_reset_identity_and_enable_a_hidden_swap(self):
        rows=sequence(50)
        for i,row in enumerate(rows):
            anchor(row,reverse=15<=i<35)
            row['oftLayers']['temporalEvidence']={'flowMatrix':[[1.,0.,0.],[0.,1.,0.]]}
        refine(rows)
        for row in rows:
            v=row['oftLayers']['visualization']
            if v['head'] is not None:self.assertGreater(v['head']['x'],v['tailBase']['x'])
        self.assertIsNotNone(rows[0]['oftLayers']['visualization']['head'])
        self.assertIsNotNone(rows[-1]['oftLayers']['visualization']['head'])
    def test_missing_prefix_is_recovered_by_backwards_image_flow_only_when_supported(self):
        from temporal_pose.gap_recovery import recover
        from oft_layers import LayeredTracker
        from test_oft_layers import animal,observed,video_fixture
        with tempfile.TemporaryDirectory() as temporary:
            video,_,_=video_fixture(Path(temporary),count=3)
            tracker=LayeredTracker(320,240);rows=[]
            for i in range(3):
                image,box,bg,_=animal(center=(100+i*3,120));row=observed(image,box,bg,i)
                row['oftLayers']=tracker.update(image,row);rows.append(row)
            rows[0].update(source='predicted',status='missing',reason='no_contour')
            rows[0].pop('contour');rows[0]['bodyAxis']['points']=[];rows[0]['bodyAxis']['state']='missing'
            rows[0]['oftLayers']['visualization'].update(state='unavailable',points=[],head=None,tailBase=None,source=None)
            snapshot=copy.deepcopy(rows[0]['bodyAxis'])
            self.assertEqual(recover(video,rows,(320,240)),1)
            self.assertEqual(rows[0]['oftLayers']['visualization']['source'],'optical_flow')
            self.assertEqual(len(rows[0]['oftLayers']['visualization']['points']),7)
            self.assertEqual(rows[0]['bodyAxis'],snapshot)
            self.assertIsNone(rows[0]['oftLayers']['visualization']['head'])

    def test_future_consensus_overrules_an_isolated_wrong_initial_identity(self):
        rows=sequence();anchor(rows[0],True,length=12)
        for row in rows[10:]:anchor(row)
        raw=copy.deepcopy(rows)
        refine(rows)
        for i,row in enumerate(rows):
            v=row['oftLayers']['visualization']
            self.assertGreater(v['head']['x'],v['tailBase']['x'])
            self.assertEqual(v['orientationSource'],'bidirectional_recovery')
            self.assertFalse(v['metricEligible']);self.assertFalse(v['temporal']['metricEligible'])
            self.assertEqual(row['bodyAxis'],raw[i]['bodyAxis'])
            self.assertEqual(row['oftLayers']['orientation'],raw[i]['oftLayers']['orientation'])
        self.assertGreater(rows[0]['oftLayers']['visualization']['temporal']['anchorFrameIndex'],0)

    def test_no_anatomical_evidence_or_balanced_evidence_remains_unknown(self):
        for mode in ['absent','balanced']:
            rows=sequence()
            if mode=='balanced':anchor(rows[0]);anchor(rows[-1],True)
            refine(rows)
            self.assertTrue(all(r['oftLayers']['visualization']['head'] is None for r in rows))
            self.assertTrue(all(len(r['oftLayers']['visualization']['points'])==7 for r in rows))

    def test_walking_backwards_and_arbitrary_pca_sign_cannot_flip_anatomy(self):
        rows=sequence();anchor(rows[0])
        for i,row in enumerate(rows):
            v=row['oftLayers']['visualization']
            for p in v['points']:p['x']-=i
            if i%2:v['points'].reverse()
        refine(rows)
        self.assertTrue(all(r['oftLayers']['visualization']['head']['x']>r['oftLayers']['visualization']['tailBase']['x'] for r in rows))

    def test_rotating_image_motion_preserves_identity_through_a_half_turn(self):
        angles=np.linspace(0,np.pi,20)
        base=np.column_stack([np.linspace(-30,30,7),np.zeros(7)])
        paths=[];motions=[None]
        for i,angle in enumerate(angles):
            r=np.array([[np.cos(angle),-np.sin(angle)],[np.sin(angle),np.cos(angle)]])
            paths.append(base@r.T+[100,100])
            if i:
                da=angle-angles[i-1];a=np.array([[np.cos(da),-np.sin(da)],[np.sin(da),np.cos(da)]])
                motions.append(np.column_stack([a,np.array([100,100])-a@np.array([100,100])]))
        evidence=[(np.array([1.,0.]),2.)]+[None]*19
        states,_=decode(paths,np.arange(20)/20,evidence,motions)
        self.assertTrue(np.all(states==1))
        self.assertLess(paths[-1][-1,0],paths[-1][0,0])

    def test_long_image_loss_does_not_freeze_a_known_skeleton_indefinitely(self):
        rows=sequence(80);anchor(rows[0]);anchor(rows[-1],True)
        for row in rows[1:-1]:
            row['oftLayers']['visualization']['source']='held_estimate'
            row.pop('contour');row['source']='predicted'
        refine(rows)
        self.assertTrue(all(r['oftLayers']['visualization']['points']==[] for r in rows[8:-1]))
        self.assertLess(rows[-1]['oftLayers']['visualization']['head']['x'],rows[-1]['oftLayers']['visualization']['tailBase']['x'])

    def test_clock_gap_does_not_transfer_identity(self):
        rows=sequence();anchor(rows[0])
        for row in rows[10:]:row['timestampSec']+=2
        refine(rows)
        self.assertIsNotNone(rows[9]['oftLayers']['visualization']['head'])
        self.assertIsNone(rows[10]['oftLayers']['visualization']['head'])

    def test_intervention_blocks_future_backfilling_and_latches_stop(self):
        rows=sequence();anchor(rows[-1])
        rows[9]['reason']='researcher_intervention_pending'
        rows[10]['reason']='researcher_intervention'
        refine(rows)
        self.assertIsNone(rows[8]['oftLayers']['visualization']['head'])
        for row in rows[9:]:
            v=row['oftLayers']['visualization']
            self.assertEqual(v['points'],[]);self.assertIsNone(v['head']);self.assertIsNone(v['box'])
        self.assertEqual(rows[9]['oftLayers']['visualization']['state'],'suspended')
        self.assertEqual(rows[-1]['oftLayers']['visualization']['state'],'stopped')

    def test_explicit_occlusion_is_unknown_and_removal_does_not_resume(self):
        rows=sequence();anchor(rows[0]);anchor(rows[-1])
        rows[4]['reason']='occluded';rows[10]['reason']='animal_removed'
        refine(rows)
        self.assertEqual(rows[4]['oftLayers']['visualization']['state'],'unavailable')
        self.assertIsNone(rows[4]['oftLayers']['visualization']['head'])
        self.assertTrue(all(r['oftLayers']['visualization']['state']=='stopped' for r in rows[10:]))

    def test_kalman_backward_pass_reduces_jitter_with_irregular_timestamps(self):
        rng=np.random.default_rng(28);times=np.cumsum(rng.uniform(.03,.07,100))
        truth=np.zeros((100,7,2));truth[:,:,0]=times[:,None]*10+np.arange(7)*8;truth[:,:,1]=40
        noisy=truth+rng.normal(0,1.7,truth.shape)
        result,uncertainty=smooth(noisy,times,np.full(100,1.7**2),50.)
        self.assertLess(np.mean((result-truth)**2),np.mean((noisy-truth)**2)*.6)
        self.assertTrue(np.isfinite(uncertainty).all());self.assertTrue(np.all(uncertainty>=0))

    def test_smoothing_stays_inside_current_mask_and_does_not_modify_raw_floor_center(self):
        import cv2 as cv
        rows=sequence();anchor(rows[0]);raw=copy.deepcopy(rows)
        for i,row in enumerate(rows):
            for p in row['oftLayers']['visualization']['points']:p['y']+=9 if i%2 else -9
        refine(rows)
        for row,original in zip(rows,raw):
            self.assertEqual((row['xPx'],row['yPx'],row['trackingAccepted']),
                             (original['xPx'],original['yPx'],original['trackingAccepted']))
            poly=np.array([[p['x'],p['y']] for p in row['contour']],np.float32)
            for p in row['oftLayers']['visualization']['points']:
                self.assertGreaterEqual(cv.pointPolygonTest(poly,(p['x'],p['y']),False),0)

    def test_finalization_is_atomic_idempotent_and_cancelled_without_changing_file(self):
        from oft_layers import finalize_temporal_pose,digest
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);path=root/'samples.jsonl';rows=sequence();anchor(rows[-1])
            path.write_text(''.join(json.dumps(r)+'\n' for r in rows));before=digest(path)
            with self.assertRaises(InterruptedError):
                finalize_temporal_pose(root,None,{},lambda:True)
            self.assertEqual(digest(path),before)
            self.assertFalse((root/'samples.display.partial.jsonl').exists())
            self.assertEqual(finalize_temporal_pose(root,None,{}),len(rows))
            final=digest(path)
            self.assertEqual(finalize_temporal_pose(root,None,{}),0)
            self.assertEqual(digest(path),final)


if __name__=='__main__':unittest.main()
