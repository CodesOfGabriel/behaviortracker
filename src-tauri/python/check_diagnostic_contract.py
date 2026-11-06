"""Contratos do Python gerado pelo Rust. Sem rede, GPU, NumPy ou DLC real."""
import csv
import json
from pathlib import Path
import sys
import types

root = Path(sys.argv[1])
names = ["nose", "mid_back", "hip"]


class Image:
    def __init__(self, index): self.index = index
    def __getitem__(self, crop):
        assert crop == (slice(65,835),slice(120,780))
        return self


class Capture:
    def __init__(self, _): self.index = 0
    def get(self, prop): return {5:24,3:1000,4:1000}[prop]
    def read(self):
        self.index += 1
        return (True, Image(self.index-1)) if self.index <= 5 else (False, None)
    def release(self): pass


class Array(list):
    shape = (1,3,3)
    def tolist(self): return list(self)


detector_batches, pose_batches = [], []
class Detector:
    def inference(self, images):
        detector_batches.append(len(images))
        return [{"bboxes": [] if image.index == 0 else [[10,20,300,400]], "bbox_scores": [] if image.index == 0 else [.9]} for image in images]


class Pose:
    def inference(self, images):
        pose_batches.append(len(images))
        result = []
        for image, context in images:
            assert context["bboxes"] == [[10,20,300,400]]
            points = [(-1,-1,-1)]*3 if image.index == 1 else [(20,30,.9),(-1,-1,-1),(-1,-1,-1)] if image.index == 2 else [(20,30,.9),(30,40,.9),(40,50,.4 if image.index == 4 else .9)]
            result.append({"bodyparts": Array([points])})
        return result


def runners(config, **kwargs):
    assert kwargs["batch_size"] == kwargs["detector_batch_size"] == 2
    assert kwargs["max_individuals"] == 1
    return Pose(), Detector()


sys.modules["cv2"] = types.SimpleNamespace(VideoCapture=Capture, CAP_PROP_FPS=5, CAP_PROP_FRAME_WIDTH=3, CAP_PROP_FRAME_HEIGHT=4, COLOR_BGR2RGB=4,cvtColor=lambda image, _: image)
sys.modules["numpy"] = types.SimpleNamespace(array=lambda values, **_: values, full=lambda shape, value: Array([[(value,value,value)]*shape[1]]))
sys.modules["torch"] = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda:True,synchronize=lambda:None))
sys.modules["deeplabcut.pose_estimation_pytorch.config.pose"] = types.SimpleNamespace(PoseConfig=types.SimpleNamespace(build_for_superanimal_inference=lambda **_: {"metadata":{"bodyparts":names}}))
sys.modules["deeplabcut.pose_estimation_pytorch.apis.utils"] = types.SimpleNamespace(get_inference_runners=runners)
sys.modules["deeplabcut.pose_estimation_pytorch.modelzoo.utils"] = types.SimpleNamespace(get_super_animal_snapshot_path=lambda *_:"cached.pt")
source = sys.stdin.read()
exec(compile(source,"<generated-diagnostic>","exec"),{})
report = json.loads((root / "output/diagnostic_report.json").read_text())
assert [frame["state"] for frame in report["frames"]] == ["detector_missing","pose_missing","center_missing","points_available","partial"]
assert report["frames"][2]["bbox"]["x"] == 130
assert report["frames"][2]["bbox"]["y"] == 85
assert report["selection"] == {"startSec":1.,"endSec":2.}
assert report["summary"]["detectorCoveragePct"] == 80
assert report["summary"]["centerCoveragePct"] == 40
assert report["summary"]["accuracyMeasured"] is False
assert report["recoveryEnabled"] is report["videoAdaptEnabled"] is False
assert detector_batches == [2,2,1]
assert pose_batches == [1,2,1]
assert set(report["timings"]) == {"decodeSec","modelLoadSec","detectorSec","poseSec","exportSec","totalSec"}
with (root/"canonical.csv").open() as handle: rows=list(csv.DictReader(handle))
assert len(rows)==15
assert float(rows[6]["x_px"])==140 and float(rows[6]["y_px"])==95
assert not any(row["keypoint"] == "body_center" for row in rows), "Derived centers must not be presented as raw bodyparts"
exec(compile(source,"<replayed-diagnostic>","exec"),{})
assert detector_batches == [2,2,1], "Confirmed diagnostic must not run twice"
print("DIAGNOSTIC_CONTRACT_OK")
