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
        return {5: 24, 3: 1000, 4: 1000}[prop]

    def release(self):
        pass

    def set(self, prop, frame):
        assert prop == 1 and frame in (2, 3)

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
    destination = Path(kwargs["dest_folder"])
    (destination / "raw.h5").write_bytes(b"raw sentinel -1 must remain")


sys.modules["cv2"] = types.SimpleNamespace(VideoCapture=Capture, CAP_PROP_FPS=5,
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
assert (float(partial["x_px"]), float(partial["y_px"])) == (400, 400), partial
assert partial["status"] == "low_confidence" and partial["support_count"] == "1" and partial["support_total"] == "2", partial
nose = lookup[1, "nose"]
assert (float(nose["x_px"]), float(nose["y_px"])) == (200, 150), nose
assert nose["spatial_region"] == "wall_projection" and nose["status"] == "valid", nose
assert lookup[1, "left_ear"]["x_px"] == ""
assert lookup[2, "body_center"]["status"] == "valid"
assert float(lookup[2, "body_center"]["timestamp_sec"]) == 2 / 24
recovered = lookup[3, "body_center"]
assert recovered["source"] == "recovered", recovered
assert recovered["raw_x_px"] == "" and recovered["raw_status"] == "missing", recovered
assert recovered["raw_support_count"] == "0" and recovered["support_count"] == "2", recovered
assert (float(recovered["x_px"]), float(recovered["y_px"])) == (410, 410), recovered
assert recovered["recovery_state"] == "ready", recovered
geometry = json.loads((root / "output" / "arena_geometry.json").read_text())
assert geometry["cropping"] == [120, 780, 65, 835]
assert geometry["postureClassification"] == "not_performed"
assert geometry["recoveryPolicy"]["version"] == "visual-recovery-1"
assert (root / "output" / "raw.h5").read_bytes() == b"raw sentinel -1 must remain"
assert (root / "canonical.csv.complete").is_file()
print("INFERENCE_CONTRACT_OK")
