"""Local FST association contracts; these are not scientific accuracy tests."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np
import opencv_engine

with patch.dict(sys.modules, {"engine": opencv_engine}):
    spec = importlib.util.spec_from_file_location("local_fst_contract", Path(__file__).with_name("local_fst_engine.py"))
    fst = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fst)


class LocalTankAssociationTests(unittest.TestCase):
    def setUp(self):
        self.reference = np.full((400, 160), 25, np.uint8)

    def frame(self, body=True, reflection=False, touching=False):
        image = np.full((400, 160, 3), 25, np.uint8)
        if body:
            cv2.ellipse(image, (80, 100), (90 if touching else 45, 55), 0, 0, 360, (135, 180, 210), -1)
        if reflection:
            cv2.ellipse(image, (80, 325), (45, 55), 0, 0, 360, (210, 210, 210), -1)
        return image

    def test_body_touching_both_sides_is_not_replaced_by_lower_reflection(self):
        tracker = fst.TankBodyTracker()
        first, _, _ = tracker.observe(self.frame(), self.reference, 0)
        self.assertIsNotNone(first)
        second, mask, _ = tracker.observe(self.frame(reflection=True, touching=True), self.reference, 1/30)
        self.assertIsNotNone(second)
        self.assertEqual(second["bbox"][0], 0)
        self.assertEqual(second["bbox"][2], 160)
        self.assertLess(second["bbox"][3], 200)
        self.assertEqual(int(np.count_nonzero(mask[230:])), 0)

    def test_rejects_jump_to_reflection_without_publishing_prediction(self):
        tracker = fst.TankBodyTracker()
        tracker.observe(self.frame(), self.reference, 0)
        chosen, mask, _ = tracker.observe(self.frame(body=False, reflection=True), self.reference, 1/30)
        self.assertIsNone(chosen)
        self.assertEqual(int(np.count_nonzero(mask)), 0)
        recovered, _, _ = tracker.observe(self.frame(), self.reference, 2/30)
        self.assertIsNotNone(recovered)
        self.assertLess(recovered["bbox"][3], 200)

    def test_tanks_have_independent_history(self):
        first, second = fst.TankBodyTracker(), fst.TankBodyTracker()
        first.observe(self.frame(), self.reference, 0)
        chosen, _, _ = second.observe(self.frame(body=False, reflection=True), self.reference, 1/30)
        self.assertIsNotNone(chosen)
        self.assertGreater(second.last[0][1], first.last[0][1])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
    def test_downscaled_video_retains_original_boxes_clock_and_empty_tank(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = np.full((960, 1280, 3), 25, np.uint8)
            cv2.ellipse(image, (300, 300), (80, 110), 0, 0, 360, (135, 180, 210), -1)
            video = root/"scene.mp4"
            subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-s", "1280x960", "-r", "10", "-i", "pipe:0", "-c:v", "libx264", str(video)],
                           input=image.tobytes()*9, check=True)
            tanks = [{"animalId": animal, "roiPx": {"x": x, "y": 80, "width": 400, "height": 800}}
                     for animal, x in [("one", 100), ("two", 720)]]
            config = {"jobId": "test", "protocol": "forced_swim", "videoSha256": "0"*64,
                      "width": 1280, "height": 960, "tanks": tanks,
                      "subjects": [{"animalId": t["animalId"], "subjectId": t["animalId"]} for t in tanks]}
            request = root/"request.json"
            request.write_text(json.dumps({"config": config, "video": str(video),
                                          "ffmpeg": shutil.which("ffmpeg"), "ffprobe": shutil.which("ffprobe")}))
            fst.run(request)
            result = json.loads((root/"result.json").read_text())
            self.assertEqual(result["processingGeometry"]["height"], 720)
            self.assertEqual(result["video"]["frameCount"], 9)
            self.assertIsNone(result["behaviorMetrics"])
            self.assertEqual({r["classification"] for r in result["frames"]}, {"NOT_CLASSIFIED"})
            for row in result["frames"]:
                self.assertAlmostEqual(row["timestampSec"], row["frame"]/10)
                if row["animalId"] == "two":
                    self.assertIsNone(row["bbox"])
                    self.assertIsNone(row["contour"])
                    self.assertNotEqual(row["presence"], "IN_TANK")
                else:
                    box = row["bbox"]
                    self.assertIsNotNone(box)
                    self.assertAlmostEqual(box["x"]+box["width"]/2, 300, delta=5)
                    self.assertAlmostEqual(box["y"]+box["height"]/2, 300, delta=5)
                    self.assertAlmostEqual(row["motionFeatures"]["areaPx"], np.pi*80*110, delta=3000)
                    self.assertGreater(len(row["contour"]), 3)
                    self.assertTrue(all(box["x"] <= p["x"] <= box["x"]+box["width"] and
                                        box["y"] <= p["y"] <= box["y"]+box["height"] for p in row["contour"]))


if __name__ == "__main__":
    unittest.main()
