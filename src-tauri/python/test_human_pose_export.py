"""Human pose export preserves the exact source image, identity and occlusion."""
import csv
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile
import cv2 as cv
import numpy as np
from behavior.export_dataset import LANDMARKS, active_pose_frames, export, export_annotations


def pose(identity='p',frame=1):
    return dict(id=identity,type='POSE_FRAME',frameIndex=frame,timestampSec=frame*.04,imageWidth=64,imageHeight=48,
        pose={k:dict(visibility='visible',x=20.,y=24.) if i else dict(visibility='occluded',x=None,y=None) for i,k in enumerate(LANDMARKS)},
        annotatorId='human',videoSha256='a'*64,trackingJobId='t')


class HumanPoseExportTests(unittest.TestCase):
    def test_latest_revision_and_undo_preserve_human_history(self):
        original=pose('first');revised=pose('second')
        history=[original,revised,dict(id='u',type='UNDO',targetId='second')]
        self.assertEqual(active_pose_frames(history),[original]);self.assertEqual(len(history),3)

    def request(self,root,events):
        (root/'samples.jsonl').write_text('{}\n');(root/'request.json').write_text('{}')
        return dict(experimentId='v',video=str(root/'source.mp4'),annotations=events,animalId='animal',sessionId='session',arenaId='arena',videoSha256='a'*64,trackingJobId='t',annotationProtocol='human protocol',trackingDirectory=str(root),config=dict(autorotate=True),ffmpeg=shutil.which('ffmpeg'))

    def test_pose_only_package_contains_exact_decoded_frame_and_null_hidden_coordinates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);request=self.request(root,[pose()])
            frames=np.zeros((3,48,64,3),np.uint8);frames[0]=20;frames[1]=140;frames[2]=230
            subprocess.run([request['ffmpeg'],'-v','error','-f','rawvideo','-pix_fmt','bgr24','-s','64x48','-r','25','-i','pipe:0','-an','-c:v','libx264','-crf','0','-pix_fmt','yuv444p',request['video']],input=frames.tobytes(),check=True,capture_output=True)
            source=root/'export.json';source.write_text(json.dumps(request));destination=root/'dataset.zip';export(source,destination)
            with zipfile.ZipFile(destination) as archive:
                rows=list(csv.DictReader(io.StringIO(archive.read('annotations/poses.csv').decode())))
                self.assertEqual(len(rows),6);self.assertEqual(rows[0]['x'],'');self.assertEqual(rows[0]['visibility'],'occluded')
                self.assertTrue(all(r['frame_index']=='1' and r['annotator_id']=='human' for r in rows))
                saved=cv.imdecode(np.frombuffer(archive.read('pose_frames/frame_00000001.png'),np.uint8),cv.IMREAD_COLOR)
                decoded=subprocess.run([request['ffmpeg'],'-v','error','-i',request['video'],'-vf','select=eq(n\\,1)','-frames:v','1','-f','rawvideo','-pix_fmt','bgr24','pipe:1'],capture_output=True,check=True).stdout
                np.testing.assert_array_equal(saved,np.frombuffer(decoded,np.uint8).reshape(48,64,3))
                manifest=json.loads(archive.read('dataset_export.json'));self.assertEqual(manifest['poseFrames'],1);self.assertFalse(manifest['containsOriginalVideo'])
                self.assertFalse(any(name.startswith('videos/') for name in archive.namelist()))
                self.assertEqual(list(csv.DictReader(io.StringIO(archive.read('annotations/intervals.csv').decode()))),[])

    def test_pose_export_and_negative_example_metadata_do_not_create_implicit_labels(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);interval=dict(id='i',type='INTERVAL',startSec=.1,endSec=.2,label='NON_REARING',exampleKind='reflection',annotatorId='human',videoSha256='a'*64,trackingJobId='t')
            request=self.request(root,[pose(),interval]);source=root/'export.json';source.write_text(json.dumps(request))
            export_annotations(source,root/'poses.csv','poses');export_annotations(source,root/'intervals.csv','intervals')
            with (root/'intervals.csv').open(encoding='utf-8-sig',newline='') as stream:rows=list(csv.DictReader(stream))
            self.assertEqual(len(rows),1);self.assertEqual(rows[0]['example_kind'],'reflection');self.assertEqual(rows[0]['label'],'NON_REARING')
            with (root/'poses.csv').open(encoding='utf-8-sig',newline='') as stream:self.assertEqual(len(list(csv.DictReader(stream))),6)

    def test_empty_or_undone_pose_export_fails_instead_of_claiming_training_labels(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);request=self.request(root,[pose(),dict(type='UNDO',targetId='p')]);source=root/'request-export.json';source.write_text(json.dumps(request))
            with self.assertRaisesRegex(ValueError,'pontos corporais'):export_annotations(source,root/'poses.csv','poses')
            with self.assertRaisesRegex(ValueError,'anotação humana'):export(source,root/'package.zip')
