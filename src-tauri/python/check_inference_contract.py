"""Executado pelo teste Rust com modelos/dados falsos; não importa DeepLabCut real."""

import csv
import json
from pathlib import Path
import sys
import types


root = Path(sys.argv[1])


class Series:
    def __init__(self, values):
        self.iloc = values


class MultiIndex(list):
    pass


class Poses:
    def __init__(self):
        self.columns = MultiIndex()
        self.index = [0, 1, 2]
        self.values = {}
        bodyparts = {"mid_back": (280, 335, .9), "hip": (300, 355, .9),
                     "nose": (80, 85, .8), "tail_base": (300, 350, .95),
                     "left_ear": (90, 90, .8), "right_ear": (95, 95, .8)}
        for bodypart, values in bodyparts.items():
            for coord_index, coordinate in enumerate(("x", "y", "likelihood")):
                key = ("scorer", "animal_0", bodypart, coordinate)
                self.columns.append(key)
                middle = values[coord_index] if bodypart in ("mid_back", "nose", "tail_base") else -1
                self.values[key] = Series([-1, middle, values[coord_index]])

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


def inference(**kwargs):
    assert kwargs["cropping"] == [120, 780, 65, 835], kwargs
    assert kwargs["max_individuals"] == 1
    destination = Path(kwargs["dest_folder"])
    (destination / "raw.h5").write_bytes(b"raw sentinel -1 must remain")


sys.modules["cv2"] = types.SimpleNamespace(VideoCapture=Capture, CAP_PROP_FPS=5,
                                           CAP_PROP_FRAME_WIDTH=3, CAP_PROP_FRAME_HEIGHT=4)
sys.modules["pandas"] = types.SimpleNamespace(MultiIndex=MultiIndex, read_hdf=lambda _: Poses(), DataFrame=Canonical)
for name in ("deeplabcut", "deeplabcut.modelzoo", "deeplabcut.modelzoo.video_inference"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["deeplabcut.modelzoo.video_inference"].video_inference_superanimal = inference
exec(compile(sys.stdin.read(), "<generated-inference>", "exec"), {})

with (root / "canonical.csv").open() as handle:
    rows = list(csv.DictReader(handle))
assert len(rows) == 15
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
geometry = json.loads((root / "output" / "arena_geometry.json").read_text())
assert geometry["cropping"] == [120, 780, 65, 835]
assert geometry["postureClassification"] == "not_performed"
assert (root / "output" / "raw.h5").read_bytes() == b"raw sentinel -1 must remain"
assert (root / "canonical.csv.complete").is_file()
print("INFERENCE_CONTRACT_OK")
