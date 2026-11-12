import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from hybrid_render import REGIONS, draw_panel, immobility_flags, locomotor_series, smooth_series, visual_point


def center(frame, x, score=.9, status="valid"):
    return {"frame_index": str(frame), "keypoint": "mouse_center", "x_px": str(x),
            "y_px": "10", "likelihood": str(score), "status": status}


class PerspectiveResult:
    def __init__(self, point):
        self.point = point

    def __getitem__(self, index):
        assert index == (0, 0)
        return self.point


class HybridRenderTests(unittest.TestCase):
    def test_palette_covers_model_names(self):
        config = Path(__file__).resolve().parents[2] / "models/wistar_df_v2/pytorch_config.yaml"
        bodyparts = config.read_text().split("  bodyparts:\n", 1)[1].split("  unique_bodyparts:", 1)[0]
        names = [line.strip().removeprefix("- ") for line in bodyparts.splitlines() if line.strip()]
        self.assertEqual(len(names), 27)
        self.assertEqual(set(names), set(REGIONS))

    def test_visual_threshold_keeps_metric_threshold_separate(self):
        self.assertIsNotNone(visual_point(center(0, 10, .5, "low_confidence"), 100, 100))
        self.assertIsNone(visual_point(center(0, 10, .49), 100, 100))
        self.assertIsNone(visual_point(center(0, float("nan")), 100, 100))
        self.assertIsNone(visual_point(center(0, 110), 100, 100))

    def test_speed_uses_calibration_and_never_bridges_gaps(self):
        fake_numpy = types.SimpleNamespace(float32=lambda value: value)
        fake_cv2 = types.SimpleNamespace(
            getPerspectiveTransform=lambda source, destination: (source, destination),
            perspectiveTransform=lambda point, matrix: PerspectiveResult(
                (point[0][0][0] / 2, point[0][0][1] / 2)),
        )
        arena = {"cornersPx": [{"x": 0, "y": 0}, {"x": 200, "y": 0},
                               {"x": 200, "y": 200}, {"x": 0, "y": 200}],
                 "widthCm": 100, "heightCm": 100}
        rows = [[center(0, 10)], [center(1, 20)], [center(2, 30, .4, "low_confidence")],
                [center(3, 40)], [center(4, 50)]]
        with patch.dict(sys.modules, {"cv2": fake_cv2, "numpy": fake_numpy}):
            speed = locomotor_series(rows, [0, .25, .5, .75, 1], arena, 200, 200)
        self.assertEqual(speed, [None, 20, None, None, 20])
        self.assertEqual(smooth_series(speed, [0, .25, .5, .75, 1]), speed)

    def test_immobility_requires_duration_and_resets_at_gap(self):
        values = [None, 1, 1, 1, None, 1, 1]
        times = [0, .25, .5, .75, 1, 1.25, 1.5]
        self.assertEqual(immobility_flags(values, times), [False, False, True, True, False, False, True])
        self.assertEqual(smooth_series([None, 4, 8, None, 10], times[:5]),
                         [None, 4, 6, None, 10])

    def test_chart_reveals_only_current_valid_segment(self):
        lines = []
        fake_cv2 = types.SimpleNamespace(
            FONT_HERSHEY_SIMPLEX=0, LINE_AA=0,
            rectangle=lambda *args: None, addWeighted=lambda *args: None,
            putText=lambda *args: None, circle=lambda *args: None,
            line=lambda frame, start, end, color, *args: lines.append(color),
        )

        class Frame:
            shape = (720, 1280, 3)

            def copy(self):
                return self

        times = [0, .25, .5, .75, 1]
        series = [None, 5, 6, None, 8]
        with patch.dict(sys.modules, {"cv2": fake_cv2}):
            draw_panel(Frame(), 1, times[1], 5, "wistar_df_v2", "animal_1", 2, .9,
                       series[1], series, times, False)
            self.assertEqual(lines.count((153, 211, 52)), 0)
            draw_panel(Frame(), 2, times[2], 5, "wistar_df_v2", "animal_1", 2, .9,
                       series[2], series, times, False)
            self.assertEqual(lines.count((153, 211, 52)), 1)
            draw_panel(Frame(), 4, times[4], 5, "wistar_df_v2", "animal_1", 2, .9,
                       series[4], series, times, False)
            self.assertEqual(lines.count((153, 211, 52)), 2)


if __name__ == "__main__":
    unittest.main()
