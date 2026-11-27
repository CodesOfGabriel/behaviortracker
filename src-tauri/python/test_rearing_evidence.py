import copy
import json
from pathlib import Path
import tempfile
import unittest

import cv2 as cv
import numpy as np

from behavior.rearing_evidence import analyze, run


def sequence(wall=False, angle=0, scale=1.):
    rows = []
    rotation = cv.getRotationMatrix2D((0, 0), angle, scale)[:, :2]
    def point(p):
        p = np.asarray(p) @ rotation.T + 500
        return dict(x=float(p[0]), y=float(p[1]))
    for i in range(120):
        rearing = 65 <= i < 86
        center = (200, 200) if not wall or not rearing else (200, 110)
        length, width = ((65, 42) if rearing else (110, 35)) if not wall else (110, 35)
        radians = np.linspace(0, 2*np.pi, 48, endpoint=False)
        polygon = np.column_stack([length/2*np.cos(radians), width/2*np.sin(radians)])
        if wall and rearing:
            polygon = polygon[:, ::-1]
        contour = [point(p+center) for p in polygon]
        axis = [[x, 0] for x in np.linspace(-length*.33, length*.33, 7)]
        if wall and rearing:
            axis = [[0, x] for x in np.linspace(-length*.33, length*.33, 7)]
        path = [point(np.array(p)+center) for p in axis]
        box = cv.boundingRect(np.array([[p['x'], p['y']] for p in contour], np.float32))
        row = dict(frameIndex=i, timestampSec=i/20, source="segmented", status="valid", trackingAccepted=True,
                   bbox=dict(zip(("x", "y", "width", "height"), box)), contour=contour,
                   bodyAxis=dict(state="reliable", points=path),
                   oftLayers=dict(orientation=dict(source="tail_silhouette", head=point((200, 57)) if wall and rearing else path[0], tailBase=path[-1])))
        rows.append(row)
    config = dict(protocol="open_field", arena=dict(cornersPx=[point(p) for p in [(0, 100), (400, 100), (400, 400), (0, 400)]]))
    return rows, config


class RearingEvidenceTests(unittest.TestCase):
    def test_shorter_compact_body_with_transition_is_only_a_pending_proposal(self):
        rows, config = sequence()
        before = copy.deepcopy(rows)
        report, predictions = analyze(rows, config)
        self.assertEqual(len(report["candidates"]), 1)
        candidate = report["candidates"][0]
        self.assertEqual(candidate["verification"], "limited")
        self.assertIn("shortened_axis", candidate["reasons"])
        self.assertIn("posture_transition", candidate["reasons"])
        self.assertFalse(report["durationMeasured"])
        self.assertTrue(candidate["boundariesEstimated"])
        self.assertFalse(report["scientificallyValidated"])
        self.assertTrue(all(p["reviewStatus"] == "pending" and not p["metricEligible"] for p in predictions))
        self.assertEqual(rows, before)

    def test_wall_evidence_and_proposals_are_rotation_and_scale_invariant(self):
        for angle, scale in [(0, 1), (90, 1), (37, 2)]:
            with self.subTest(angle=angle, scale=scale):
                rows, config = sequence(wall=True, angle=angle, scale=scale)
                report, _ = analyze(rows, config)
                self.assertEqual(len(report["candidates"]), 1)
                c = report["candidates"][0]
                self.assertEqual(c["verification"], "consistent")
                self.assertIn("image_supported_head_on_wall", c["reasons"])
                self.assertFalse(c["metricEligible"])

    def test_short_axis_alone_is_insufficient(self):
        rows, config = sequence()
        for i in range(65, 86):
            rows[i]["contour"] = copy.deepcopy(rows[0]["contour"])
        report, _ = analyze(rows, config)
        self.assertEqual(report["candidates"], [])

    def test_wall_without_current_image_head_anchor_does_not_confirm_direction(self):
        rows, config = sequence(wall=True)
        for row in rows:
            row["oftLayers"]["orientation"]["source"] = "temporal_estimate"
        report, _ = analyze(rows, config)
        self.assertEqual(report["candidates"], [])

    def test_brief_shape_change_and_unobserved_gaps_do_not_form_an_episode(self):
        rows, config = sequence()
        for i in range(65, 86):
            if i % 3:
                rows[i]["source"] = "predicted"
        report, _ = analyze(rows, config)
        self.assertEqual(report["candidates"], [])

    def test_reflections_clipping_outliers_and_display_estimates_are_not_evidence(self):
        for mutation in [dict(source="recovered"), dict(reason="hybrid_silhouette_clipped"),
                         dict(bodyAxis=dict(state="outlier", points=[])),
                         dict(reflectionGuard=dict(bodySupportFraction=.1)),
                         dict(bodyAxisContour=[])]:
            rows, config = sequence()
            for row in rows[65:86]:
                row["oftLayers"]["visualization"] = dict(points=copy.deepcopy(row["bodyAxis"]["points"]), source="held_estimate")
                row.update(mutation)
            report, predictions = analyze(rows, config)
            self.assertEqual(report["candidates"], [])
            self.assertTrue(all(p["classification"] == "UNKNOWN" for p in predictions[65:86]))

    def test_intervention_latches_and_pending_hand_frames_are_excluded(self):
        rows, config = sequence()
        rows[60]["reason"] = "researcher_intervention_pending"
        rows[61]["reason"] = "researcher_intervention"
        report, predictions = analyze(rows, config)
        self.assertEqual(report["candidates"], [])
        self.assertEqual(report["trackingTermination"]["frameIndex"], 61)
        self.assertTrue(all(p["score"] is None and p["classification"] == "UNKNOWN" for p in predictions[60:]))

    def test_missing_baseline_and_invalid_clock_or_protocol_are_explicit(self):
        rows, config = sequence()
        report, _ = analyze(rows[:10], config)
        self.assertEqual(report["state"], "insufficient_evidence")
        self.assertEqual(report["candidates"], [])
        for change in [dict(frameIndex=1000), dict(timestampSec=0), dict(timestampSec=float("nan"))]:
            invalid = copy.deepcopy(rows)
            invalid[10].update(change)
            with self.assertRaises(ValueError):
                analyze(invalid, config)
        with self.assertRaises(ValueError):
            analyze(rows, dict(protocol="forced_swim"))

    def test_an_outlying_shape_cannot_bridge_two_subthreshold_fragments(self):
        rows, config = sequence()
        for i in range(73, 86):
            rows[i] = dict(copy.deepcopy(rows[0]), frameIndex=i, timestampSec=i/20)
        rows[68]["contour"] = [dict(x=700+(p["x"]-700)*.2, y=700+(p["y"]-700)*.2) for p in rows[68]["contour"]]
        # Put the raw axis inside the tiny current silhouette as well, so the
        # rejection tests relative body scale rather than point containment.
        rows[68]["bodyAxis"]["points"] = [dict(x=700+(p["x"]-700)*.2, y=700+(p["y"]-700)*.2) for p in rows[68]["bodyAxis"]["points"]]
        report, predictions = analyze(rows, config)
        self.assertEqual(predictions[68]["reasons"], ["geometry_outlier"])
        self.assertEqual(report["candidates"], [])

    def test_preview_writes_auditable_results_without_rewriting_tracking(self):
        rows, config = sequence()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/"samples.jsonl"
            source.write_text("".join(json.dumps(r)+"\n" for r in rows))
            before = source.read_bytes()
            request = root/"request.json"
            request.write_text(json.dumps(dict(samples=str(source), config=config, videoSha256="a"*64)))
            run(request, root/"candidates.json")
            report = json.loads((root/"candidates.json").read_text())
            self.assertEqual(len(report["candidates"]), 1)
            self.assertEqual(report["videoSha256"], "a"*64)
            self.assertEqual(len((root/"evidence_predictions.jsonl").read_text().splitlines()), len(rows))
            self.assertEqual(source.read_bytes(), before)

    def test_comparison_respects_undo_and_source_and_never_feeds_detection(self):
        rows, config = sequence()
        candidates = analyze(rows, config)[0]["candidates"]
        context = dict(videoSha256="a"*64, trackingJobId="tracking")
        peak = dict(context, type="PEAK", id="peak", timestampSec=candidates[0]["timestampSec"], label="REARING_UNSPECIFIED")
        history = [peak, dict(context, type="UNDO", id="undo", targetId="peak"),
                   dict(peak, id="current"), dict(peak, id="foreign", videoSha256="b"*64)]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            samples = root/"samples.jsonl"
            samples.write_text("".join(json.dumps(r)+"\n" for r in rows))
            request = root/"request.json"
            request.write_text(json.dumps(dict(context, samples=str(samples), config=config, annotations=history)))
            run(request, root/"candidates.json")
            report = json.loads((root/"candidates.json").read_text())
            self.assertEqual(report["candidates"], candidates)
            comparison = report["annotationComparison"]
            self.assertEqual(comparison["annotatedPeaks"], 1)
            self.assertEqual(comparison["truePositive"], 1)
            self.assertFalse(comparison["annotationsUsedForDetection"])
            self.assertFalse(comparison["independentValidation"])

    def test_an_ambiguous_axis_can_supply_only_silhouette_evidence(self):
        rows, config = sequence()
        for row in rows[65:86]:
            row["bodyAxis"] = dict(state="ambiguous", points=[], reason="ambiguous_orientation")
        report, _ = analyze(rows, config)
        self.assertEqual(len(report["candidates"]), 1)
        candidate = report["candidates"][0]
        self.assertEqual(candidate["verification"], "limited")
        self.assertIsNone(candidate["evidence"]["axisLengthRatio"])
        self.assertNotIn("shortened_axis", candidate["reasons"])

    def test_missing_legacy_axis_is_measured_without_altering_saved_rows(self):
        rows, config = sequence()
        for row in rows:
            row.pop("bodyAxis")
        before = copy.deepcopy(rows)
        report, _ = analyze(rows, config)
        self.assertEqual(report["state"], "proposed")
        self.assertEqual(rows, before)


if __name__ == "__main__":
    unittest.main()
