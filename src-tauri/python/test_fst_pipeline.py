"""CPU contract tests for FST presence and checkpoint isolation."""
import tempfile
import unittest
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

from fst_presence import calculate_empty_reference, classify_presence_rows, debounce_presence, detect_presence_video, static_body_evidence
from fst_pipeline import _checkpoint, _extract_pose, _infer, _pose_context, _pose_input_box, _review_windows, _save_checkpoint, _validate


class FstPipelineTests(unittest.TestCase):
    def test_pose_input_uses_body_location_and_preserves_missing_observations(self):
        rect = (10, 20, 210, 320)
        row = SimpleNamespace(presence_state='IN_TANK', body_bbox_local=(50, 40, 90, 80))
        box = _pose_input_box(row, rect)
        self.assertEqual(box, (42., 32., 56., 56.))
        np.testing.assert_array_equal(_pose_context(box)['bboxes'], [[42, 32, 56, 56]])
        self.assertEqual(_pose_context(None)['bboxes'].shape, (0, 4))
        self.assertIsNone(_pose_input_box(SimpleNamespace(presence_state='IN_TANK', body_bbox_local=None), rect))
        self.assertIsNone(_pose_input_box(SimpleNamespace(presence_state='UNCERTAIN', body_bbox_local=row.body_bbox_local), rect))
        self.assertIsNone(_extract_pose({'bodypart': {'poses': np.empty((0, 39, 3))}}))

    def test_inference_receives_per_frame_boxes_and_keeps_gaps(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / 'frames.avi'
            writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*'MJPG'), 10, (200, 300))
            self.assertTrue(writer.isOpened())
            for _ in range(4):
                writer.write(np.zeros((300, 200, 3), np.uint8))
            writer.release()
            boxes = [None, (20., 30., 50., 60.), None, (80., 90., 40., 50.)]
            observed = []

            class FakeIterator:
                def __init__(self, _path):
                    self.context = None

                def get_n_frames(self, robust=False):
                    return 4

                def set_context(self, context):
                    self.context = context

            def infer(video, pose_runner, detector_runner):
                observed.extend(item['bboxes'].copy() for item in video.context)
                return [{'bodypart': {'poses': np.ones((1, 39, 3), np.float32)}}
                    for _ in video.context]

            pep = SimpleNamespace(VideoIterator=FakeIterator, video_inference=infer)
            fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True,
                get_device_properties=lambda _: SimpleNamespace(total_memory=8 * 2**30),
                empty_cache=lambda: None), backends=SimpleNamespace(cudnn=SimpleNamespace()),
                inference_mode=nullcontext)
            fake_writer = SimpleNamespace(isOpened=lambda: True, write=lambda _frame: None, release=lambda: None)
            with patch.dict(sys.modules, {'torch': fake_torch}), \
                    patch('fst_pipeline._runner', return_value=(pep, object(), [f'k{i}' for i in range(39)])), \
                    patch('fst_pipeline.cv2.VideoWriter', return_value=fake_writer):
                arrays, _, _ = _infer(video, root, {'animal_1': (0, 0, 200, 300)}, 10, 4,
                                      'fingerprint', {'animal_1': boxes})
            self.assertEqual(len(observed), 4)
            self.assertEqual(observed[0].shape, (0, 4))
            np.testing.assert_array_equal(observed[1], [[20, 30, 50, 60]])
            np.testing.assert_array_equal(observed[3], [[80, 90, 40, 50]])
            np.testing.assert_array_equal(arrays['animal_1'][:, 0, 2], [0, 1, 0, 1])
            self.assertTrue(np.isnan(arrays['animal_1'][0, :, :2]).all())

    def test_empty_or_reflection_never_confirms_presence(self):
        self.assertEqual(set(debounce_presence([False] * 30, 10)[0]), {'UNCERTAIN'})
        image = np.zeros((300, 200, 3), np.uint8)
        image[:, 95:103] = 245
        self.assertIsNone(static_body_evidence(image))

    def test_static_reflection_before_visual_entry_remains_uncertain(self):
        rows = [{'foreground_fraction':.02 if i < 20 else .10,
                 'temporal_candidate':i >= 20,
                 'static_candidate':i < 8,
                 'body_candidate':i < 8 or i >= 20} for i in range(40)]
        states, stable = classify_presence_rows(rows, 10)
        self.assertFalse(stable[:20].any())
        self.assertTrue((states[:8] == 'UNCERTAIN').all())
        self.assertTrue((states[8:20] == 'NOT_IN_TANK').all())
        self.assertTrue((states[20:] == 'IN_TANK').all())

    def test_two_tanks_are_independent_when_animal_starts_present(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'two.avi'
            writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*'MJPG'), 10, (400, 300))
            self.assertTrue(writer.isOpened())
            for _ in range(30):
                frame = np.zeros((300, 400, 3), np.uint8)
                cv2.ellipse(frame, (100, 145), (55, 35), 0, 0, 360, (240, 240, 240), -1)
                writer.write(frame)
            writer.release()
            rects = {'animal_1': (0, 0, 200, 300), 'animal_2': (200, 0, 400, 300)}
            references = calculate_empty_reference(path, rects, 30, 10)
            result = detect_presence_video(path, rects, references, 30, 10)
            first = result[result.animal_id == 'animal_1']
            second = result[result.animal_id == 'animal_2']
            self.assertTrue((first.presence_state == 'IN_TANK').all())
            self.assertTrue((second.presence_state != 'IN_TANK').all())
            self.assertEqual(len(first), 30)
            self.assertEqual(len(second), 30)

    def test_checkpoint_is_bound_to_its_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'animal_1_0000.npz'
            poses = np.zeros((4, 39, 3), np.float32)
            _save_checkpoint(path, poses, 'video-model-roi-a')
            self.assertEqual(_checkpoint(path, 4, 'video-model-roi-a').shape, (4, 39, 3))
            self.assertIsNone(_checkpoint(path, 4, 'video-model-roi-b'))
            self.assertIsNone(_checkpoint(path, 5, 'video-model-roi-a'))

    def test_roi_contract_requires_complete_distinct_cylinders(self):
        base = {'protocol': 'forced_swim', 'engineId': 'fst_superanimal_quadruped_v1',
                'subjects': [{'animalId': 'animal_1', 'subjectId': 'R1'}],
                'tanks': [{'tankId': 'tank_1', 'animalId': 'animal_1', 'subjectId': 'R1',
                           'roiPx': {'x': 0, 'y': 0, 'width': 200, 'height': 300}, 'revision': 1}],
                'video': {'width': 400, 'height': 300}}
        self.assertEqual(_validate(base, 400, 300), {'animal_1': (0, 0, 200, 300)})
        short = {**base, 'tanks': [{**base['tanks'][0], 'roiPx': {**base['tanks'][0]['roiPx'], 'height': 100}}]}
        with self.assertRaises(AssertionError):
            _validate(short, 400, 300)
        with self.assertRaises(AssertionError):
            _validate({**base, 'engineId': 'wistar_superanimal_hybrid_v1'}, 400, 300)

    def test_review_windows_are_priorities_not_behavior_classes(self):
        frames = [{'animalId':'animal_1','frame':i,'timestampSec':i/10,
                   'presence':'IN_TANK','poseCoverage':.5,'relativeMotion':(i//30)*.01}
                  for i in range(360)]
        with tempfile.TemporaryDirectory() as directory:
            shortlist = _review_windows(frames,['animal_1'],10,Path(directory))
            reasons = {item['reason'] for item in shortlist}
            self.assertIn('LOWER_OBSERVED_MOTION', reasons)
            self.assertIn('HIGHER_OBSERVED_MOTION', reasons)
            self.assertNotIn('IMMOBILITY', reasons)
            self.assertTrue((Path(directory)/'activity_windows_3s.csv').is_file())


if __name__ == '__main__':
    unittest.main()
