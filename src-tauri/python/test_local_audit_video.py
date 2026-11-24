import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest

from local_audit_video import finalize, render, write_annotations
from opencv_engine import write_json


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def probe(filename):
    output = subprocess.check_output([FFPROBE, "-v", "error", "-select_streams", "v:0",
                                      "-show_entries", "frame=best_effort_timestamp_time", "-of", "json",
                                      str(filename)])
    return [float(frame["best_effort_timestamp_time"]) for frame in json.loads(output)["frames"]]


@unittest.skipUnless(FFMPEG and FFPROBE, "FFmpeg e ffprobe necessários")
class LocalAuditVideoTests(unittest.TestCase):
    def test_vfr_keeps_frame_times_and_draws_only_the_saved_boxes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original.mp4"
            annotated = root / "results" / "audit.mp4"
            subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=black:s=320x240:r=25",
                            "-vf", r"setpts=if(eq(N\,0)\,0\,if(eq(N\,1)\,2\,if(eq(N\,2)\,5\,6)))",
                            "-frames:v", "4", "-fps_mode", "passthrough", "-c:v", "libx264", str(original)],
                           check=True)
            timestamps = probe(original)
            self.assertEqual(timestamps, [0, .08, .20, .24])
            saved = [
                {"status": "valid", "source": "segmented", "bbox": {"x": 30, "y": 90, "width": 50, "height": 35}},
                {"status": "low_confidence", "source": "predicted", "bbox": {"x": 90, "y": 90, "width": 50, "height": 35}},
                {"status": "missing", "source": "segmented"},
                {"status": "valid", "source": "segmented", "bbox": {"x": 230, "y": 90, "width": 50, "height": 35}},
            ]
            (root / "samples.jsonl").write_text("".join(
                json.dumps(dict(sample, frameIndex=i, timestampSec=t)) + "\n"
                for i, (sample, t) in enumerate(zip(saved, timestamps))
            ), encoding="utf-8")
            request = {"config": {"width": 320, "height": 240}, "video": str(original), "ffmpeg": FFMPEG}
            render(request, root, annotated, lambda: False)
            self.assertEqual(probe(annotated), timestamps)
            decoded = subprocess.check_output([FFMPEG, "-v", "error", "-i", str(annotated), "-fps_mode", "passthrough",
                                               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])

            def brightness(frame, x, y):
                offset = (frame * 320 * 240 + y * 320 + x) * 3
                return sum(decoded[offset:offset + 3])

            for frame, expected_box in enumerate([30, 90, None, 230]):
                for x in (30, 90, 230):
                    luminance = max(brightness(frame, column, 105) for column in range(x - 2, x + 3))
                    self.assertEqual(luminance > 60, x == expected_box, (frame, x, luminance))

    def test_render_failure_preserves_completed_tracking(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            report = {"state": "succeeded", "framesProcessed": 300}
            request = {"video": str(root / "missing.mp4"), "config": {}, "auditVideo": str(root / "audit.mp4")}
            finalize(request, root, report, 0, write_json)
            self.assertEqual(report["state"], "succeeded")
            self.assertEqual(report["framesProcessed"], 300)
            self.assertIn("saiu do cache", report["videoError"])
            self.assertFalse((root / "audit.mp4").exists())

    def test_fst_annotations_include_both_cylinders_and_omit_absent_body_boxes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config = {"protocol": "forced_swim", "width": 320, "height": 240, "tanks": [
                {"animalId": "one", "roiPx": {"x": 10, "y": 40, "width": 100, "height": 150}},
                {"animalId": "two", "roiPx": {"x": 180, "y": 40, "width": 100, "height": 150}},
            ]}
            result = {"tanks": config["tanks"], "frames": [
                {"frame": 0, "timestampSec": 0, "animalId": "one", "presence": "IN_TANK",
                 "bbox": {"x": 30, "y": 80, "width": 20, "height": 20}},
                {"frame": 0, "timestampSec": 0, "animalId": "two", "presence": "NOT_IN_TANK",
                 "bbox": {"x": 210, "y": 80, "width": 20, "height": 20}},
            ]}
            (root / "result.json").write_text(json.dumps(result), encoding="utf-8")
            target = root / "annotations.ass"
            write_annotations(target, root, config, 320, 240, lambda: False)
            overlay = target.read_text(encoding="utf-8")
            self.assertIn("Cilindro 1: Presente", overlay)
            self.assertIn("Cilindro 2: Ausente", overlay)
            self.assertIn("m 30 80", overlay)
            self.assertNotIn("m 210 80", overlay)
            self.assertIn("m 10 40", overlay)
            self.assertIn("m 180 40", overlay)


if __name__ == "__main__":
    unittest.main()
