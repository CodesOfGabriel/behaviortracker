import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest

from local_audit_video import AXIS, DisplacementChart, accepted_body, finalize, render, silhouette_axis, write_annotations
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
            # Matroska preserves the last frame's duration in this synthetic
            # setpts fixture with FFmpeg 7; MP4 can omit its final decoded frame.
            original = root / "original.mkv"
            annotated = root / "results" / "audit.mp4"
            subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=black:s=320x240:r=25",
                            "-vf", r"setpts=if(eq(N\,0)\,0\,if(eq(N\,1)\,2\,if(eq(N\,2)\,5\,6)))",
                            "-frames:v", "4", "-fps_mode", "passthrough", "-c:v", "libx264", str(original)],
                           check=True)
            timestamps = probe(original)
            self.assertEqual(timestamps, [0, .08, .20, .24])
            saved = [
                {"status": "valid", "source": "segmented", "bbox": {"x": 30, "y": 90, "width": 50, "height": 35},
                 "contour": [{"x": 30, "y": 90}, {"x": 80, "y": 90}, {"x": 80, "y": 125}, {"x": 30, "y": 125}]},
                {"status": "low_confidence", "source": "predicted", "bbox": {"x": 90, "y": 90, "width": 50, "height": 35}},
                {"status": "missing", "source": "segmented"},
                {"status": "valid", "source": "segmented", "bbox": {"x": 230, "y": 90, "width": 50, "height": 35}},
            ]
            (root / "samples.jsonl").write_text("".join(
                json.dumps(dict(sample, frameIndex=i, timestampSec=t)) + "\n"
                for i, (sample, t) in enumerate(zip(saved, timestamps))
            ), encoding="utf-8")
            request = {"config": {"width": 320, "height": 240}, "video": str(original), "ffmpeg": FFMPEG}
            metadata = render(request, root, annotated, lambda: False)
            self.assertEqual(probe(annotated), timestamps)
            self.assertEqual(metadata["skeletonFrames"], 1)
            self.assertFalse(metadata["textOverlay"])
            self.assertFalse(metadata["displacementChart"]["visible"])
            decoded = subprocess.check_output([FFMPEG, "-v", "error", "-i", str(annotated), "-fps_mode", "passthrough",
                                               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])

            def brightness(frame, x, y):
                offset = (frame * 320 * 240 + y * 320 + x) * 3
                return sum(decoded[offset:offset + 3])

            for frame, expected_box in enumerate([30, 90, None, 230]):
                for x in (30, 90, 230):
                    luminance = max(brightness(frame, column, 105) for column in range(x - 2, x + 3))
                    self.assertEqual(luminance > 60, x == expected_box, (frame, x, luminance))
            self.assertGreater(brightness(0, 55, 107), 150)
            self.assertLess(brightness(1, 55, 107), 60)
            self.assertLess(max(brightness(0, x, y) for x in range(226, 310) for y in range(10, 26)), 60)

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
                 "bbox": {"x": 30, "y": 80, "width": 60, "height": 20},
                 "contour": [{"x":30,"y":80},{"x":90,"y":80},{"x":90,"y":100},{"x":30,"y":100}]},
                {"frame": 0, "timestampSec": 0, "animalId": "two", "presence": "NOT_IN_TANK",
                 "bbox": {"x": 210, "y": 80, "width": 20, "height": 20},
                 "contour": [{"x":210,"y":80},{"x":270,"y":80},{"x":270,"y":100},{"x":210,"y":100}]},
            ]}
            (root / "result.json").write_text(json.dumps(result), encoding="utf-8")
            target = root / "annotations.ass"
            metadata = write_annotations(target, root, config, 320, 240, lambda: False)
            overlay = target.read_text(encoding="utf-8")
            self.assertIn("Cilindro 1: Presente", overlay)
            self.assertIn("Cilindro 2: Ausente", overlay)
            self.assertIn("m 30 80", overlay)
            self.assertNotIn("m 210 80", overlay)
            self.assertIn("m 10 40", overlay)
            self.assertIn("m 180 40", overlay)
            self.assertEqual(metadata["skeletonFrames"], 1)
            self.assertIn("Eixo da silhueta estimado", overlay)
            self.assertEqual(metadata["displacementChart"]["position"], "top_right")

    def test_axis_stays_inside_elongated_mask_and_has_no_anatomical_labels(self):
        import numpy as np
        contour = [{"x": 60+40*float(np.cos(t)), "y": 100+12*float(np.sin(t))}
                   for t in np.linspace(0, 2*np.pi, 40, endpoint=False)]
        path = silhouette_axis(contour)
        self.assertEqual(len(path), 7)
        for x, y in path:
            self.assertLess(((x-60)/40)**2+((y-100)/12)**2, 1.05)
        circle = [{"x": 60+12*float(np.cos(t)), "y": 100+12*float(np.sin(t))}
                  for t in np.linspace(0, 2*np.pi, 40, endpoint=False)]
        circular_path = silhouette_axis(circle, [0, 1])
        self.assertIsNone(circular_path)
        self.assertIsNone(silhouette_axis(None))

    def test_chart_uses_pts_breaks_at_uncertainty_and_is_causal(self):
        chart = DisplacementChart()
        def items(x, **changes):
            box = {"x": x, "y": 90, "width": 50, "height": 35}
            sample = {"status": "valid", "source": "segmented", "bbox": box, **changes}
            return [("body", "FFFFFF", box, sample)]
        self.assertIsNone(chart.update(0, 0, items(0))["body"])
        self.assertEqual(chart.update(1, .08, items(8))["body"], 100)
        self.assertIsNone(chart.update(2, .20, items(20, source="predicted"))["body"])
        self.assertIsNone(chart.update(3, .24, items(24))["body"])
        self.assertAlmostEqual(chart.update(4, .40, items(40))["body"], 100)
        self.assertIsNone(chart.update(5, .44, items(44, trackingAccepted=False))["body"])
        self.assertIsNone(chart.update(6, .48, items(48))["body"])
        self.assertEqual(chart.update(7, .52, items(48))["body"], 0)
        self.assertIsNone(chart.update(8, 1.3, items(60))["body"])
        self.assertEqual(chart.pairs, 3)
        self.assertEqual(chart.history[-1][0], 1.3)
        chart.update(9, 13, items(70))
        self.assertEqual(len(chart.history), 1)
        self.assertFalse(accepted_body({"status": "valid", "source": "recovered"}))
        self.assertFalse(accepted_body({"status": "valid", "source": "manual", "reason": "camera_shift"}))

    def test_overlay_draws_saved_axis_only_on_accepted_observations(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            contour = [{"x": 40, "y": 100}, {"x": 120, "y": 100},
                       {"x": 120, "y": 120}, {"x": 40, "y": 120}]
            samples = [{"frameIndex": i, "timestampSec": i*.04, "status": "valid",
                        "source": "segmented" if i != 1 else "predicted",
                        "bbox": {"x": 40, "y": 100, "width": 80, "height": 20}, "contour": contour}
                       for i in range(3)]
            (root/"samples.jsonl").write_text("".join(json.dumps(row)+"\n" for row in samples))
            target = root/"annotations.ass"
            metadata = write_annotations(target, root, {"width": 320, "height": 240}, 320, 240, lambda: False)
            data = target.read_text()
            self.assertNotIn("Eixo da silhueta estimado",data)
            self.assertIn(AXIS, data)
            self.assertNotIn("DESLOCAMENTO - IMAGEM",data)
            self.assertEqual(metadata["skeletonFrames"], 2)
            self.assertEqual(metadata["displacementChart"]["validPairs"], 0)
            self.assertFalse(metadata["anatomicalPose"])

    def test_fst_chart_keeps_subjects_separate_and_expires_missing_body(self):
        chart = DisplacementChart(is_fst=True)
        def items(first, second, state="IN_TANK"):
            return [(subject, "FFFFFF", {"x": x, "y": 50, "width": 10, "height": 20},
                     {"animalId": subject, "presence": state if subject == "a" else "IN_TANK"})
                    for subject, x in [("a", first), ("b", second)]]
        chart.update(0, 0, items(10, 200))
        self.assertEqual(chart.update(1, .1, items(20, 220)), {"a": 100, "b": 200})
        self.assertEqual(chart.update(2, .2, items(30, 240, "UNCERTAIN")), {"a": None, "b": 200})
        self.assertIsNone(chart.update(3, .3, items(40, 260))["a"])

    def test_uncertain_masks_remain_visible_without_enabling_motion_measurements(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            contour = [{"x":40,"y":100},{"x":120,"y":100},{"x":120,"y":120},{"x":40,"y":120}]
            rows = [{"frameIndex":i,"timestampSec":i*.04,"status":"low_confidence","source":"segmented",
                     "trackingAccepted":False,"bbox":{"x":40,"y":100,"width":80,"height":20},"contour":contour}
                    for i in range(3)]
            rows[1].update(status="valid",trackingAccepted=True)
            rows[2]["source"]="predicted"
            (root/"samples.jsonl").write_text("".join(json.dumps(row)+"\n" for row in rows))
            target=root/"annotations.ass"
            result=write_annotations(target,root,{"width":320,"height":240},320,240,lambda:False)
            self.assertEqual(result["skeletonFrames"],2)
            self.assertEqual(result["uncertainSkeletonObservations"],1)
            self.assertEqual(result["displacementChart"]["validPairs"],0)
            self.assertNotIn("Silhueta incerta",target.read_text())
            self.assertFalse(result["textOverlay"])

    def test_export_hides_the_perpendicular_outlier_without_holding_the_previous_axis(self):
        from test_body_axis import ellipse
        with TemporaryDirectory() as directory:
            root = Path(directory)
            samples = [ellipse(frame=i) for i in range(8)]
            samples[5] = ellipse(1.5707963267948966, 5)
            (root/"samples.jsonl").write_text("".join(json.dumps(row)+"\n" for row in samples))
            metadata = write_annotations(root/"annotations.ass", root, {"width":320,"height":240}, 320, 240, lambda:False)
            self.assertEqual(metadata["skeletonFrames"], 7)
            self.assertEqual(metadata["axisQualityReasons"]["orientation_outlier"], 1)
            self.assertEqual(metadata["skeletonMethod"], "body-axis-2")


if __name__ == "__main__":
    unittest.main()
