import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from labeled_video import render_labeled_video


class LabeledVideoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="behavetracker-labeled-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.geometry = {"cropping": [20, 180, 40, 160], "videoWidth": 200, "videoHeight": 200}
        self.calls = []
        (self.root / "raw.h5").write_bytes(b"original h5")

    def modules(self, frames=48):
        test = self
        class Capture:
            def __init__(self, path): test.assertEqual(Path(path).name, "dlc_labeled.mp4")
            def isOpened(self): return True
            def get(self, prop): return {7: frames, 3: 200, 4: 200}[prop]
            def release(self): pass
        def create_video(video, h5, **kwargs):
            self.calls.append((video, h5, kwargs))
            Path(kwargs["output_path"]).write_bytes(b"raw DLC video")
        return {"cv2": types.SimpleNamespace(VideoCapture=Capture, CAP_PROP_FRAME_COUNT=7, CAP_PROP_FRAME_WIDTH=3, CAP_PROP_FRAME_HEIGHT=4),
                "deeplabcut.utils.make_labeled_video": types.SimpleNamespace(create_video=create_video)}

    def encode(self, args, **kwargs):
        self.assertEqual(args[0], "/fake/ffmpeg")
        self.assertIn("libx264", args)
        self.assertNotIn("scale=", " ".join(args))
        Path(args[-1]).write_bytes(b"browser compatible video")
        return types.SimpleNamespace(returncode=0, stderr=b"")

    def test_uses_raw_h5_and_dlc_renderer_with_full_frame_crop_offset(self):
        with patch.dict("sys.modules", self.modules()), patch("labeled_video.shutil.which", return_value="/fake/ffmpeg"), patch("labeled_video.subprocess.run", side_effect=self.encode):
            report = render_labeled_video("input.mp4", str(self.root / "raw.h5"), 24, self.geometry, self.root, 48)
        self.assertTrue(report["available"])
        self.assertEqual(report["source"], "deeplabcut_raw_h5")
        self.assertEqual(report["sha256"], hashlib.sha256(b"browser compatible video").hexdigest())
        kwargs = self.calls[0][2]
        self.assertEqual(kwargs["bbox"], (20, 180, 40, 160))
        self.assertFalse(kwargs["display_cropped"])
        self.assertEqual(kwargs["fps"], 24)
        self.assertEqual(kwargs["pcutoff"], .5)
        self.assertTrue(kwargs["plot_bboxes"])
        self.assertEqual((self.root / "raw.h5").read_bytes(), b"original h5")
        self.assertEqual(json.loads((self.root / "video_artifact.json").read_text()), report)

    def test_missing_frames_does_not_publish_a_misaligned_preview(self):
        with patch.dict("sys.modules", self.modules(frames=47)), patch("labeled_video.shutil.which", return_value="/fake/ffmpeg"), patch("labeled_video.subprocess.run", side_effect=self.encode):
            report = render_labeled_video("input.mp4", "raw.h5", 24, self.geometry, self.root, 48)
        self.assertFalse(report["available"])
        self.assertIn("frames ou resolução", report["error"])

    def test_rendering_failure_is_reported_without_destroying_pose_results(self):
        with patch.dict("sys.modules", self.modules()), patch("labeled_video.shutil.which", return_value=None):
            report = render_labeled_video("input.mp4", "raw.h5", 24, self.geometry, self.root, 48)
        self.assertFalse(report["available"])
        self.assertIn("FFmpeg", report["error"])
        self.assertEqual((self.root / "raw.h5").read_bytes(), b"original h5")


if __name__ == "__main__":
    unittest.main()
