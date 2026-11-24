"""CPU regressions for fixed session references, ROI geometry and motion evidence."""
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
import opencv_engine as engine
from test_opencv_engine import config


class ClassicalTests(unittest.TestCase):
    def image(self, x=100):
        image = np.full((240, 320, 3), 40, np.uint8)
        # Static bright wall is inside the enclosure but outside the floor.
        cv2.rectangle(image, (285, 12), (305, 228), (240,)*3, -1)
        if x is not None:
            cv2.ellipse(image, (x, 110), (12, 8), 0, 0, 360, (200,)*3, -1)
        return image

    def test_median_subtraction_rejects_static_wall_and_keeps_stationary_body(self):
        cfg = config()
        cfg.update(strategy="classical_roi_v1", mode="background", threshold=25)
        reference = np.median(np.stack([self.image(x) for x in range(60, 261, 20)]), axis=0).astype(np.uint8)
        primary = engine.Segmenter(cfg, reference)
        detector = engine.HybridSegmenter(cfg, engine.ReferenceSegmenter(primary))
        for index in range(30):
            result = detector.process(self.image(), index/30)
            self.assertEqual(result["status"], "valid")
            self.assertAlmostEqual(result["xPx"], 100, delta=1)
        self.assertEqual(result["features"]["changedPixelFraction"], 0)
        self.assertEqual(result["features"]["speedPxSec"], 0)
        self.assertEqual(detector.process(self.image(None), 1)["source"], "predicted")
        self.assertEqual(detector.process(self.image(None), 1.5)["status"], "missing")

    def test_stationary_body_in_reference_uses_uncertain_static_evidence(self):
        cfg = config()
        cfg.update(strategy="classical_roi_v1", mode="background", threshold=25)
        image = np.zeros((240, 320, 3), np.uint8)
        cv2.ellipse(image, (100, 110), (12, 8), 0, 0, 360, (200,)*3, -1)
        primary = engine.Segmenter(cfg, image)
        static = engine.Segmenter({**cfg, "mode": "light", "threshold": 100})
        detector = engine.HybridSegmenter(cfg, engine.ReferenceSegmenter(primary, static))
        result = detector.process(image, 0)
        self.assertEqual(result["status"], "low_confidence")
        self.assertEqual(result["reason"], "static_reference_overlap")
        self.assertEqual(result["source"], "recovered")
        self.assertIsNone(detector.kalman.last_observed)
        self.assertIsNotNone(result["bbox"])

    def test_features_use_elapsed_pts_and_reset_after_missing_evidence(self):
        features = engine.SilhouetteFeatures()
        gray = np.zeros((60, 80), np.uint8)
        mask = gray.copy()
        mask[20:30, 10:30] = 255
        first = features.extract(gray, mask, 0, .5)
        self.assertIsNone(first["speedPxSec"])
        self.assertEqual(first["areaPx"], 800)
        shifted = np.roll(mask, 5, axis=1)
        second = features.extract(gray, shifted, .1, .5)
        self.assertAlmostEqual(second["speedPxSec"], 100)
        self.assertGreater(second["changedPixelFraction"], 0)
        self.assertIsNone(features.extract(gray, np.zeros_like(mask), .2))
        self.assertIsNone(features.extract(gray, shifted, .3)["speedPxSec"])

    def test_unknown_duration_has_bounded_prefix_and_cancellation_is_immediate(self):
        frames = [self.image()] * 15
        with patch.object(engine, "read_frames", return_value=iter(frames)) as decode:
            # Use a generator with close(), as the real decoder does.
            decode.return_value = (frame for frame in frames)
            samples = list(engine.reference_frames("video", "ffmpeg", 320, 240, 0))
            self.assertEqual(len(samples), 15)
            self.assertIsNone(samples[-1][0])
            self.assertEqual(decode.call_args.kwargs["frame_limit"], 15)
        with patch.object(engine, "read_frames") as decode:
            with self.assertRaises(InterruptedError):
                list(engine.reference_frames("video", "ffmpeg", 320, 240, 60, cancelled=lambda: True))
            decode.assert_not_called()

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
    def test_classical_video_preserves_pts_original_coordinates_and_reference_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root/"input.mkv"
            frames = [self.image(60+index*5) for index in range(36)]
            subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-s", "320x240", "-r", "30", "-i", "pipe:0",
                            "-vf", "setpts=PTS+floor(N/6)*2", "-fps_mode", "passthrough", "-c:v", "libx264", str(video)],
                           input=b"".join(frame.tobytes() for frame in frames), check=True)
            cfg = config()
            cfg.update(protocol="open_field", strategy="classical_roi_v1", mode="auto", threshold=25,
                       maxWidth=160, useOpenCL=False, autorotate=True)
            request = {"video": str(video), "ffmpeg": shutil.which("ffmpeg"),
                       "ffprobe": shutil.which("ffprobe"), "config": cfg}
            (root/"request.json").write_text(json.dumps(request))
            engine.run(root/"request.json")
            records = [json.loads(line) for line in (root/"samples.jsonl").read_text().splitlines()]
            report = json.loads((root/"status.json").read_text())
            self.assertEqual(report["state"], "succeeded")
            self.assertEqual(len(records), 36)
            self.assertAlmostEqual(records[3]["timestampSec"], .1)
            self.assertAlmostEqual(records[12]["timestampSec"], 16/30, places=3)
            self.assertAlmostEqual(records[3]["xPx"], 75, delta=3)
            self.assertEqual(report["backgroundReference"]["sampledFrames"], 31)
            self.assertEqual(report["computeBackend"], "CPU")
            self.assertFalse(records[3]["referenceApproved"])
            self.assertTrue((root/"background-reference.png").is_file())
            self.assertTrue((root/"run_manifest.json").is_file())
            self.assertIn("features", records[3])
            self.assertFalse(report["scientificallyValidated"])
            self.assertGreater(report["trackingObservedFrames"], 0)
            self.assertEqual(sum(report["reasonCounts"].values()), 36)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
    def test_fst_samples_reference_and_exports_motion_without_behavior_labels(self):
        with patch.dict(sys.modules, {"engine": engine}):
            spec = importlib.util.spec_from_file_location("local_fst_test", Path(__file__).with_name("local_fst_engine.py"))
            fst = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(fst)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root/"fst.mp4"
            frames = []
            for index in range(30):
                image = np.full((240, 320, 3), 30, np.uint8)
                cv2.ellipse(image, (82+index%3, 120), (27, 20), 0, 0, 360, (210,)*3, -1)
                frames.append(image)
            subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-s", "320x240", "-r", "30", "-i", "pipe:0", "-c:v", "libx264", str(video)],
                           input=b"".join(frame.tobytes() for frame in frames), check=True)
            cfg = {"jobId": "local-run", "protocol": "forced_swim", "videoSha256": "0"*64,
                   "width": 320, "height": 240, "subjects": [{"animalId": "one", "subjectId": "subject"}, {"animalId": "two", "subjectId": "other"}],
                   "tanks": [{"animalId": "one", "roiPx": {"x": 20, "y": 20, "width": 120, "height": 200}},
                             {"animalId": "two", "roiPx": {"x": 180, "y": 20, "width": 120, "height": 200}}]}
            (root/"request.json").write_text(json.dumps({"video": str(video), "config": cfg,
                "ffmpeg": shutil.which("ffmpeg"), "ffprobe": shutil.which("ffprobe")}))
            fst.run(root/"request.json")
            result = json.loads((root/"result.json").read_text())
            self.assertEqual(len(result["frames"]), 60)
            self.assertIsNone(result["behaviorMetrics"])
            self.assertEqual({row["classification"] for row in result["frames"]}, {"NOT_CLASSIFIED"})
            self.assertLessEqual(result["backgroundReference"]["sampledFrames"], 15)
            self.assertTrue(any(row["motionFeatures"] for row in result["frames"]))
            self.assertAlmostEqual(result["frames"][6]["timestampSec"], .1)
            empty = [row for row in result["frames"] if row["animalId"] == "two"]
            self.assertTrue(all(row["motionFeatures"] is None and row["presence"] != "IN_TANK" for row in empty))


if __name__ == "__main__":
    unittest.main()
