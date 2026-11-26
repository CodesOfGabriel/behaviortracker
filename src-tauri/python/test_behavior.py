"""Contract/temporal tests. Synthetic fixtures do not establish behavioral accuracy."""
import importlib.util
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import cv2 as cv
import numpy as np
from behavior.contracts import DECODER, FEATURES, vector, validate_decoder
from behavior.observation_quality import behavior_observation_quality, crop_observation_quality
from behavior.silhouette_features import extract
from behavior.crop_extractor import CropExtractor
from behavior.motion_features import MotionFeatures
from behavior.event_decoder import decode
from behavior.metrics import calculate
from behavior.normalization import fit_training, validate
from behavior.temporal_windows import windows
from behavior.model_registry import load_manifest, install, status
from behavior.open_field import run, video_duration

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/behavior'))
from build_oft_dataset import split_videos, read_intervals
from common import target
from validate_oft_behavior import event_metrics, development_targets, independent_evaluation


def sample(**overrides):
    return dict(source='segmented',status='low_confidence',trackingAccepted=True,bbox=dict(x=100,y=100,width=60,height=20),
                localQuality=dict(tracking='observed',geometry='boundary',reasons=['near_wall_or_partial']),timestampSec=0.,**overrides)


def predictions(scores,dt=1/15):
    return [dict(timestampSec=i*dt,endSec=(i+1)*dt,observation='OBSERVED' if score is not None else 'UNOBSERVED',
                 pRearing=score,pSupportedGivenRearing=None,classification='NON_REARING' if score is not None else 'UNKNOWN') for i,score in enumerate(scores)]


class QualityTests(unittest.TestCase):
    def test_wall_observation_does_not_require_floor_metric_permission(self):
        self.assertEqual(behavior_observation_quality(sample()),'OBSERVED')
    def test_prediction_missing_and_empty_boxes_do_not_supply_evidence(self):
        for override in [dict(source='predicted'),dict(status='missing'),dict(bbox=None),dict(bbox=dict(x=0,y=0,width=0,height=1))]:
            row=sample();row.update(override);self.assertEqual(behavior_observation_quality(row),'UNOBSERVED')
    def test_reflections_camera_motion_identity_and_clipping_stay_uncertain(self):
        for reason in ['camera_shift','ambiguous_candidates','silhouette_clipped','identity_pending','reacquisition_pending']:
            row=sample();row['localQuality']['reasons']=[reason];self.assertEqual(behavior_observation_quality(row),'UNCERTAIN')
    def test_rejected_posture_candidate_is_retained_but_not_promoted(self):
        row=sample();row.update(trackingAccepted=False,reason='area_changed')
        self.assertEqual(behavior_observation_quality(row),'UNCERTAIN');self.assertIsNotNone(row['bbox'])
    def test_recovered_pixels_for_context_never_promote_a_prediction_to_an_observation(self):
        self.assertEqual(crop_observation_quality('UNOBSERVED',True,False),'UNOBSERVED')
        self.assertEqual(crop_observation_quality('OBSERVED',True,False),'UNCERTAIN')
        self.assertEqual(crop_observation_quality('OBSERVED',False,False),'UNOBSERVED')


class FeatureTests(unittest.TestCase):
    def contour(self):
        mask=np.zeros((100,100),np.uint8);cv.ellipse(mask,(50,50),(30,12),0,0,360,255,-1)
        contour=cv.findContours(mask,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE)[0][0]
        return [dict(x=float(p[0][0]),y=float(p[0][1])) for p in contour]
    def test_shape_is_rotation_invariant_and_does_not_use_image_height_as_rearing(self):
        a=extract(self.contour());b=extract([dict(x=p['y'],y=100-p['x']) for p in self.contour()])
        for key in ['silhouette_area','oriented_aspect_ratio','major_axis_length','minor_axis_length','body_axis_length','body_axis_tortuosity']:
            self.assertAlmostEqual(a[key],b[key],delta=.05)
    def test_axis_is_undirected(self):
        a=extract(self.contour());b=extract(list(reversed(self.contour())))
        self.assertEqual(a['body_width_profile'],b['body_width_profile'])
        self.assertAlmostEqual(a['body_axis_curvature'],b['body_axis_curvature'])
    def test_scaled_large_contours_serialize_without_numpy_scalars(self):
        large=[dict(x=p['x']*8,y=p['y']*8) for p in self.contour()]
        json.dumps(extract(large),allow_nan=False)
    def test_isotropic_silhouette_does_not_invent_stable_axis(self):
        c=[dict(x=50+20*math.cos(a),y=50+20*math.sin(a)) for a in np.linspace(0,2*math.pi,100)]
        self.assertNotIn('body_axis_length',extract(c))
    def test_crop_scale_does_not_follow_bbox_size(self):
        cropper=CropExtractor(60);image=np.zeros((300,300,3),np.uint8)
        _,a=cropper.extract(image,sample(),'OBSERVED')
        row=sample();row['bbox']=dict(x=110,y=110,width=30,height=10);row['timestampSec']=.1
        _,b=cropper.extract(image,row,'OBSERVED')
        self.assertEqual(a['classificationCrop']['width'],b['classificationCrop']['width'])
    def test_fallback_crop_remains_unobserved_evidence(self):
        cropper=CropExtractor(60);frame=np.zeros((300,300,3),np.uint8)
        cropper.extract(frame,sample(),'OBSERVED')
        row=sample();row.update(bbox=None,timestampSec=.1)
        crop,info=cropper.extract(frame,row,'UNOBSERVED')
        self.assertIsNotNone(crop);self.assertFalse(info['cropUsable']);self.assertTrue(info['recoveredCrop'])
        row['timestampSec']=1.;self.assertIsNone(cropper.extract(frame,row,'UNOBSERVED')[0])
    def test_rejected_candidate_uses_short_expanded_crop_at_last_reliable_location(self):
        cropper=CropExtractor(60);frame=np.zeros((300,300,3),np.uint8)
        _,first=cropper.extract(frame,sample(),'OBSERVED')
        row=sample();row.update(bbox=dict(x=220,y=220,width=60,height=20),timestampSec=.1)
        _,recovered=cropper.extract(frame,row,'UNCERTAIN')
        self.assertTrue(recovered['recoveredCrop']);self.assertFalse(recovered['cropUsable'])
        roi=recovered['classificationCrop'];self.assertAlmostEqual(roi['x']+roi['width']/2,130.)
        self.assertGreater(roi['width'],first['classificationCrop']['width'])
    def test_padding_only_the_context_does_not_hide_an_entirely_visible_animal(self):
        row=sample();row['bbox']=dict(x=5,y=20,width=60,height=20)
        _,info=CropExtractor(60).extract(np.zeros((300,300,3),np.uint8),row,'OBSERVED')
        self.assertTrue(info['cropUsable']);self.assertTrue(info['cropPadded'])
        self.assertGreater(info['paddingFraction'],0.)
    def test_animal_clipped_by_image_border_remains_unusable(self):
        row=sample();row['bbox']=dict(x=-5,y=20,width=60,height=20)
        _,info=CropExtractor(60).extract(np.zeros((300,300,3),np.uint8),row,'OBSERVED')
        self.assertFalse(info['cropUsable'])
    def test_missing_features_have_explicit_masks(self):
        norm=fit_training([{'silhouette_area':10.},{'silhouette_area':20.}]);validate(norm)
        values=vector({},norm)
        self.assertEqual(len(values),2*len(FEATURES));self.assertEqual(sum(values),0)
    def test_padding_and_observation_masks_are_explicit(self):
        batches=list(windows(np.ones((3,2),np.float32),[True,False,True]))
        array=batches[0][1];self.assertEqual(array.shape,(3,3,31))
        self.assertEqual(array[0,-1,14],0);self.assertEqual(array[0,-1,15],1);self.assertEqual(array[0,-1,16],0)
    def test_internal_motion_does_not_invent_activity_for_identical_crops(self):
        for method in ['lk','farneback']:
            engine=MotionFeatures(method);rng=np.random.default_rng(1);crop=rng.integers(0,255,(128,128,3),dtype=np.uint8)
            row=sample();row.update(values={},classificationCrop=dict(x=80,y=80,width=120,height=120),contour=[dict(x=100,y=100),dict(x=160,y=100),dict(x=160,y=120),dict(x=100,y=120)])
            engine.extract(crop,row,'OBSERVED',120);row['timestampSec']=.1
            out=engine.extract(crop,row,'OBSERVED',120)
            self.assertAlmostEqual(out['centroid_velocity'],0);self.assertLess(out.get('internal_motion',0),.1)
            engine.extract(None,row,'UNOBSERVED',120);self.assertIsNone(engine.previous)
    def test_relative_changes_use_fixed_robust_session_dimensions(self):
        engine=MotionFeatures('lk',{'silhouette_area':100.,'body_axis_length':50.,'body_width_mean':10.})
        crop=np.zeros((128,128,3),np.uint8)
        row=sample();row.update(values={'silhouette_area':20.,'body_axis_length':30.,'body_width_mean':5.})
        engine.extract(crop,row,'OBSERVED',120)
        row.update(timestampSec=.1,values={'silhouette_area':30.,'body_axis_length':40.,'body_width_mean':6.})
        values=engine.extract(crop,row,'OBSERVED',120)
        self.assertAlmostEqual(values['relative_area_change'],.1)
        self.assertAlmostEqual(values['relative_length_change'],.2)
        self.assertAlmostEqual(values['relative_width_change'],.1)


class DecoderTests(unittest.TestCase):
    def test_retrospective_onset_and_minimum_duration(self):
        events=decode(predictions([0,0,.9,.9,.9,.9,0,0,0]));self.assertEqual(len(events),1)
        self.assertAlmostEqual(events[0]['startSec'],2/15);self.assertAlmostEqual(events[0]['endSec'],6/15)
    def test_single_high_frame_never_counts_as_episode(self):
        self.assertEqual(decode(predictions([0,.99,0,0])),[])
    def test_short_score_drop_does_not_duplicate_episode(self):
        self.assertEqual(len(decode(predictions([.9]*4+[.1]+[.9]*4))),1)
    def test_confirmed_quadrupedal_gap_separates_two_rearings(self):
        self.assertEqual(len(decode(predictions([.9]*5+[0]*2+[.9]*5))),2)
    def test_unknown_gap_is_not_counted_in_observed_duration(self):
        events=decode(predictions([.9]*4+[None]+[.9]*4));self.assertEqual(len(events),1)
        self.assertTrue(events[0]['censored']);self.assertAlmostEqual(events[0]['durationSec'],8/15)
    def test_long_unobserved_gap_ends_episode(self):
        self.assertEqual(len(decode(predictions([.9]*4+[None]*5+[.9]*4))),2)
    def test_supported_subtype_needs_conditional_output_not_wall_distance(self):
        values=predictions([.9]*5);self.assertEqual(decode(values)[0]['behavior'],'REARING_UNSPECIFIED')
        for p in values:p['pSupportedGivenRearing']=.95
        self.assertEqual(decode(values)[0]['behavior'],'REARING_SUPPORTED')
    def test_vfr_support_uses_actual_time(self):
        values=predictions([.9]*5)
        values[0].update(timestampSec=2.,endSec=2.04)
        for i,p in enumerate(values[1:]):p.update(timestampSec=2.04+i*.09,endSec=2.13+i*.09)
        result=decode(values)[0];self.assertEqual(result['startSec'],2.);self.assertAlmostEqual(result['durationSec'],.4)
    def test_invalid_decoder_thresholds_and_overlapping_support_are_rejected(self):
        with self.assertRaises(ValueError):validate_decoder({'onsetThreshold':.2,'offsetThreshold':.9})
        values=predictions([.9]*5);values[1]['timestampSec']=0
        with self.assertRaises(ValueError):decode(values)


class MetricTests(unittest.TestCase):
    def test_video_duration_preserves_long_vfr_last_frame_support(self):
        output=type('Probe',(),{'stdout':'{"streams":[{"duration":"2.4"}]}'})()
        with patch('behavior.open_field.subprocess.run',return_value=output):
            duration,source=video_duration('video','ffprobe',2.,.1)
        self.assertEqual(duration,2.4);self.assertEqual(source,'ffprobe_video_stream_duration')
    def test_zero_requires_classifiable_evidence(self):
        values=predictions([0]*10);self.assertEqual(calculate(values,[],10/15)['rearing']['totalCount'],0)
        values=predictions([None]*10);self.assertIsNone(calculate(values,[],10/15)['rearing']['totalCount'])
    def test_unknown_prefix_makes_latency_inexact(self):
        values=predictions([None,0,0]+[.9]*5);events=decode(values)
        metrics=calculate(values,events,8/15);self.assertIsNone(metrics['rearing']['latencySec']);self.assertIsNotNone(metrics['rearing']['firstObservedRearingSec'])
    def test_denominator_is_classifiable_duration(self):
        values=predictions([None]*5+[.9]*5);events=decode(values);metrics=calculate(values,events,10/15)
        self.assertAlmostEqual(metrics['coveragePct'],50);self.assertAlmostEqual(metrics['rearing']['percentClassifiableTime'],100)
    def test_unknown_gap_is_not_reported_as_an_exact_inter_episode_interval(self):
        values=predictions([.9]*5+[None]*5+[.9]*5);events=decode(values);metrics=calculate(values,events,1.)
        self.assertEqual(metrics['rearing']['interEpisodeIntervalsSec'],[None])
        self.assertAlmostEqual(metrics['rearing']['interObservedEpisodeGapsSec'][0],5/15)
    @unittest.skipUnless(importlib.util.find_spec('scipy'), 'Optional scientific-validation dependency')
    def test_matching_is_one_to_one_even_with_duplicate_predictions(self):
        a=dict(startSec=1,endSec=2)
        result=event_metrics([a,a],[a]);self.assertEqual(result['tp'],1);self.assertEqual(result['fp'],1)
        json.dumps(result,allow_nan=False)


class DatasetTests(unittest.TestCase):
    def videos(self):return [dict(video_id=f'video_{i}',animal_id=f'animal_{i}',session_id=f'session_{i}',sha256=str(i)*64) for i in range(5)]
    def test_animal_and_hash_cannot_cross_split(self):
        videos=self.videos();videos[1]['animal_id']=videos[0]['animal_id'];videos[2]['sha256']=videos[1]['sha256']
        result=split_videos(videos);self.assertEqual(result['video_0'],result['video_1']);self.assertEqual(result['video_1'],result['video_2'])
    def test_one_animal_cannot_be_randomly_split_by_frame(self):
        with self.assertRaises(ValueError):split_videos(self.videos()[:2])
    def test_unannotated_is_masked_not_negative(self):
        _,mask=target(dict(label='UNKNOWN',observation='OBSERVED',cropUsable=True));self.assertEqual(mask,[0.,0.])
    def test_overlap_requires_human_adjudication(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'intervals.csv';path.write_text('video_id,start_sec,end_sec,label,annotator_id\nv,0,1,NON_REARING,A\nv,.5,2,REARING_UNSPECIFIED,A\n')
            with self.assertRaises(ValueError):read_intervals(path)


class PeakExportTests(unittest.TestCase):
    def test_peak_only_export_preserves_pts_type_edits_and_undo_without_inventing_intervals(self):
        import csv, io, zipfile
        from behavior.export_dataset import export
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/'samples.jsonl').write_text('{}\n')
            (root/'request.json').write_text('{}')
            peak=dict(type='PEAK',id='p',timestampSec=.17,frameIndex=2,label='REARING_UNSPECIFIED',annotatorId='A',videoSha256='a'*64,trackingJobId='t')
            removed={**peak,'id':'removed','timestampSec':.2,'frameIndex':3}
            history=[peak,removed,dict(type='LABEL_PEAK',targetId='p',label='REARING_SUPPORTED',annotatorId='B'),dict(type='UNDO',targetId='removed')]
            request=dict(experimentId='v',video=str(root/'video.mp4'),annotations=history,animalId='animal',sessionId='s',arenaId='arena',videoSha256='a'*64,trackingJobId='t',annotationProtocol='protocol',trackingDirectory=str(root))
            source=root/'export.json';source.write_text(json.dumps(request));destination=root/'out.zip'
            export(source,destination)
            with zipfile.ZipFile(destination) as archive:
                peaks=list(csv.DictReader(io.StringIO(archive.read('annotations/peaks.csv').decode())))
                self.assertEqual(len(peaks),1)
                self.assertEqual(peaks[0]['timestamp_sec'],'0.17')
                self.assertEqual(peaks[0]['frame_index'],'2')
                self.assertEqual(peaks[0]['label'],'REARING_SUPPORTED')
                self.assertEqual(peaks[0]['annotator_id'],'B')
                self.assertEqual(list(csv.DictReader(io.StringIO(archive.read('annotations/intervals.csv').decode()))),[])
                self.assertEqual(len(archive.read('annotations/history.jsonl').decode().splitlines()),4)


class ScientificValidationTests(unittest.TestCase):
    def test_negative_session_with_no_false_positives_is_valid_without_rearing_f1(self):
        frame={'fp':0,'precision':None,'recall':None,'f1':None}
        event={'tp':0,'fp':0,'f1':None}
        self.assertTrue(development_targets(frame,event,0.,100.,True,0))
        self.assertFalse(development_targets(frame,event,0.,0.,True,0))
        self.assertFalse(development_targets(frame,event,0.,100.,False,0))
    def test_false_positive_rearing_fails_a_negative_session(self):
        self.assertFalse(development_targets({'fp':1},{'tp':0,'fp':1},None,100.,True,0))
    def test_positive_session_must_meet_all_accuracy_and_coverage_targets(self):
        frame={'precision':.95,'recall':.95,'f1':.95}
        event={'f1':.95,'onsetMedianAbsoluteErrorSec':.1,'offsetMedianAbsoluteErrorSec':.1,'countRelativeError':.05}
        self.assertTrue(development_targets(frame,event,.05,96.,True,2))
        self.assertFalse(development_targets(frame,event,.05,94.,True,2))
        self.assertFalse(development_targets({**frame,'recall':.5},event,.05,100.,True,2))
    def test_evaluation_cannot_reuse_the_training_animals_sessions_or_video_hashes(self):
        manifest={'training':{'datasetProvenance':{'partitions':{'train':{'animalIds':['train_animal'],'sessionIds':['train_session'],'videoSha256':['train_hash']}}}}}
        row={'animalId':'test_animal','sessionId':'test_session','videoSha256':'test_hash'}
        self.assertTrue(independent_evaluation(manifest,[row]))
        for key,value in [('animalId','train_animal'),('sessionId','train_session'),('videoSha256','train_hash')]:
            with self.assertRaises(ValueError):independent_evaluation(manifest,[{**row,key:value}])
        self.assertFalse(independent_evaluation({},[row]))


class LifecycleTests(unittest.TestCase):
    def test_a_changed_manifest_is_rejected_before_model_loading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'manifest.json').write_text('{}')
            (root/'request.json').write_text(json.dumps({'modelDirectory':str(root),'modelManifestSha256':'0'*64}))
            report=run(root/'request.json')
            self.assertEqual(report['state'],'failed');self.assertIn('manifest changed',report['error'])
            self.assertFalse((root/'result').exists())
    def test_missing_weights_are_not_a_zero_rearing_result(self):
        with self.assertRaises(ValueError):load_manifest(ROOT/'models/oft_rearing_v1/manifest.json')
    def test_cancelled_extraction_does_not_publish_any_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'request.json').write_text(json.dumps({'modelDirectory':'unused'}))
            fake=type('Fake',(),{'manifest':{'sampleRateHz':15}})()
            with patch('behavior.onnx_inference.Inference',return_value=fake),patch('behavior.open_field.extract',side_effect=InterruptedError):
                report=run(root/'request.json')
            self.assertEqual(report['state'],'cancelled');self.assertFalse((root/'result').exists());self.assertFalse((root/'pending').exists())
    def test_failed_inference_does_not_publish_partial_metrics(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'request.json').write_text(json.dumps({'modelDirectory':'absent'}))
            report=run(root/'request.json');self.assertEqual(report['state'],'failed');self.assertFalse((root/'result').exists())



class ModelIntegrityTests(unittest.TestCase):
    def bundle(self,root):
        import hashlib
        manifest=json.loads((ROOT/'models/oft_rearing_v1/manifest.json').read_text())
        manifest.update(availability='trained',modelVersion='synthetic-contract-test',architecture='random_forest')
        manifest['files']={}
        for name in ['feature_schema.json','normalization.json','decoder_config.json','temporal_classifier.onnx']:
            content=b'synthetic fixture, not a behavioral classifier'
            (root/name).write_bytes(content)
            manifest['files'][name]={'sizeBytes':len(content),'sha256':hashlib.sha256(content).hexdigest()}
        (root/'manifest.json').write_text(json.dumps(manifest))
        return manifest
    def test_validated_bundle_installs_and_reopens_without_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();self.bundle(source)
            with patch('model_delivery.urlopen',side_effect=AssertionError('Offline cache must not use network')):
                installed=install(source/'manifest.json',root/'installed',local_source=source)
                self.assertTrue(installed['installed']);self.assertTrue(status(root/'installed/manifest.json',root/'installed')['installed'])
    def test_corrupted_local_weights_are_rejected_before_manifest_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();self.bundle(source)
            (source/'temporal_classifier.onnx').write_bytes(b'corrupt')
            with self.assertRaises(ValueError):install(source/'manifest.json',root/'installed',local_source=source)
            self.assertFalse((root/'installed/manifest.json').exists())
    def test_model_installation_cancellation_does_not_publish_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);self.bundle(root)
            with self.assertRaises(InterruptedError):install(root/'manifest.json',root/'installed',local_source=root,cancelled=lambda:True)
            self.assertFalse((root/'installed/manifest.json').exists())
    def test_latest_or_missing_hash_cannot_enter_model_registry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);manifest=self.bundle(root)
            manifest['files']['temporal_classifier.onnx']['url']='https://example.test/releases/latest/model.onnx'
            manifest['releaseTag']='latest';(root/'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):load_manifest(root/'manifest.json')
    @unittest.skipUnless(all(importlib.util.find_spec(name) for name in ['onnxruntime','onnx','sklearn']), 'Optional training/export dependencies')
    def test_both_forest_heads_match_cpu_onnx_probabilities(self):
        import onnxruntime as ort
        from sklearn.ensemble import RandomForestClassifier
        from export_onnx import forest_graph
        rng=np.random.default_rng(4)
        x=rng.normal(size=(120,2*len(FEATURES))).astype(np.float32)
        a=RandomForestClassifier(n_estimators=12,max_depth=4,random_state=1).fit(x,(x[:,0]>0).astype(int))
        b=RandomForestClassifier(n_estimators=12,max_depth=4,random_state=2).fit(x,(x[:,1]>0).astype(int))
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'forest.onnx';forest_graph({'rearing':a,'subtype':b},path)
            session=ort.InferenceSession(str(path),providers=['CPUExecutionProvider'])
            actual=session.run(None,{'features':x})[0]
            expected=np.column_stack((a.predict_proba(x)[:,1],b.predict_proba(x)[:,1]))
            np.testing.assert_allclose(actual,expected,rtol=1e-5,atol=1e-5)

if __name__=='__main__':unittest.main()
