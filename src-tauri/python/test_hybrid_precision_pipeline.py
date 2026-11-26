"""Exercise the real pipeline wiring/export with a simulated neural runner.

NumPy, OpenCV, pandas, refinement, CSV and manifest are real. No Torch/GPU or
learned accuracy is asserted by these integration tests.
"""
import ast
import contextlib
import copy
import csv
import hashlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import cv2
import numpy as np
import pandas as pd


def load_pipeline(root, bundle="wistar_df_v2", local=False):
    models = root / "models"
    models.mkdir()
    for name in ("best_detector.pth", "snapshot-hrnet_w32-001.pt", "pytorch_config.yaml"):
        (models / name).write_bytes(b"verified-fixture")
    values = {"__VIDEO__": str(root / "video.mp4"), "__OUTPUT__": str(root / "output"),
              "__CSV__": str(root / "result.csv"), "__MODELS__": str(models),
              "__MODEL_BUNDLE_ID__": bundle, "__ARENA__": None}
    values.update({key: hashlib.sha256(b"verified-fixture").hexdigest() for key in
                   ("__DETECTOR_SHA256__", "__POSE_SHA256__", "__CONFIG_SHA256__")})
    source = (Path(__file__).parent / "hybrid_pipeline.py").read_text()
    tree = ast.parse(source)
    # Only unavailable neural framework imports are replaced. All production
    # control flow, source-frame transforms, quality checks and writers execute.
    tree.body = [node for node in tree.body if not
                 (isinstance(node, ast.Import) and any(alias.name.split(".")[0] in
                   ("torch", "torchvision", "deeplabcut") for alias in node.names)) and not
                 (isinstance(node, ast.ImportFrom) and node.module.split(".")[0] in ("torchvision", "deeplabcut"))]
    class Replace(ast.NodeTransformer):
        def visit_Name(self, node):
            return ast.copy_location(ast.Constant(values[node.id]), node) if node.id in values else node
    tree = ast.fix_missing_locations(Replace().visit(tree))
    scope = {"__name__": "pipeline_test", "torch": types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: True),
        device=lambda _: types.SimpleNamespace(type="cuda", index=0)),
        "torchvision": types.SimpleNamespace(__version__="simulated")}
    if local:
        scope["LOCAL_PROGRESS"] = lambda *_: None
    exec(compile(tree, "<hybrid_pipeline>", "exec"), scope)
    return scope


class HybridPrecisionPipelineTests(unittest.TestCase):
    def setUp(self):
        # Only model provisioning/inference are simulated. Runtime orchestration
        # has dedicated tests and a separate real CPU model/video audit.
        def no_estimates(video, poses, accepted, detections, keys, *args, **kwargs):
            return poses.copy(), np.zeros(accepted.shape, bool), {"version": "simulated-temporal"}, np.full(accepted.shape, -1, int), np.full(accepted.shape, "", object)
        self.temporal = patch("hybrid.temporal_runtime.recover_video", side_effect=no_estimates).start()
        self.assets = patch("hybrid.temporal_assets.prepare_assets", return_value=({}, {})).start()
        self.addCleanup(patch.stopall)

    def test_raw_pose_alignment_includes_empty_boxes_without_mutating_model_config(self):
        # The SDK is simulated here; the separate real SDK audit reproduced its
        # asynchronous empty-suffix loss. Exercise the production factory, frame
        # count guard and CSV/H5 wiring with distinguishable observations.
        for visible in ([False] * 4, [False, True, True, True],
                        [True, False, True, False], [True, True, False, False]):
            with self.subTest(visible=visible), tempfile.TemporaryDirectory() as tmp:
                pipeline = load_pipeline(Path(tmp))
                pipeline["OUTPUT"].mkdir()
                keys = [f"point_{i}" for i in range(27)]
                config = {"metadata": {"bodyparts": keys}, "inference": {
                    "multithreading": {"enabled": True, "queue_length": 4},
                    "autocast": {"enabled": False}, "compile": {"enabled": False}}}
                original_config = copy.deepcopy(config)
                contexts = [{"bboxes": np.array([[i, 0, 10, 10]], np.float32)
                             if present else np.empty((0, 4), np.float32)}
                            for i, present in enumerate(visible)]
                class Iterator:
                    def __init__(self, _): pass
                    def set_context(self, values): self.contexts = values
                factory_calls = []
                class Runner:
                    def __init__(self, settings): self.settings = settings
                    def inference(self, inputs):
                        predictions = [
                            {"bodyparts": np.full((1, 27, 3), i if len(context["bboxes"]) else -1.)}
                            for i, context in enumerate(inputs.contexts)]
                        if self.settings["multithreading"]["enabled"]:
                            # Reproduce queued empty suffixes, not a fake pose.
                            while predictions and np.all(predictions[-1]["bodyparts"] == -1):
                                predictions.pop()
                        return predictions
                def factory(**kwargs):
                    factory_calls.append(kwargs)
                    return Runner(kwargs["inference_cfg"] or config["inference"])
                def write_predictions(**kwargs):
                    values = np.stack([p["bodyparts"][0] for p in kwargs["predictions"]])
                    columns = pd.MultiIndex.from_product([["fixture"], ["animal0"], keys, ["x", "y", "likelihood"]])
                    result = pd.DataFrame(values.reshape(len(values), -1), columns=columns)
                    result.to_csv(kwargs["output_path"] / "pose_raw.csv")
                    (kwargs["output_path"] / "pose_raw.h5").write_bytes(b"SDK-H5-simulated")
                    return result
                pipeline["PoseConfig"] = types.SimpleNamespace(from_any=lambda _: config)
                pipeline["pep"] = types.SimpleNamespace(
                    get_pose_inference_runner=factory, VideoIterator=Iterator,
                    video_inference=lambda **kwargs: kwargs["pose_runner"].inference(kwargs["video"]))
                pipeline["create_df_from_prediction"] = write_predictions
                result = pipeline["pose_dataframe"]("fixture", contexts, 4)
                self.assertEqual(len(result), 4)
                np.testing.assert_array_equal(result.iloc[:, 0], [i if present else -1 for i, present in enumerate(visible)])
                self.assertEqual(config, original_config)
                self.assertEqual(factory_calls[0]["inference_cfg"]["autocast"], config["inference"]["autocast"])
                self.assertEqual(factory_calls[0]["batch_size"], 2)
                self.assertEqual(pipeline["POSE_RUNNER"].settings["multithreading"]["queue_length"], 4)
                # Existing local/legacy policies still use their model settings.
                pipeline["OFT_PRECISION"] = False
                with self.assertRaisesRegex(RuntimeError, "alinhamento temporal"):
                    pipeline["pose_dataframe"]("fixture", contexts, 5)
                self.assertIsNone(factory_calls[-1]["inference_cfg"])

    def test_visual_recovery_keeps_source_and_cannot_be_exported_as_valid_neural_pose(self):
        for recovery_source in ("optical_flow", "temporal_tracker"):
            with self.subTest(source=recovery_source):
                with tempfile.TemporaryDirectory() as tmp:
                    pipeline = load_pipeline(Path(tmp))
                    pipeline["OUTPUT"].mkdir()
                    pipeline["KEYPOINTS"] = ["mouse_center"]
                    columns = pd.MultiIndex.from_product([["fixture"], ["animal_1"], ["mouse_center"], ["x", "y", "likelihood"]])
                    pose = pd.DataFrame([[50, 50, .9]], columns=columns)
                    box = {"observed": True, "x": 0, "y": 0, "w": 100, "h": 100}
                    refinement = {"accepted": np.array([[True]]), "reasons": np.array([["visual_recovery_pending_review"]]),
                                  "sources": np.array([[recovery_source]]), "policy": {"version": "pose-consensus-flow-2"},
                                  "original": np.array([[[-1., -1., 0.]]]), "original_reasons": np.array([["view_disagreement"]])}
                    pipeline["export_canonical"](pose, [box], 16, 100, 100, refinement)
                    with (Path(tmp)/"result.csv").open() as handle:
                        row = next(csv.DictReader(handle))
                    self.assertEqual(row["source"], "recovered")
                    self.assertEqual(row["status"], "low_confidence")
                    self.assertEqual(row["tracking_accepted"], "true")
                    self.assertEqual(row["tracking_reason"], "visual_recovery_pending_review")
                    self.assertEqual(row["raw_status"], "missing")
                    self.assertEqual(row["raw_x_px"], "")
                    self.assertEqual(row["raw_source"], "detected")

    def test_estimates_cannot_contribute_to_filtered_neural_measurements(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pipeline = load_pipeline(root)
            pipeline["OUTPUT"].mkdir()
            pipeline["KEYPOINTS"] = ["mouse_center"]
            columns = pd.MultiIndex.from_product([["fixture"], ["animal_1"], ["mouse_center"], ["x", "y", "likelihood"]])
            pose = pd.DataFrame([[10, 10, .9], [20, 20, .9], [150, 150, .9], [30, 30, .9], [40, 40, .9]], columns=columns)
            boxes = [{"observed": True, "x": 0, "y": 0, "w": 200, "h": 200} for _ in range(5)]
            refinement = {"accepted": np.ones((5, 1), bool), "reasons": np.full((5, 1), "", object),
                          "sources": np.array([["neural"], ["neural"], ["temporal_tracker"], ["neural"], ["neural"]])}
            pipeline["export_quality_and_filtered"](pose, boxes, 16., refinement)
            rows = pd.read_csv(pipeline["OUTPUT"]/"pose_filtered.csv")
            # At frame 1, the measured median is 20; including the estimate
            # would incorrectly change it to 25 and still label it valid.
            self.assertEqual(rows.iloc[1]["filtered_x_px"], 20)
            self.assertEqual(rows.iloc[1]["filtered_status"], "valid")
            self.assertEqual(rows.iloc[2]["filtered_x_px"], 150)
            self.assertEqual(rows.iloc[2]["filtered_status"], "low_confidence")
            self.assertEqual(rows.iloc[2]["source"], "recovered")

    def test_detector_retries_same_frame_without_skipping_or_reusing_old_boxes(self):
        with tempfile.TemporaryDirectory() as tmp:
            pipeline = load_pipeline(Path(tmp))
            pipeline["OUTPUT"].mkdir()
            class Tensor:
                def __init__(self, value): self.value = value
                def to(self, _): return self
                def detach(self): return self
                def cpu(self): return self
                def numpy(self): return np.asarray(self.value)
            class Capture:
                def isOpened(self): return True
                def __init__(self, _): self.index = 0
                def get(self, prop):
                    return {cv2.CAP_PROP_FRAME_WIDTH: 100, cv2.CAP_PROP_FRAME_HEIGHT: 100,
                            cv2.CAP_PROP_FPS: 16., cv2.CAP_PROP_FRAME_COUNT: 3}[prop]
                def read(self):
                    index = self.index
                    self.index += 1
                    return (True, np.full((100, 100, 3), index, np.uint8)) if index < 3 else (False, None)
                def set(self, *_): raise AssertionError("Recuperação não deve buscar outro quadro")
                def release(self): pass
            class Model:
                transform = types.SimpleNamespace(min_size=(640,), max_size=1280)
                calls = []
                def __call__(self, batch):
                    self.calls.append((self.transform.min_size[0], [item.value for item in batch]))
                    return [{"scores": [.99 if item.value == 0 or item.value == 1 and self.transform.min_size[0] == 1280 else .1],
                             "labels": [1], "boxes": [Tensor([10+item.value, 10, 30+item.value, 30])]} for item in batch]
            model = Model()
            pipeline["detector"] = lambda: model
            pipeline["to_tensor"] = lambda image: Tensor(int(image[0, 0, 0]))
            pipeline["torch"].inference_mode = contextlib.nullcontext
            pipeline["torch"].cuda = types.SimpleNamespace(
                get_device_properties=lambda _: types.SimpleNamespace(total_memory=40*1024**3),
                get_device_name=lambda _: "simulated-GPU", empty_cache=lambda: None, synchronize=lambda: None)
            with patch.object(cv2, "VideoCapture", Capture), contextlib.redirect_stdout(io.StringIO()):
                rows, contexts, count, *_ = pipeline["run_detector"]("fake", np.full((100, 100), 255, np.uint8))
            self.assertEqual(count, 3)
            self.assertEqual(model.calls, [(640, [0, 1, 2]), (960, [1]), (1280, [1]), (960, [2]), (1280, [2])])
            self.assertEqual(model.transform.min_size, (640,))
            self.assertEqual(model.transform.max_size, 1280)
            self.assertEqual([r["observed"] for r in rows], [True, True, False])
            self.assertEqual(rows[1]["raw_x1"], 11)
            self.assertEqual(rows[1]["detector_scale"], 1280)
            self.assertEqual(contexts[2]["bboxes"].shape, (0, 4))
            self.assertEqual(len(json.loads(rows[1]["candidate_audit"])["retries"]), 3)
            self.assertEqual(len(json.loads(rows[2]["candidate_audit"])["retries"]), 3)
            self.assertTrue(all(a["mask"]=="visible_arena" for a in json.loads(rows[1]["candidate_audit"])["retries"]))

    def test_visible_wall_pixels_are_preserved_and_exclusions_stay_excluded(self):
        def quad(low, high):
            return [{"x":low,"y":low},{"x":high,"y":low},{"x":high,"y":high},{"x":low,"y":high}]
        arena = {"cornersPx": quad(40, 60), "rimCornersPx": quad(10, 90), "occlusionPolygonsPx": [quad(70, 80)]}
        with tempfile.TemporaryDirectory() as tmp:
            pipeline = load_pipeline(Path(tmp))
            mask = pipeline["arena_mask"](100, 100, arena)
            self.assertEqual(mask[20, 20], 255)
            self.assertEqual(mask[50, 50], 255)
            self.assertEqual(mask[5, 5], 0)
            self.assertEqual(mask[75, 75], 0)
            floor = pipeline["arena_mask"](100, 100, arena, include_walls=False)
            self.assertEqual(floor[20, 20], 0)
            self.assertEqual(floor[50, 50], 255)
            pipeline["OFT_PRECISION"]=False # Local Wistar must also see walls.
            self.assertEqual(pipeline["arena_mask"](100,100,arena)[20,20],255)
            self.assertEqual(pipeline["arena_mask"](100,100,{"cornersPx":arena["cornersPx"]})[20,20],255)

    def test_detector_retries_retain_animal_pixels_above_the_metric_floor(self):
        # Exercise the actual tensor preparation in the prior retry test with
        # a mask that contains a visible wall. Each inference must see it.
        with tempfile.TemporaryDirectory() as tmp:
            pipeline=load_pipeline(Path(tmp))
            pipeline["OUTPUT"].mkdir()
            pipeline["ARENA"]={"cornersPx":[{"x":20,"y":50},{"x":80,"y":50},{"x":80,"y":90},{"x":20,"y":90}],
                               "rimCornersPx":[{"x":10,"y":10},{"x":90,"y":10},{"x":90,"y":95},{"x":10,"y":95}]}
            class Tensor:
                def __init__(self,value):self.value=value
                def to(self,_):return self
            class Capture:
                def __init__(self,_):self.index=0
                def isOpened(self):return True
                def get(self,key):return {cv2.CAP_PROP_FRAME_WIDTH:100,cv2.CAP_PROP_FRAME_HEIGHT:100,cv2.CAP_PROP_FPS:20,cv2.CAP_PROP_FRAME_COUNT:1}[key]
                def read(self):
                    self.index+=1
                    return (True,np.full((100,100,3),200,np.uint8)) if self.index==1 else (False,None)
                def release(self):pass
            class Model:
                transform=types.SimpleNamespace(min_size=(640,),max_size=1280)
                def __call__(self,batch):
                    for tensor in batch:self_test.assertTrue((tensor.value[25,50]==200).all())
                    return [{"scores":[],"labels":[],"boxes":[]} for _ in batch]
            self_test=self
            pipeline["detector"]=Model
            pipeline["to_tensor"]=Tensor
            pipeline["torch"].inference_mode=contextlib.nullcontext
            pipeline["DEVICE"]=types.SimpleNamespace(type="cpu")
            with patch.object(cv2,"VideoCapture",Capture),contextlib.redirect_stdout(io.StringIO()):
                rows,*_=pipeline["run_detector"]("fake",pipeline["arena_mask"](100,100,pipeline["ARENA"]))
            self.assertFalse(rows[0]["observed"])
            self.assertEqual(len(json.loads(rows[0]["candidate_audit"])["retries"]),3)

    def test_detector_oom_retry_preserves_frame_alignment_and_reduces_batch(self):
        with tempfile.TemporaryDirectory() as tmp:
            pipeline = load_pipeline(Path(tmp))
            pipeline["OUTPUT"].mkdir()
            class Tensor:
                def __init__(self, value): self.value = value
                def to(self, _): return self
                def detach(self): return self
                def cpu(self): return self
                def numpy(self): return np.asarray(self.value)
            class Capture:
                def isOpened(self): return True
                def __init__(self, _): self.index = 0
                def get(self, prop):
                    return {cv2.CAP_PROP_FRAME_WIDTH: 100, cv2.CAP_PROP_FRAME_HEIGHT: 100,
                            cv2.CAP_PROP_FPS: 16., cv2.CAP_PROP_FRAME_COUNT: 7}[prop]
                def read(self):
                    index = self.index
                    self.index += 1
                    return (True, np.full((100, 100, 3), index, np.uint8)) if index < 7 else (False, None)
                def set(self, prop, index):
                    self.index = index
                    return True
                def release(self): pass
            calls = []
            def model(batch):
                calls.append(len(batch))
                if len(calls) == 1:
                    raise RuntimeError("CUDA out of memory")
                return [{"scores": [.99], "labels": [1], "boxes": [Tensor([10+item.value, 10, 30+item.value, 30])]} for item in batch]
            pipeline["detector"] = lambda: model
            pipeline["to_tensor"] = lambda image: Tensor(int(image[0, 0, 0]))
            pipeline["torch"].inference_mode = contextlib.nullcontext
            pipeline["torch"].cuda = types.SimpleNamespace(
                get_device_properties=lambda _: types.SimpleNamespace(total_memory=40*1024**3),
                get_device_name=lambda _: "simulated-GPU", empty_cache=lambda: None, synchronize=lambda: None)
            with patch.object(cv2, "VideoCapture", Capture), contextlib.redirect_stdout(io.StringIO()):
                rows, contexts, count, *_ = pipeline["run_detector"]("fake", np.full((100, 100), 255, np.uint8))
            self.assertEqual(calls, [4, 2, 2, 2, 1])
            self.assertEqual(count, 7)
            self.assertEqual([row["frame"] for row in rows], list(range(7)))
            self.assertEqual([row["raw_x1"] for row in rows], list(range(10, 17)))
            self.assertEqual(pipeline["LAST_DETECTOR_BATCH_SIZE"], 2)
            self.assertEqual(len(contexts), 7)

    def test_recovered_coordinates_are_exported_with_their_raw_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pipeline = load_pipeline(root)
            pipeline["OUTPUT"].mkdir()
            pipeline["KEYPOINTS"] = ["mouse_center"]
            columns = pd.MultiIndex.from_product([["fixture"], ["animal_1"], ["mouse_center"], ["x", "y", "likelihood"]])
            raw = pd.DataFrame([[50, 50, .2]], columns=columns)
            box = {"observed": True, "x": 0, "y": 0, "w": 100, "h": 100}
            class Capture:
                def isOpened(self): return True
                def __init__(self, _): self.index = 0
                def isOpened(self): return True
                def get(self, _): return 100
                def release(self): pass
                def read(self):
                    self.index += 1
                    return (True, np.zeros((100, 100, 3), np.uint8)) if self.index == 1 else (False, None)
            class Runner:
                def inference(self, items):
                    result = []
                    for (image, _), turns in zip(items, [1, 2, 3, 0]):
                        side = image.shape[0]
                        origin = int(np.floor(50-side/2))
                        marker = np.zeros((side, side), np.uint8)
                        marker[50-origin, 60-origin] = 1
                        y, x = np.argwhere(np.rot90(marker, turns))[0]
                        result.append({"bodyparts": np.array([[[x, y, .8]]])})
                    return result
            pipeline["POSE_RUNNER"] = Runner()
            with patch.object(cv2, "VideoCapture", Capture), contextlib.redirect_stdout(io.StringIO()):
                selected, refinement = pipeline["refine_pose"](raw, [box], 16.)
            pipeline["export_canonical"](selected, [box], 16., 100, 100, refinement=refinement)
            pipeline["export_quality_and_filtered"](selected, [box], 16., refinement=refinement, raw_df=raw)
            with (root / "result.csv").open() as handle:
                row = next(csv.DictReader(handle))
            self.assertEqual(float(row["x_px"]), 60)
            self.assertEqual(row["tracking_accepted"], "true")
            self.assertEqual(row["status"], "valid")
            self.assertEqual(float(raw.iloc[0, 0]), 50)
            audit = pd.read_csv(root / "output/pose_refinement.csv").iloc[0]
            self.assertEqual(audit["raw_x_px"], 50)
            self.assertEqual(audit["selected_x_px"], 60)
            self.assertEqual(audit["agreeing_views"], 4)
            self.assertEqual(audit["selected_likelihood"], .8)
            filtered = pd.read_csv(root / "output/pose_filtered.csv").iloc[0]
            self.assertEqual(filtered["raw_likelihood"], .2)
            self.assertEqual(filtered["likelihood"], .8)

    def test_end_to_end_quality_export_preserves_raw_and_rejects_disagreement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pipeline = load_pipeline(root)
            # Keep the legacy 27-point export covered independently of the new
            # default box -> silhouette layers, tested in test_oft_layers.
            pipeline["LAYERED_OFT"] = False
            pipeline["torch"].__version__ = "simulated"
            pipeline["version"] = lambda _: "3.0.2-simulated"
            pipeline["VIDEO"] = str(root / "video.mp4")
            (root / "video.mp4").write_bytes(b"decoded-by-fixture")
            keys = ["mouse_center", "nose", "neck", "tail_base"]
            columns = pd.MultiIndex.from_product([["fixture"], ["animal_1"], keys, ["x", "y", "likelihood"]])
            raw = pd.DataFrame([[50, 50, .99, 25, 20, .99, 40, 30, .99, 80, 80, .99]], columns=columns)
            untouched = raw.copy(deep=True)
            box = {"observed": True, "x": 0, "y": 0, "w": 100, "h": 100, "score": .99}
            class Capture:
                def isOpened(self): return True
                def __init__(self, _): self.index = 0
                def get(self, prop): return 100
                def release(self): pass
                def read(self):
                    self.index += 1
                    return (True, np.zeros((100, 100, 3), np.uint8)) if self.index == 1 else (False, None)
            class Runner:
                def inference(self, items):
                    self.calls = len(items)
                    return [{"bodyparts": np.full((1, len(keys), 3), -1.)} for _ in items]
            runner = Runner()
            def pose_dataframe(*_):
                pipeline["KEYPOINTS"] = keys
                pipeline["POSE_RUNNER"] = runner
                raw.to_csv(pipeline["OUTPUT"] / "pose_raw.csv")
                (pipeline["OUTPUT"] / "pose_raw.h5").write_bytes(b"raw-h5-fixture")
                return raw
            pipeline["pose_dataframe"] = pose_dataframe
            pipeline["run_detector"] = lambda *_: ([box], [], 1, 16., 100, 100)
            with patch.object(cv2, "VideoCapture", Capture), contextlib.redirect_stdout(io.StringIO()):
                pipeline["main"]()
            pd.testing.assert_frame_equal(raw, untouched)
            self.assertEqual(runner.calls, 4)
            with (root / "result.csv").open() as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), len(keys))
            self.assertTrue(all(row["tracking_accepted"] == "false" for row in rows))
            self.assertTrue(all(row["status"] == "low_confidence" for row in rows))
            self.assertTrue(all(row["tracking_reason"] == "view_disagreement" for row in rows))
            quality = pd.read_csv(root / "output/qc_by_frame.csv")
            self.assertIn("centro_nao_confiavel", quality.iloc[0]["quality_flags"])
            filtered = pd.read_csv(root / "output/pose_filtered.csv")
            self.assertTrue(filtered["filtered_x_px"].isna().all())
            self.assertEqual(filtered.iloc[0]["raw_x_px"], 50)
            manifest = json.loads((root / "output/run_manifest.json").read_text())
            self.assertEqual(manifest["pipelineVersion"], "hybrid-df-precision-6")
            self.assets.assert_called_once_with(root/"models")
            self.temporal.assert_called_once()
            self.assertEqual(manifest["poseRefinement"]["temporal"]["version"], "simulated-temporal")
            self.assertEqual(manifest["poseRefinement"]["acceptedCenterFrames"], 0)
            self.assertFalse(manifest["poseRefinement"]["scientificallyValidated"])
            self.assertTrue((root / "output/pose_refinement.csv").is_file())
            self.assertEqual((root / "output/pose_raw.h5").read_bytes(), b"raw-h5-fixture")
            self.assertTrue((root / "output/canonical_pose.csv.complete").is_file())

    def test_precision_is_scoped_to_colab_open_field_v2(self):
        for bundle, local, enabled in [("wistar_df_v2", False, True), ("wistar_df_v1", False, False),
                                       ("wistar_df_v2", True, False)]:
            with tempfile.TemporaryDirectory() as tmp:
                self.assertEqual(load_pipeline(Path(tmp), bundle, local)["OFT_PRECISION"], enabled)
        # RAM explicitly turns the shared OFT policy off before detector use.
        tree = ast.parse((Path(__file__).parent / "ram_pipeline.py").read_text())
        run = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "run")
        assignment = next(node for node in run.body if isinstance(node, ast.Assign)
                          and ast.unparse(node.targets[0]) == "hybrid.OFT_PRECISION")
        self.assertIs(assignment.value.value, False)
        detector = next(node for node in ast.walk(run) if isinstance(node, ast.Call)
                        and ast.unparse(node.func) == "hybrid.run_detector")
        self.assertLess(assignment.lineno, detector.lineno)


if __name__ == "__main__":
    unittest.main()
