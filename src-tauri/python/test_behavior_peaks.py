import copy
import csv
import json
from pathlib import Path
import tempfile
import unittest
import cv2 as cv
import numpy as np
from behavior.intervention import InterventionGuard
from behavior.export_dataset import active_annotations, export_annotations
from behavior.observation_quality import behavior_observation_quality
from behavior.peak_model import features, match_peaks, predict_forest, proposals


def config():
    return dict(width=320, height=240, arena=dict(cornersPx=[dict(x=50,y=30), dict(x=270,y=30), dict(x=270,y=220), dict(x=50,y=220)]))


def sample(index=0):
    return dict(frameIndex=index, timestampSec=index/24, source="segmented", status="valid", trackingAccepted=True,
        bbox=dict(x=90,y=90,width=30,height=20), contour=[dict(x=90,y=90), dict(x=120,y=90), dict(x=120,y=110), dict(x=90,y=110)],
        features=dict(speedPxSec=None, axisRad=None), localQuality=dict(tracking="observed",geometry="floor",reasons=[]))


class InterventionTests(unittest.TestCase):
    def test_large_intrusion_latches_and_never_emits_hand_boxes(self):
        for colour in ((0,0,0), (255,255,255), (200,50,20)):
            background=np.full((240,320,3),128,np.uint8)
            guard=InterventionGuard(config(),background)
            frame=background.copy(); cv.rectangle(frame,(0,70),(125,190),colour,-1)
            self.assertIsNone(guard.update(frame,10))
            pending=guard.suppress(sample())
            self.assertEqual(pending["status"],"missing")
            stop=guard.update(frame,10.1)
            self.assertEqual(stop["timestampSec"],10)
            self.assertEqual(stop["reason"],"researcher_intervention")
            self.assertEqual(guard.update(background,20),stop)
            suppressed=guard.suppress(sample())
            self.assertIsNone(suppressed["xPx"])
            self.assertNotIn("bbox",suppressed)
            self.assertNotIn("contour",suppressed)
            self.assertFalse(suppressed["trackingAccepted"])
            self.assertEqual(behavior_observation_quality(suppressed),"UNOBSERVED")

    def test_animal_near_wall_and_internal_blob_do_not_latch(self):
        background=np.full((240,320,3),128,np.uint8)
        for kind in ("animal", "internal"):
            guard=InterventionGuard(config(),background)
            frame=background.copy()
            if kind=="animal": cv.ellipse(frame,(52,90),(12,8),0,0,360,(255,255,255),-1)
            else: cv.rectangle(frame,(90,70),(180,180),(0,0,0),-1)
            for timestamp in (0,.1,.2): self.assertIsNone(guard.update(frame,timestamp))
            self.assertIsNone(guard.pending)

    def test_single_frame_intrusion_only_quarantines_that_frame(self):
        background=np.full((240,320,3),128,np.uint8)
        guard=InterventionGuard(config(),background)
        frame=background.copy();cv.rectangle(frame,(0,70),(125,190),(0,0,0),-1)
        guard.update(frame,1);guard.update(background,1.04)
        self.assertIsNone(guard.stopped)
        self.assertEqual(guard.suppress(sample())["bbox"],sample()["bbox"])

    def test_frame_edge_is_an_entry_boundary_when_arena_fills_the_image(self):
        background=np.full((240,320,3),128,np.uint8)
        full=dict(width=320,height=240,arena=dict(cornersPx=[dict(x=0,y=0),dict(x=319,y=0),dict(x=319,y=239),dict(x=0,y=239)]))
        guard=InterventionGuard(full,background)
        frame=background.copy();cv.rectangle(frame,(0,70),(125,190),(0,0,0),-1)
        guard.update(frame,1)
        self.assertIsNotNone(guard.update(frame,1.1))


class PeakModelTests(unittest.TestCase):
    def test_nullable_motion_and_post_intervention_context_are_masked(self):
        samples=[sample(i) for i in range(32)]
        baseline,usable,_=features(samples,cutoff=.5)
        self.assertTrue(np.isfinite(baseline).all())
        self.assertFalse(usable[12:].any())
        changed=copy.deepcopy(samples)
        for row in changed[12:]:
            row["bbox"]["width"]=100
            row["features"]["speedPxSec"]=5000
        other,_,_=features(changed,cutoff=.5)
        np.testing.assert_array_equal(baseline,other)

    def test_plateau_is_one_apex_and_matches_are_one_to_one(self):
        samples=[sample(i) for i in range(48)]
        scores=np.zeros(48);scores[5:20]=.8;scores[30]=.9
        indices=proposals(samples,scores,np.ones(48,bool),.5,.3)
        self.assertEqual(indices,[5,30])
        metrics=match_peaks([.1,.2,.3],[.2],.5)
        self.assertEqual((metrics["truePositive"],metrics["falsePositive"],metrics["falseNegative"]),(1,2,0))

    def test_portable_forest_routes_to_probabilities_without_sklearn(self):
        trees=[dict(feature=[0,-2,-2],threshold=[.5,-2,-2],left=[1,-1,-1],right=[2,-1,-1],positive=[.5,.1,.9])]
        np.testing.assert_allclose(predict_forest(trees,np.array([[.4],[.6]],np.float32)),[.1,.9])

    def test_corrupt_cyclic_forest_raises_instead_of_hanging(self):
        trees=[dict(feature=[0],threshold=[.5],left=[0],right=[0],positive=[.5])]
        with self.assertRaisesRegex(ValueError,"cíclica"):
            predict_forest(trees,np.array([[.4]],np.float32))

    def test_other_protocols_are_rejected_before_loading_a_model(self):
        from behavior.peak_model import analyze
        for protocol in ("radial_arm_maze","forced_swim"):
            with self.assertRaisesRegex(ValueError,"exclusivo do Campo Aberto"):
                analyze(dict(config=dict(protocol=protocol)),"/absent")


class NativeAnnotationExportTests(unittest.TestCase):
    def test_proposal_decisions_export_human_peaks_and_rejections_only_in_history(self):
        peak=dict(id="p",type="PEAK",timestampSec=.125,frameIndex=3,label="REARING_UNSPECIFIED",annotatorId="A",videoSha256="a"*64,trackingJobId="t")
        review=dict(id="r",type="PROPOSAL_REVIEW",decision="accept",frameIndex=3,timestampSec=.125,peakId="p",annotatorId="A")
        rejected=dict(id="n",type="PROPOSAL_REVIEW",decision="reject",frameIndex=4,timestampSec=.17,annotatorId="A")
        events=[peak,review,dict(id="tag",type="LABEL_PEAK",targetId="p",label="REARING_SUPPORTED",annotatorId="B"),rejected]
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/"request.json"
            source.write_text(json.dumps(dict(experimentId="v",annotations=events)))
            export_annotations(source,root/"peaks.csv","peaks")
            with self.assertRaisesRegex(ValueError,"Não há marcações"):
                export_annotations(source,root/"intervals.csv","intervals")
            export_annotations(source,root/"history.jsonl","history")
            with (root/"peaks.csv").open(encoding="utf-8-sig",newline="") as stream: rows=list(csv.DictReader(stream))
            self.assertEqual(len(rows),1);self.assertEqual(rows[0]["label"],"REARING_SUPPORTED")
            self.assertEqual(active_annotations(events)[0],[])
            self.assertEqual([json.loads(line) for line in (root/"history.jsonl").read_text().splitlines()],events)
            events.extend([dict(id="u",type="UNDO",targetId="p"),{**review,"id":"r2","decision":"reject"}])
            source.write_text(json.dumps(dict(experimentId="v",annotations=events)))
            with self.assertRaisesRegex(ValueError,"Não há marcações"):
                export_annotations(source,root/"peaks.csv","peaks")
            self.assertEqual(active_annotations(events),([],[]))

    def test_apex_only_csv_resolves_edits_undo_and_preserves_unicode(self):
        peak=dict(id="p",type="PEAK",timestampSec=.125,frameIndex=3,label="REARING_SUPPORTED",annotatorId="Observação",videoSha256="a"*64,trackingJobId="t")
        events=[peak,{**peak,"id":"deleted"},dict(type="LABEL_PEAK",targetId="p",label="REARING_UNSUPPORTED",annotatorId="Revisão"),dict(type="UNDO",targetId="deleted")]
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/"request.json";source.write_text(json.dumps(dict(experimentId="v",annotations=events)))
            export_annotations(source,root/"peaks.csv","peaks")
            with (root/"peaks.csv").open(encoding="utf-8-sig",newline="") as stream: rows=list(csv.DictReader(stream))
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]["label"],"REARING_UNSUPPORTED")
            self.assertEqual(rows[0]["annotator_id"],"Revisão")
            self.assertEqual(rows[0]["timestamp_sec"],"0.125")
            self.assertNotIn("start_sec",rows[0])


if __name__=="__main__": unittest.main()
