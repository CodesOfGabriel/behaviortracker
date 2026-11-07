import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
try:
    import cv2
    import numpy as np
except ImportError:
    cv2 = np = None
from opencv_engine import ManualVisualTracker, Segmenter, TemporalTracker, run


def config(**overrides):
    return dict(width=320,height=240,mode="light",threshold=150,minAreaFraction=.001,maxAreaFraction=.1,
                maxWidth=1280,maxPredictionSec=.2,referenceApproved=False,
                arena={"cornersPx":[{"x":10,"y":10},{"x":310,"y":10},{"x":310,"y":230},{"x":10,"y":230}]},**overrides)


class TemporalTests(unittest.TestCase):
    def test_predictions_expire_without_claiming_new_observations(self):
        tracker=TemporalTracker(.2)
        tracker.observe((10,20),0)
        tracker.observe((12,20),.1)
        self.assertAlmostEqual(tracker.predict(.2)[0],14)
        self.assertIsNone(tracker.predict(.4))


@unittest.skipIf(cv2 is None,"OpenCV opcional não instalado no ambiente de testes")
class OpenCVTests(unittest.TestCase):
    def frame(self,x=100,y=100):
        image=np.zeros((240,320,3),np.uint8)
        if x is not None: cv2.ellipse(image,(x,y),(12,8),0,0,360,(255,255,255),-1)
        return image

    def test_stationary_animal_does_not_disappear(self):
        segmenter=Segmenter(config())
        for index in range(30):
            result=segmenter.process(self.frame(),index/24)
            self.assertEqual(result["source"],"segmented")
            self.assertEqual(result["status"],"valid")
            self.assertAlmostEqual(result["xPx"],100,delta=1)
            box=result["bbox"]
            self.assertAlmostEqual(result["xPx"],box["x"]+box["width"]/2)
            self.assertAlmostEqual(result["yPx"],box["y"]+box["height"]/2)

    def test_occlusion_is_prediction_then_missing_not_observation(self):
        segmenter=Segmenter(config())
        segmenter.process(self.frame(),0)
        predicted=segmenter.process(self.frame(None),.1)
        self.assertEqual(predicted["source"],"predicted")
        self.assertEqual(predicted["status"],"low_confidence")
        self.assertIsNotNone(predicted["bbox"])
        self.assertEqual(segmenter.process(self.frame(None),.4)["status"],"missing")

    def test_wall_touch_is_not_eligible_floor_measurement(self):
        self.assertEqual(Segmenter(config()).process(self.frame(17),0)["status"],"low_confidence")

    def test_background_reference_is_frozen(self):
        cfg=config();cfg["mode"]="background";cfg["threshold"]=25
        segmenter=Segmenter(cfg,self.frame(None))
        for index in range(20):self.assertEqual(segmenter.process(self.frame(),index/24)["status"],"valid")

    def test_ambiguous_animals_do_not_select_the_largest_as_certainty(self):
        image=self.frame();cv2.ellipse(image,(200,100),(12,8),0,0,360,(255,255,255),-1)
        self.assertEqual(Segmenter(config()).process(image,0)["reason"],"ambiguous")

    @unittest.skipUnless(shutil.which("ffprobe") and shutil.which("ffmpeg"),"FFmpeg necessário")
    def test_real_video_outputs_pts_and_separate_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);video=root/"input.mp4"
            for index in range(12):(root/f"frame{index:02d}.png").write_bytes(cv2.imencode(".png",self.frame(100+index))[1].tobytes())
            subprocess.run([shutil.which("ffmpeg"),"-v","error","-framerate","24","-i",str(root/"frame%02d.png"),"-c:v","libx264","-pix_fmt","yuv420p",str(video)],check=True)
            (root/"request.json").write_text(json.dumps({"video":str(video),"config":config(),"ffprobe":shutil.which("ffprobe"),"ffmpeg":shutil.which("ffmpeg")}))
            run(root/"request.json")
            report=json.loads((root/"status.json").read_text())
            records=[json.loads(line) for line in (root/"samples.jsonl").read_text().splitlines()]
            self.assertEqual(report["state"],"succeeded")
            self.assertEqual(len(records),12)
            self.assertAlmostEqual(records[1]["timestampSec"],1/24,places=5)
            self.assertEqual(records[0]["keypoint"],"box_center")
            self.assertFalse(records[0]["referenceApproved"])
            self.assertEqual(records[0]["likelihood"],0)

    def test_initial_box_selects_animal_not_another_bright_object(self):
        image=self.frame();cv2.ellipse(image,(220,100),(12,8),0,0,360,(255,255,255),-1)
        segmenter=Segmenter(config(initialBox={"x":80,"y":80,"width":40,"height":40}))
        self.assertAlmostEqual(segmenter.process(image,0)["xPx"],100,delta=1)

    def test_partial_near_wall_keeps_visible_box_but_not_as_confident_floor(self):
        segmenter=Segmenter(config(initialBox={"x":10,"y":80,"width":30,"height":40}))
        for index in range(30):
            result=segmenter.process(self.frame(13),index/24)
            self.assertEqual(result["source"],"segmented")
            self.assertEqual(result["status"],"low_confidence")
            self.assertIsNotNone(result["bbox"])

    def test_reacquires_after_long_gap_without_returning_to_initial_seed(self):
        segmenter=Segmenter(config(initialBox={"x":80,"y":80,"width":40,"height":40}))
        segmenter.process(self.frame(),0)
        self.assertEqual(segmenter.process(self.frame(None),.4)["status"],"missing")
        result=segmenter.process(self.frame(250),.5)
        self.assertAlmostEqual(result["xPx"],250,delta=1)
        self.assertEqual(result["reason"],"reacquired")
        self.assertEqual(result["status"],"low_confidence")

    def test_scale_restores_box_to_original_video_pixels(self):
        cfg=config();cfg["maxWidth"]=160
        result=Segmenter(cfg).process(self.frame(),0)
        self.assertAlmostEqual(result["xPx"],100,delta=2)
        self.assertGreater(result["bbox"]["width"],20)

    def textured_frame(self, x=None):
        image=np.zeros((240,320,3),np.uint8)
        cv2.rectangle(image,(245,85),(272,111),(190,190,190),-1)  # objeto fixo que não é o animal
        if x is not None:
            cv2.ellipse(image,(x,110),(16,11),0,0,360,(225,225,225),-1)
            cv2.circle(image,(x+8,107),3,(30,30,30),-1)
            cv2.line(image,(x-8,110),(x-2,115),(90,90,90),2)
        return image

    def test_visual_tracker_learns_only_human_crops_and_stops_after_loss(self):
        tracker=ManualVisualTracker(320,240,1)
        box={"x":64,"y":98,"width":32,"height":24}
        tracker.add_anchor(self.textured_frame(80),box)
        tracker.begin(self.textured_frame(80),box)
        for x in range(82,121,2):
            estimate=tracker.update(self.textured_frame(x))
            self.assertIsNotNone(estimate, f"animal na posição {x}")
            self.assertAlmostEqual(estimate["bbox"]["x"]+estimate["bbox"]["width"]/2,x,delta=4)
        self.assertFalse(any(tracker.update(self.textured_frame(None)) for _ in range(6)))

    @unittest.skipUnless(shutil.which("ffprobe") and shutil.which("ffmpeg"),"FFmpeg necessário")
    def test_guided_run_preserves_human_anchors_and_marks_estimates(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);video=root/"input.mp4"
            for index in range(70):
                x=80+index if index<60 else None
                (root/f"frame{index:02d}.png").write_bytes(cv2.imencode(".png",self.textured_frame(x))[1].tobytes())
            subprocess.run([shutil.which("ffmpeg"),"-v","error","-framerate","20","-i",str(root/"frame%02d.png"),"-c:v","libx264","-pix_fmt","yuv420p",str(video)],check=True)
            anchors=[{"frameIndex":i,"timestampSec":i/20,"box":{"x":64+i,"y":98,"width":32,"height":24},"eventId":f"event-{i}"} for i in (0,20)]
            cfg=config(guidance={"sourceJobId":"prior-job","anchors":anchors},initialBox=anchors[0]["box"])
            (root/"request.json").write_text(json.dumps({"video":str(video),"config":cfg,"ffprobe":shutil.which("ffprobe"),"ffmpeg":shutil.which("ffmpeg")}))
            run(root/"request.json")
            report=json.loads((root/"status.json").read_text())
            records=[json.loads(line) for line in (root/"samples.jsonl").read_text().splitlines()]
            self.assertEqual(report["state"],"succeeded")
            self.assertEqual(report["guidanceSourceJobId"],"prior-job")
            self.assertEqual(report["manualAnchorCount"],2)
            self.assertEqual(len(records),70)
            self.assertEqual(records[0]["source"],"manual")
            self.assertEqual(records[20]["bbox"],anchors[1]["box"])
            self.assertEqual(records[10]["source"],"predicted")
            self.assertEqual(records[10]["reason"],"manual_keyframe_interpolation")
            self.assertFalse(records[10]["referenceApproved"])
            self.assertIn(records[30]["reason"],("assisted_visual_and_contour","assisted_visual_match"))
            self.assertAlmostEqual(records[30]["xPx"],110,delta=5)
            self.assertEqual(records[69]["status"],"missing")
