"""Layer integration uses real pixels, CSV, classifier and MP4; no GPU required."""
import copy
import csv
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import cv2 as cv
import numpy as np
from body_axis import BodyAxisFilter
from oft_layers import LayeredTracker, digest, silhouette, visual_descriptor
from oft_layered_pipeline import cached_detector, run


def animal(angle=0, light=True, tail=True, center=(160,120)):
    floor, body = (40,210) if light else (220,30)
    image=np.full((240,320,3),floor,np.uint8)
    mask=np.zeros(image.shape[:2],np.uint8)
    cv.ellipse(mask,center,(37,14),angle,0,360,255,-1)
    theta=np.deg2rad(angle); direction=np.array([np.cos(theta),np.sin(theta)])
    if tail:
        a,b=np.rint(np.array(center)-35*direction).astype(int),np.rint(np.array(center)-70*direction).astype(int)
        cv.line(image,tuple(a),tuple(b),(body,)*3,3)
    image[mask>0]=body
    x,y,w,h=cv.boundingRect(cv.findNonZero(mask))
    box=dict(x=x-3,y=y-3,width=w+6,height=h+6)
    return image,box,np.full_like(image,floor),direction


def observed(image,box,background,index=0):
    shape=silhouette(image,box,background)
    assert shape is not None
    row=dict(frameIndex=index,timestampSec=index/20,source="segmented",status="valid",trackingAccepted=True,
             localQuality=dict(tracking="observed",geometry="floor",reasons=[]),**shape)
    row["bodyAxis"]=BodyAxisFilter().update(row)
    return row


def video_fixture(root,count=40,intervention=None,wall=False):
    video=root/"input.mp4"; writer=subprocess.Popen([shutil.which("ffmpeg"),"-v","error","-y","-f","rawvideo","-pix_fmt","bgr24","-s","320x240","-r","20","-i","-","-an","-c:v","libx264","-pix_fmt","yuv420p",str(video)],stdin=subprocess.PIPE)
    detections=[]
    for i in range(count):
        image,box,_,_=animal(angle=90,tail=False,center=(65+i*5,70)) if wall else animal(center=(100+i*3,120))
        if wall:
            bottom=box["y"]+box["height"]
            box={**box,"y":80,"height":bottom-80} # Historical floor-only box.
        if intervention and intervention[0]<=i<intervention[1]:
            cv.rectangle(image,(0,60),(130,180),(130,160,190),-1)
        writer.stdin.write(image.tobytes())
        detections.append(dict(frame=i,observed=True,x=box["x"],y=box["y"],w=box["width"],h=box["height"],score=.95))
    writer.stdin.close(); assert writer.wait()==0
    output=root/"output";output.mkdir()
    with (output/"detections.csv").open("w",newline="") as handle:
        w=csv.DictWriter(handle,fieldnames=list(detections[0]));w.writeheader();w.writerows(detections)
    return video,detections,output


def model_fixture(root,probability=.9):
    directory=root/"model";directory.mkdir(exist_ok=True)
    tree=dict(feature=[-2],threshold=[-2],left=[-1],right=[-1],positive=[probability])
    model=dict(featureSchema="oft-apex-features-2",rearing=[tree],threshold=.5,minimumGapSec=.3)
    file=directory/"peak_model.json";file.write_text(json.dumps(model))
    manifest=dict(modelId="oft_rearing_apex_v1",featureSchema="oft-apex-features-2",sizeBytes=file.stat().st_size,sha256=digest(file))
    (directory/"manifest.json").write_text(json.dumps(manifest))
    return directory


class OrientationTests(unittest.TestCase):
    def test_head_marker_and_pending_proposals_never_paint_text(self):
        from oft_layers import draw_overlay
        image,box,bg,_=animal()
        row=observed(image,box,bg)
        row["oftLayers"]=LayeredTracker(320,240).update(image,row)
        with patch("oft_layers.cv.putText",side_effect=AssertionError("text on image")),patch("oft_layers.cv.polylines",wraps=cv.polylines) as lines:
            draw_overlay(image,row,dict(classification="REARING_UNSPECIFIED"))
        self.assertTrue(any(call.args[2] is True and len(call.args[1][0])==3 for call in lines.call_args_list))

    def test_export_draws_the_local_seven_node_skeleton_and_hides_rejected_axes(self):
        from oft_layers import draw_overlay
        from local_audit_video import AXIS
        image,box,bg,_=animal()
        row=observed(image,box,bg)
        blank=np.zeros_like(image)
        result=draw_overlay(blank.copy(),row)
        color=tuple(bytes.fromhex(AXIS))
        for p in row["bodyAxis"]["points"]:
            x,y=round(p["x"]),round(p["y"])
            self.assertEqual(tuple(result[y,x]),color)
            # Filled nodes must survive export, rather than hollow pose dots
            # covering the shared axis (the previous renderer regression).
            self.assertEqual(tuple(result[y+1,x+1]),color)
        for state in ["outlier","ambiguous","missing"]:
            rejected={**row,"bodyAxis":{**row["bodyAxis"],"state":state}}
            self.assertFalse(draw_overlay(blank.copy(),rejected).any())
        stopped={**row,"reason":"researcher_intervention"}
        self.assertFalse(draw_overlay(blank.copy(),stopped).any())

    def test_actual_tail_pixels_define_direction_for_both_polarities_and_eight_angles(self):
        for angle in range(0,360,45):
            for light in [False,True]:
                with self.subTest(angle=angle,light=light):
                    image,box,bg,direction=animal(angle,light)
                    row=observed(image,box,bg)
                    before=copy.deepcopy(row)
                    orientation=LayeredTracker(320,240).update(image,row)["orientation"]
                    self.assertEqual(orientation["state"],"estimated")
                    self.assertEqual(orientation["source"],"tail_silhouette")
                    self.assertFalse(orientation["metricEligible"])
                    head,tail=orientation["head"],orientation["tailBase"]
                    self.assertGreater(np.dot([head["x"]-tail["x"],head["y"]-tail["y"]],direction),25)
                    self.assertEqual(row,before)

    def test_an_undirected_axis_without_tail_is_not_assigned_a_head(self):
        image,box,bg,_=animal(tail=False)
        row=observed(image,box,bg)
        self.assertEqual(row["bodyAxis"]["state"],"reliable")
        orientation=LayeredTracker(320,240).update(image,row)["orientation"]
        self.assertEqual(orientation["state"],"ambiguous")
        self.assertIsNone(orientation["head"])

    def test_temporal_estimate_expires_without_refreshing_its_own_age(self):
        image,box,bg,_=animal(); row=observed(image,box,bg)
        tracker=LayeredTracker(320,240);tracker.update(image,row)
        with patch("oft_layers.tail_evidence",return_value=None):
            for i in range(1,17):
                current={**row,"frameIndex":i,"timestampSec":i/20}
                orientation=tracker.update(image,current)["orientation"]
                self.assertEqual(orientation["state"],"estimated" if i<=15 else "ambiguous")
                if i<=15:self.assertEqual(orientation["source"],"temporal_estimate")

    def test_an_isolated_direction_flip_needs_image_confirmation(self):
        image,box,bg,_=animal();row=observed(image,box,bg)
        tracker=LayeredTracker(320,240);first=tracker.update(image,row)["orientation"]
        opposite=(np.array([195.,120.]),np.array([230.,120.]))
        with patch("oft_layers.tail_evidence",return_value=opposite):
            for i in [1,2]:
                orientation=tracker.update(image,{**row,"timestampSec":i/20})["orientation"]
                self.assertEqual(orientation["source"],"temporal_estimate")
            orientation=tracker.update(image,{**row,"timestampSec":.15})["orientation"]
            self.assertEqual(orientation["source"],"tail_silhouette")
            self.assertLess(orientation["head"]["x"],first["head"]["x"])

    def test_intervention_is_latched_even_if_a_later_frame_contains_an_animal(self):
        image,box,bg,_=animal();row=observed(image,box,bg)
        tracker=LayeredTracker(320,240);tracker.update(image,row)
        for reason in ["researcher_intervention","observed"]:
            output=tracker.update(image,{**row,"reason":reason,"timestampSec":.1})
            self.assertEqual(output["orientation"]["state"],"missing")
            self.assertIsNone(output["orientation"]["head"])

    def test_crop_clipped_wall_and_two_competing_bodies_are_rejected(self):
        image=np.full((240,320,3),40,np.uint8)
        cv.rectangle(image,(50,50),(190,90),(210,)*3,-1)
        self.assertIsNone(silhouette(image,dict(x=80,y=40,width=60,height=60)))
        image[:]=40
        cv.ellipse(image,(120,120),(20,10),0,0,360,(210,)*3,-1)
        cv.ellipse(image,(200,120),(20,10),0,0,360,(210,)*3,-1)
        self.assertIsNone(silhouette(image,dict(x=90,y=90,width=140,height=60)))


class LayerPipelineTests(unittest.TestCase):
    def test_colab_box_csv_and_video_cover_observed_body_above_floor_only_detector(self):
        from test_arena import quad
        from hybrid_render import render
        from oft_layers import tracking_box
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);video,detections,output=video_fixture(root,wall=True)
            arena={"cornersPx":quad(40,80,280,220),"rimCornersPx":quad(20,15,300,225)}
            original=copy.deepcopy(detections)
            run(video,detections,output,arena,20,320,240)
            rows=[json.loads(line) for line in (output/"samples.jsonl").read_text().splitlines()]
            visible=[r for r in rows if r.get("contour")]
            self.assertGreater(len(visible),30)
            for row in visible:
                box=tracking_box(row)
                self.assertEqual(row["detectorBox"]["y"],80)
                self.assertLess(box["y"],40)
                self.assertTrue(all(box["x"]<=p["x"]<=box["x"]+box["width"] and box["y"]<=p["y"]<=box["y"]+box["height"] for p in row["contour"]))
                if row["bodyAxis"]["points"]:self.assertLess(min(p["y"] for p in row["bodyAxis"]["points"]),80)
                self.assertNotEqual(row["localQuality"]["geometry"],"floor")
            with (output/"canonical_pose.csv").open() as stream:canonical=list(csv.DictReader(stream))
            frame=visible[len(visible)//2]["frameIndex"]
            center=next(r for r in canonical if int(r["frame_index"])==frame and r["keypoint"]=="mouse_center")
            self.assertLess(float(center["bbox_y"]),40)
            self.assertEqual(center["status"],"low_confidence")
            self.assertEqual(detections,original)
            artifact=render(video,output,arena)
            self.assertTrue(artifact["available"],artifact["error"])
            self.assertEqual(artifact["visualization"]["trackingBoxPolicy"],"observed_detector_silhouette_union_v1")
            self.assertGreater(artifact["visualization"]["skeletonFrames"],0)

    def test_boundary_intrusion_ends_boxes_axes_endpoints_and_candidates_without_resuming(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);video,detections,output=video_fixture(root,40,(30,35))
            manifest=run(video,detections,output,{},20,320,240,model_directory=model_fixture(root))
            stage=json.loads((output/"layer_manifest.json").read_text())
            self.assertIsNotNone(stage["trackingTermination"])
            rows=[json.loads(l) for l in (output/"samples.jsonl").read_text().splitlines()]
            stopped=[r for r in rows if r["reason"]=="researcher_intervention"]
            self.assertTrue(stopped)
            self.assertEqual(stopped[-1]["frameIndex"],39)
            self.assertTrue(all(not r["bodyAxis"]["points"] and r["oftLayers"]["orientation"]["head"] is None for r in stopped))
            self.assertTrue(all(c["timestampSec"]<stage["trackingTermination"]["timestampSec"] for c in manifest["rearing"]["candidates"]))
            with (output/"canonical_pose.csv").open() as handle:canonical=list(csv.DictReader(handle))
            self.assertTrue(all(r["status"]=="missing" and not r["x_px"] and not r["bbox_x"] for r in canonical if int(r["frame_index"])>=stopped[0]["frameIndex"]))

    def test_cached_geometry_classifier_replacement_and_real_mp4_export(self):
        from hybrid_render import render
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);video,detections,output=video_fixture(root)
            first=run(video,detections,output,{},20,320,240)
            self.assertEqual(first["pipelineVersion"],"oft-layers-1")
            self.assertEqual(first["keypointCount"],10)
            self.assertEqual(first["rearing"]["state"],"model_unavailable")
            rows=[json.loads(line) for line in (output/"samples.jsonl").read_text().splitlines()]
            self.assertGreater(sum(r.get("trackingAccepted",False) for r in rows),30)
            geometry=digest(output/"samples.jsonl")
            model=model_fixture(root)
            with patch("oft_layered_pipeline.background_reference",side_effect=AssertionError("geometry reran")):
                second=run(video,detections,output,{},20,320,240,model_directory=model)
            self.assertTrue(second["geometryCacheReused"])
            self.assertEqual(geometry,digest(output/"samples.jsonl"))
            self.assertTrue(second["rearing"]["candidates"])
            self.assertFalse(second["rearing"]["durationMeasured"])
            visual=digest(output/"layer_visual.npy")
            model_fixture(root,.1)
            with patch("oft_layers.visual_descriptor",side_effect=AssertionError("visual descriptors reran")):
                third=run(video,detections,output,{},20,320,240,model_directory=model)
            self.assertEqual(third["rearing"]["candidates"],[])
            self.assertEqual(visual,digest(output/"layer_visual.npy"))
            artifact=render(video,output,{})
            self.assertTrue(artifact["available"],artifact.get("error"))
            from layer_video import capture
            cap=capture(output/artifact["filename"]);count=0
            while cap.read()[0]:count+=1
            cap.release();self.assertEqual(count,len(detections))
            self.assertEqual(artifact["visualization"]["version"],"oft-layered-video-4")
            self.assertEqual(artifact["visualization"]["skeletonFrames"],sum(r["bodyAxis"]["state"]=="reliable" for r in rows))
            self.assertGreater(artifact["visualization"]["skeletonFrames"],0)
            self.assertFalse(artifact["visualization"]["estimatedPointsMetricEligible"])
            with (output/"canonical_pose.csv").open() as handle: canonical=list(csv.DictReader(handle))
            self.assertEqual(len(canonical),len(detections)*10)
            estimates=[r for r in canonical if r["source"]=="recovered" and r["x_px"]]
            self.assertTrue(estimates)
            self.assertTrue(all(r["status"]=="low_confidence" and r["raw_status"]=="missing" for r in estimates))

    def test_saved_legacy_colab_video_rebuild_preserves_original_poses_and_reuses_geometry(self):
        from hybrid_render import REGIONS, render
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);video,detections,output=video_fixture(root)
            run(video,detections,output,{},20,320,240)
            with (output/"canonical_pose.csv").open() as stream: canonical=list(csv.DictReader(stream))
            # Historical jobs have 27 anatomical names, never the new nodes.
            legacy=[]
            for i in range(len(detections)):
                center=next(row for row in canonical if int(row["frame_index"])==i and row["keypoint"]=="mouse_center")
                legacy.extend({**center,"keypoint":name} for name in REGIONS)
            job="saved-job"
            csv_path=output/f"{job}.csv"
            with csv_path.open("w",newline="") as stream:
                writer=csv.DictWriter(stream,fieldnames=list(legacy[0]));writer.writeheader();writer.writerows(legacy)
            original=digest(csv_path)
            manifest=json.loads((output/"run_manifest.json").read_text())
            manifest.pop("pipelineVersion");manifest.update(keypoints=list(REGIONS),keypointCount=27)
            (output/f"{job}-run_manifest.json").write_text(json.dumps(manifest))
            shutil.copyfile(output/"detections.csv",output/f"{job}-detections.csv")
            # No saved layers in the job's namespace: this exercises the real
            # CPU upgrade path without detector/pose network execution.
            artifact=render(video,output,{},job_id=job)
            self.assertTrue(artifact["available"],artifact["error"])
            self.assertEqual(artifact["visualization"]["skeletonSource"],"saved_detections_cpu_geometry")
            self.assertGreater(artifact["visualization"]["skeletonFrames"],0)
            self.assertEqual(digest(csv_path),original)
            marker=output/f"{job}-video_artifact.json"
            self.assertEqual(json.loads(marker.read_text())["sha256"],digest(output/artifact["filename"]))
            with patch("oft_layered_pipeline.background_reference",side_effect=AssertionError("geometry reran")):
                replay=render(video,output,{},job_id=job)
            self.assertTrue(replay["available"],replay["error"])
            # Failed replacement retains the usable MP4 and its valid marker.
            before=digest(output/artifact["filename"]),marker.read_bytes()
            failed=render(root/"absent.mp4",output,{},job_id=job)
            self.assertFalse(failed["available"])
            self.assertEqual((digest(output/artifact["filename"]),marker.read_bytes()),before)

    def test_default_wistar_v2_main_invokes_layers_without_any_pose_network(self):
        from test_hybrid_precision_pipeline import load_pipeline
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);video,detections,output=video_fixture(root)
            scope=load_pipeline(root)
            scope.update(__file__=str(Path(__file__).with_name("hybrid_pipeline.py")),VIDEO=str(video),OUTPUT=output)
            scope["run_detector"]=lambda *_:(detections,[],len(detections),20,320,240)
            scope["pose_dataframe"]=lambda *_:self.fail("HRNet must not run in layers")
            (root/"models/snapshot-hrnet_w32-001.pt").unlink()
            (root/"models/pytorch_config.yaml").unlink()
            scope["main"]()
            manifest=json.loads((output/"run_manifest.json").read_text())
            self.assertEqual(manifest["pipelineVersion"],"oft-layers-1")
            self.assertFalse((output/"pose_raw.h5").exists())

    def test_cache_does_not_accept_modified_detection_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);video,detections,output=video_fixture(root)
            for row in detections:row["raw_x1"]=float(row["x"])
            with (output/"detections.csv").open("w",newline="") as handle:
                writer=csv.DictWriter(handle,fieldnames=list(detections[0]));writer.writeheader();writer.writerows(detections)
            result=(detections,[],len(detections),20,320,240)
            with patch("oft_layered_pipeline.atomic_json", wraps=__import__("oft_layered_pipeline").atomic_json):
                cached_detector(output,{"video":digest(video)},lambda:result)
            with patch("oft_layered_pipeline.digest", wraps=digest):
                restored=cached_detector(output,{"video":digest(video)},lambda:self.fail("cache missed"))
            self.assertIsInstance(restored[0][0]["raw_x1"],str)
            run(video,detections,output,{},20,320,240)
            with patch("oft_layered_pipeline.background_reference",side_effect=AssertionError("CSV audit fields invalidated geometry")):
                replay=run(video,restored[0],output,{},20,320,240)
            self.assertTrue(replay["geometryCacheReused"])
            with (output/"detections.csv").open("a") as handle:handle.write("\n")
            calls=[]
            cached_detector(output,{"video":digest(video)},lambda:(calls.append(1) or result))
            self.assertEqual(calls,[1])


if __name__=="__main__":unittest.main()
