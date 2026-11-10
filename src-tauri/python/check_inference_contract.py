"""Executado pelo teste Rust com modelos/dados falsos; não importa DeepLabCut real."""

import csv
import json
from pathlib import Path
import sys
import types


root = Path(sys.argv[1])
BODY_PARTS = {"mid_back": (280, 335, .9), "hip": (300, 355, .9),
              "nose": (80, 85, .8), "tail_base": (300, 350, .95),
              "left_ear": (90, 90, .8), "right_ear": (95, 95, .8)}


class Series:
    def __init__(self, values):
        self.iloc = values


class MultiIndex(list):
    pass


class Poses:
    def __init__(self):
        self.columns = MultiIndex()
        self.index = [0, 1, 2, 3]
        self.values = {}
        bodyparts = BODY_PARTS
        for bodypart, values in bodyparts.items():
            for coord_index, coordinate in enumerate(("x", "y", "likelihood")):
                key = ("scorer", "animal_0", bodypart, coordinate)
                self.columns.append(key)
                middle = values[coord_index] if bodypart in ("mid_back", "nose", "tail_base") else -1
                self.values[key] = Series([-1, middle, values[coord_index], -1])

    def __getitem__(self, key):
        return self.values[key]


class Canonical:
    def __init__(self, rows, columns):
        self.rows, self.columns = rows, columns

    def to_csv(self, path, index=False):
        assert index is False
        with open(path, "w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(self.columns)
            writer.writerows(self.rows)

    def __len__(self):
        return len(self.rows)


class Capture:
    def __init__(self, _):
        pass

    def get(self, prop):
        return {5: 24, 3: 1000, 4: 1000, 7: 4}[prop]

    def release(self):
        pass

    def grab(self):
        return True

    def read(self):
        return True, Image()


class Image:
    def __getitem__(self, slices):
        assert slices == (slice(65, 835), slice(120, 780)), slices
        return self


class Points(list):
    shape = (1, len(BODY_PARTS), 3)


class Runner:
    def inference(self, images):
        image, context = images[0]
        assert image == "RGB"
        assert len(context["bboxes"]) == 1 and len(context["bboxes"][0]) == 4
        return [{"bodyparts": Points([list(BODY_PARTS.values())])}]


def inference(**kwargs):
    assert kwargs["cropping"] == [120, 780, 65, 835], kwargs
    assert kwargs["max_individuals"] == 1
    assert kwargs["video_adapt"] is True
    assert kwargs["batch_size"] == 4 and kwargs["detector_batch_size"] == 2
    assert kwargs["device"] == "cuda:0" and kwargs["pcutoff"] == .05
    assert kwargs["pseudo_threshold"] == .1 and kwargs["bbox_threshold"] == .9
    assert kwargs["detector_epochs"] == kwargs["pose_epochs"] == 1
    destination = Path(kwargs["dest_folder"])
    (destination / "raw.h5").write_bytes(b"raw sentinel -1 must remain")
    (destination / "snapshot-hrnet-001.h5").write_bytes(b"adapted sentinel")


sys.modules["cv2"] = types.SimpleNamespace(VideoCapture=Capture, CAP_PROP_FPS=5, CAP_PROP_FRAME_COUNT=7,
    CAP_PROP_FRAME_WIDTH=3, CAP_PROP_FRAME_HEIGHT=4, CAP_PROP_POS_FRAMES=1,
    COLOR_BGR2RGB=4, cvtColor=lambda image, mode: "RGB")
sys.modules["pandas"] = types.SimpleNamespace(MultiIndex=MultiIndex, read_hdf=lambda _: Poses(), DataFrame=Canonical)
sys.modules["numpy"] = types.SimpleNamespace(array=lambda values, **_: values)
sys.modules["torch"] = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True))
sys.modules["deeplabcut.pose_estimation_pytorch.apis.utils"] = types.SimpleNamespace(get_pose_inference_runner=lambda *_, **kwargs: Runner())
sys.modules["deeplabcut.pose_estimation_pytorch.modelzoo.utils"] = types.SimpleNamespace(get_super_animal_snapshot_path=lambda *_, **kwargs: "cached.pt")
sys.modules["deeplabcut.pose_estimation_pytorch.config.pose"] = types.SimpleNamespace(PoseConfig=types.SimpleNamespace(
    build_for_superanimal_inference=lambda **_: {"metadata": {"bodyparts": list(BODY_PARTS)}}))
for name in ("deeplabcut", "deeplabcut.modelzoo", "deeplabcut.modelzoo.video_inference"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["deeplabcut.modelzoo.video_inference"].video_inference_superanimal = inference
exec(compile(sys.stdin.read(), "<generated-inference>", "exec"), {})

with (root / "canonical.csv").open() as handle:
    rows = list(csv.DictReader(handle))
assert len(rows) == 20
lookup = {(int(row["frame_index"]), row["keypoint"]): row for row in rows}
assert lookup[0, "body_center"]["x_px"] == ""
assert lookup[0, "body_center"]["likelihood"] == "0.0"
partial = lookup[1, "body_center"]
assert (float(partial["x_px"]), float(partial["y_px"])) == (410, 407.5), partial
assert partial["status"] == "valid" and partial["support_count"] == "2" and partial["support_total"] == "3", partial
nose = lookup[1, "nose"]
assert (float(nose["x_px"]), float(nose["y_px"])) == (200, 150), nose
assert nose["spatial_region"] == "wall_projection" and nose["status"] == "valid", nose
assert lookup[1, "left_ear"]["x_px"] == ""
assert lookup[2, "body_center"]["status"] == "valid"
assert float(lookup[2, "body_center"]["timestamp_sec"]) == 2 / 24
recovered = lookup[3, "body_center"]
assert recovered["source"] == "recovered", recovered
assert recovered["raw_x_px"] == "" and recovered["raw_status"] == "missing", recovered
assert recovered["raw_support_count"] == "0" and recovered["support_count"] == "3", recovered
assert abs(float(recovered["x_px"]) - 413.3333333333) < 1e-6, recovered
assert abs(float(recovered["y_px"]) - 411.6666666667) < 1e-6, recovered
assert recovered["recovery_state"] == "ready", recovered
geometry = json.loads((root / "output" / "arena_geometry.json").read_text())
assert geometry["cropping"] == [120, 780, 65, 835]
assert geometry["postureClassification"] == "not_performed"
assert geometry["recoveryPolicy"]["version"] == "visual-recovery-2"
assert geometry["trajectoryPostprocessPolicy"]["version"] == "dlc-adapted-trajectory-c-1"
assert all(row["processing_version"] == "dlc-adapted-trajectory-c-1" for row in rows)
assert partial["raw_x_px"] == partial["x_px"] and partial["raw_y_px"] == partial["y_px"]
assert (root / "output" / "raw.h5").read_bytes() == b"raw sentinel -1 must remain"
assert json.loads((root / "output" / "render_request.json").read_text())["h5"].endswith("snapshot-hrnet-001.h5")
assert (root / "canonical.csv.complete").is_file()
assert (root / "output" / "render_request.json").is_file()
assert not (root / "output" / "video_artifact.json").is_file(), "Video rendering must run after poses are available"
profile = json.loads((root / "output" / "analysis_profile.json").read_text())
assert profile["recoveryAttempts"] == 1
assert profile["recoverySec"] > 0
assert profile["postprocessVersion"] == "dlc-adapted-trajectory-c-1"
assert profile["postprocessStats"]["rejectedStatistical"] == 0
print("INFERENCE_CONTRACT_OK")
