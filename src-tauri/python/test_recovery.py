import types
import unittest
from unittest.mock import patch

from recovery import POLICY, VisualRecovery, anchors, bounding_box, compatible, recover_frames


def pose(x=50):
    return {"nose": (x, 30, .9), "mid_back": (x, 50, .9), "hip": (x, 70, .9),
            "left_ear": (x - 10, 35, .9), "tail_tip": (x, 190, .99)}


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.geometry = {"cropping": [20, 220, 40, 240], "videoWidth": 300, "videoHeight": 300}

    def test_roi_is_bounded_and_does_not_use_distal_tail(self):
        bbox = bounding_box(pose(5), 200, 200)
        self.assertEqual(bbox[0], 0)
        self.assertLess(bbox[3], 190)
        self.assertNotIn("tail_tip", anchors(pose()))
        self.assertIsNone(bounding_box({"nose": (5, 6, .9)}, 200, 200))

    def test_nan_and_missing_scores_are_not_anchors(self):
        self.assertEqual(anchors({"a": (-1, -1, -1), "b": (1, 2, float("nan")), "c": (1, 2, 1.1)}), {})

    def test_rejects_inconsistent_visual_candidates(self):
        previous = pose()
        bbox = bounding_box(previous, 200, 200)
        self.assertTrue(compatible(pose(51), previous, bbox))
        self.assertFalse(compatible(pose(180), previous, bbox))
        self.assertFalse(compatible({"nose": (50, 30, .99)}, previous, bbox))

    def test_recovers_from_pixels_without_mutating_raw_or_overwriting_reliable_points(self):
        original = pose()
        failed = {name: (-1, -1, -1) for name in original}
        failed["nose"] = (51, 30, .95)
        calls = []
        def retry(index, previous, width, height):
            calls.append((index, width, height))
            return pose(52)
        result = list(recover_frames([original, failed], 24, self.geometry, retry))
        self.assertEqual(calls, [(1, 200, 200)])
        self.assertEqual(failed["mid_back"], (-1, -1, -1))
        self.assertEqual(result[1][0]["nose"], failed["nose"])
        self.assertIn("mid_back", result[1][1])
        self.assertNotIn("nose", result[1][1])

    def test_abandons_stale_history_instead_of_filling_long_occlusions(self):
        failed = {name: (-1, -1, -1) for name in pose()}
        calls = []
        frames = [pose()] + [failed] * 48
        result = list(recover_frames(frames, 24, self.geometry, lambda index, *_: calls.append(index) or {}, lambda _: None))
        self.assertLessEqual(max(calls) / 24, POLICY["maxHistorySec"])
        self.assertEqual(result[-1][0], failed)
        self.assertEqual(result[-1][1], set())

    def test_missing_initial_pose_does_not_seed_an_invented_location(self):
        failed = {"nose": (-1, -1, -1)}
        result = list(recover_frames([failed] * 10, 24, self.geometry, lambda *_: self.fail("unseeded retry")))
        self.assertTrue(all(not changed for _, changed in result))

    def test_visual_evidence_can_continue_recovery_without_coasting(self):
        failed = {name: (-1, -1, -1) for name in pose()}
        result = list(recover_frames([pose()] + [failed] * 96, 24, self.geometry, lambda *_: pose()))
        self.assertIn("hip", result[-1][1])

    def test_runner_is_loaded_once_receives_rgb_xywh_and_keeps_crop_coordinates(self):
        capture_calls, model_calls, builds = [], [], []
        class Image:
            def __getitem__(self, slices):
                capture_calls.append(slices)
                return self
        class Capture:
            def set(self, prop, index): capture_calls.append((prop, index))
            def read(self): return True, Image()
            def release(self): capture_calls.append("released")
        class Points(list):
            shape = (1, 4, 3)
        class Runner:
            def inference(self, images):
                image, context = images[0]
                model_calls.append(context)
                self_test.assertEqual(image, "rgb")
                return [{"bodyparts": Points([[pose()[name] for name in ("nose", "mid_back", "hip", "left_ear")]])}]
        self_test = self
        def build(config, snapshot, **kwargs):
            builds.append((config, snapshot, kwargs)); return Runner()
        config = {"metadata": {"bodyparts": ["nose", "mid_back", "hip", "left_ear"]}}
        modules = {
            "cv2": types.SimpleNamespace(VideoCapture=lambda _: Capture(), CAP_PROP_POS_FRAMES=1, COLOR_BGR2RGB=4,
                                         cvtColor=lambda image, mode: "rgb"),
            "numpy": types.SimpleNamespace(array=lambda data, **_: data),
            "torch": types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True)),
            "deeplabcut.pose_estimation_pytorch.apis.utils": types.SimpleNamespace(get_pose_inference_runner=build),
            "deeplabcut.pose_estimation_pytorch.modelzoo.utils": types.SimpleNamespace(
                get_super_animal_snapshot_path=lambda *args, **kwargs: "cached-weights" if kwargs["download"] is False else self.fail("download")),
            "deeplabcut.pose_estimation_pytorch.config.pose": types.SimpleNamespace(
                PoseConfig=types.SimpleNamespace(build_for_superanimal_inference=lambda **_: config)),
        }
        with patch.dict("sys.modules", modules):
            recovery = VisualRecovery("fake.mp4", self.geometry)
            self.assertIn("hip", recovery.retry(28, pose(), 200, 200))
            self.assertIn("hip", recovery.retry(29, pose(), 200, 200))
            recovery.close()
        self.assertEqual(len(builds), 1)
        self.assertEqual(recovery.accepted, 2)
        self.assertEqual(model_calls[0]["bboxes"][0], bounding_box(pose(), 200, 200))
        self.assertIn((slice(40, 240), slice(20, 220)), capture_calls)

    def test_incompatible_api_is_reported_and_not_retried_for_each_frame(self):
        recovery = VisualRecovery("fake.mp4", self.geometry)
        with patch.object(recovery, "_prepare", side_effect=ImportError("unsupported DLC API")) as prepare:
            self.assertEqual(recovery.retry(1, pose(), 200, 200), {})
            self.assertEqual(recovery.retry(2, pose(), 200, 200), {})
            self.assertEqual(prepare.call_count, 1)
        self.assertIn("unsupported DLC API", recovery.disabled_reason)


if __name__ == "__main__":
    unittest.main()
