import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import custom_model as custom
import arena
import csv


def record(index=0,split="train",video="video",animal="rat"):
    return {"id":str(index),"videoSha256":video,"subjectId":animal,"frameIndex":index,"reviewed":True,"split":split,
            "width":100,"height":100,"bbox":{"x":10,"y":10,"width":80,"height":80},
            "keypoints":{name:{"state":"visible","x":20,"y":30} if name=="nose" else {"state":"occluded","x":None,"y":None} for name in custom.LANDMARKS}}


class CustomModelTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory(prefix="behavetracker-custom-test-")
        self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name)
        self.image=b"\x89PNG\r\n\x1a\nsynthetic-contract-not-a-real-image"

    def dataset(self,records):
        path=self.root/"dataset.jsonl"
        with path.open("w") as handle:
            handle.write(json.dumps({"schemaVersion":1,"landmarks":custom.LANDMARKS,"frameCount":len(records),"snapshotId":"snapshot"})+"\n")
            for value in records:
                value=copy.deepcopy(value);value["imageSha256"]=hashlib.sha256(self.image).hexdigest()
                handle.write(json.dumps({"annotation":value,"imageBase64":base64.b64encode(self.image).decode()})+"\n")
        return path

    def test_occluded_points_are_ignored_not_assigned_fake_locations(self):
        boxes,points=custom.target_values(record())
        self.assertEqual(boxes,[[10,10,90,90]])
        self.assertEqual(points[0][0],[20,30,2])
        self.assertEqual(points[0][1],[0,0,0])

    def test_snapshot_rejects_video_and_animal_leakage_and_duplicate_frames(self):
        for third in [record(2,"validation"),record(2,"validation","different","rat"),record(0)]:
            with self.assertRaisesRegex(ValueError,"Vazamento|mesmo|Mesmo"):
                custom.load_dataset(self.dataset([record(0),record(1),third]),self.root/"images")

    def test_snapshot_rejects_unreviewed_and_invented_coordinates(self):
        bad=record(1);bad["reviewed"]=False
        with self.assertRaisesRegex(ValueError,"revisão"):custom.load_dataset(self.dataset([record(),bad]),self.root/"images")
        bad=record(1);bad["keypoints"]["hip"]["x"]=30
        with self.assertRaisesRegex(ValueError,"inventada"):custom.load_dataset(self.dataset([record(),bad]),self.root/"images")

    def test_snapshot_checks_hash_and_preserves_manual_labels(self):
        path=self.dataset([record(),record(1)])
        header,frames=custom.load_dataset(path,self.root/"images")
        self.assertEqual(header["snapshotId"],"snapshot")
        self.assertEqual(frames[0]["keypoints"],record()["keypoints"])
        body=path.read_text().replace(base64.b64encode(self.image).decode(),base64.b64encode(self.image+b"tampered").decode())
        path.write_text(body)
        with self.assertRaisesRegex(ValueError,"Integridade"):custom.load_dataset(path,self.root/"other")

    def test_loading_uses_tensor_only_checkpoint_and_rejects_wrong_schema(self):
        calls=[]
        class Model:
            def load_state_dict(self,state,strict):calls.append((state,strict))
            def to(self,device):return self
            def eval(self):return self
        checkpoint={"version":custom.VERSION,"landmarks":custom.LANDMARKS,"state_dict":{"weight":"sentinel"}}
        def load(path,**kwargs):self.assertTrue(kwargs["weights_only"]);return checkpoint
        with patch.dict("sys.modules",{"torch":types.SimpleNamespace(load=load)}),patch.object(custom,"build_model",return_value=Model()):
            custom.load_model("trusted.pt")
            self.assertEqual(calls,[({"weight":"sentinel"},True)])
            checkpoint["version"]="unknown"
            with self.assertRaises(ValueError):custom.load_model("wrong.pt")

    def test_train_contract_runs_epochs_saves_version_and_does_not_claim_validation(self):
        steps=[]
        class Tensor:
            requires_grad=True
            def float(self):return self
            def div(self,_):return self
            def to(self,_):return self
            def detach(self):return self
            def cpu(self):return self
        class Loss:
            def __radd__(self,other):return self
            def detach(self):return 1.
            def backward(self):steps.append("backward")
        class Model:
            def to(self,_):return self
            def parameters(self):return [Tensor()]
            def train(self):pass
            def eval(self):pass
            def __call__(self,images,targets):
                self_test.assertEqual(len(images),1);return {"loss":Loss()}
            def state_dict(self):return {"weights":Tensor()}
        class Optimizer:
            def __init__(self,*args,**kwargs):pass
            def zero_grad(self,**kwargs):pass
            def step(self):steps.append("step")
        class Image:
            size=(100,100)
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def convert(self,_):return self
        class Context:
            def __enter__(self):pass
            def __exit__(self,*args):pass
        self_test=self
        torch=types.SimpleNamespace(__version__="fake",cuda=types.SimpleNamespace(is_available=lambda:True,manual_seed_all=lambda _:None,get_device_name=lambda _:"FAKE GPU"),manual_seed=lambda _:None,device=lambda _:"cuda:0",tensor=lambda *a,**kw:Tensor(),ones=lambda *a,**kw:Tensor(),float32="float32",int64="int64",optim=types.SimpleNamespace(SGD=Optimizer),nn=types.SimpleNamespace(utils=types.SimpleNamespace(clip_grad_norm_=lambda *args:None)),inference_mode=Context,save=lambda value,path:Path(path).write_bytes(b"fake tensors"))
        modules={"torch":torch,"torchvision":types.SimpleNamespace(__version__="fake"),"PIL":types.SimpleNamespace(Image=types.SimpleNamespace(open=lambda _:Image())),"torchvision.transforms.functional":types.SimpleNamespace(pil_to_tensor=lambda _:Tensor())}
        with patch.dict("sys.modules",modules),patch.object(custom,"build_model",return_value=Model()):
            custom.train(self.dataset([record(),record(1)]),self.root/"output",2)
        self.assertEqual(steps.count("step"),4)
        report=json.loads((self.root/"output/training_report.json").read_text())
        self.assertFalse(report["scientificallyValidated"])
        self.assertFalse(report["behaviorClassifierTrained"])
        self.assertIsNone(report["metrics"])
        manifest=json.loads((self.root/"output/model_artifact.json").read_text())
        self.assertEqual(manifest["sha256"],hashlib.sha256(b"fake tensors").hexdigest())

    def test_custom_inference_preserves_missing_frames_and_does_not_invent_anatomical_confidence(self):
        class Tensor:
            def __init__(self,value):self.value=value
            def __getitem__(self,index):return Tensor(self.value[index])
            def detach(self):return self
            def cpu(self):return self
            def numpy(self):return self.value
            def to(self,_):return self
        class Capture:
            def __init__(self,_):self.index=0
            def get(self,prop):return {5:24,3:100,4:100}[prop]
            def read(self):self.index+=1;return (True,self.index) if self.index<=2 else (False,None)
            def release(self):pass
        class Writer:
            def isOpened(self):return False
            def release(self):pass
        class Model:
            def __init__(self):self.index=0
            def __call__(self,images):
                self.index+=1
                return [{"scores":[.9] if self.index==1 else [],"labels":[1],"boxes":Tensor([[10.,10.,90.,90.]]),"keypoints":Tensor([[[20.,30.,1.]]*len(custom.LANDMARKS)])}]
        class Context:
            def __enter__(self):pass
            def __exit__(self,*_):pass
        modules={"torch":types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda:True),inference_mode=Context),
                 "numpy":types.SimpleNamespace(),"cv2":types.SimpleNamespace(VideoCapture=Capture,CAP_PROP_FPS=5,CAP_PROP_FRAME_WIDTH=3,CAP_PROP_FRAME_HEIGHT=4,VideoWriter=lambda *args:Writer(),VideoWriter_fourcc=lambda *args:0,COLOR_BGR2RGB=4,cvtColor=lambda image,_:image,circle=lambda *args:None,rectangle=lambda *args:None),
                 "torchvision.transforms.functional":types.SimpleNamespace(to_tensor=lambda image:Tensor(image))}
        path=self.root/"poses.csv"
        checkpoint=self.root/"fake.pt";checkpoint.write_bytes(b"fake tensors")
        with patch.dict("sys.modules",modules),patch.object(custom,"load_model",return_value=Model()):
            custom.infer("fake.mp4",str(checkpoint),self.root/"infer",str(path),None,vars(arena),{"startSec":0,"endSec":1})
        with path.open() as handle:rows=list(csv.DictReader(handle))
        self.assertEqual(len(rows),20)
        self.assertEqual(rows[0]["keypoint"],"body_center")
        self.assertEqual(rows[0]["status"],"low_confidence")
        self.assertEqual(float(rows[0]["likelihood"]),0.)
        self.assertEqual(float(rows[0]["x_px"]),20.)
        self.assertTrue(all(row["status"]=="missing" for row in rows[10:]))
        report=json.loads((self.root/"infer/diagnostic_report.json").read_text())
        self.assertEqual(report["summary"]["detectorCoveragePct"],50.)
        self.assertEqual(report["confidencePolicy"],"uncalibrated")


if __name__=="__main__":unittest.main()
