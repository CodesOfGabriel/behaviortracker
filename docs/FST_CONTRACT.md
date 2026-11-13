# Forced Swim Test (FST) contract

FST uses `testType: "forced_swim"`, `analysisMethodVersion: "fst-0.1"`, and `analysisEngine: "fst_superanimal_quadruped_v1"`. It has one or two subjects, each paired with one fixed rectangular tank ROI. It has no Open Field arena or `oft-*` metric. `schemas/fst-experiment.schema.json` describes the persisted experiment; `schemas/fst-result.schema.json` describes the result loaded by the UI. TypeScript, Rust, and Python validate the ROI boundary and subject pairing before inference. The ROI height minimum of 55% of the video follows the v6.2 notebook's full-cylinder check.

## Inference and presence

`fst_pipeline.py` adapts the v6.2 notebook's `create_superanimal_inference_runners` call: DeepLabCut 3.0.2, `superanimal_quadruped`, HRNet-w32, 39 points, CUDA, `detector_name=None`, one fixed crop and one individual per tank. It uses 20-second chunks, GPU-dependent batches, OOM retry at half batch size, and NPZ checkpoints. Each pose coordinate in the UI/result CSV is translated from crop to uploaded-video pixels. For videos over 100 MiB, the upload may be downscaled to 1080p; the result and manifest record both uploaded and source dimensions. The raw NPZ retains crop coordinates and the uploaded rectangle.

`fst_presence.py` starts from the v6.4 notebook's dark temporal reference, silhouette evidence, rejection of narrow reflections, and temporal debounce. A static-silhouette fallback adds evidence when an animal appears from the beginning and is absorbed into the temporal background. If temporal evidence confirms an entry later, earlier static candidates remain `UNCERTAIN` instead of confirming a stationary reflection as an animal. Presence never reads DLC pose coverage. `NOT_IN_TANK` and `UNCERTAIN` suppress boxes and points in the player. A lost pose cannot change presence. This heuristic has only the notebook's initial short-video evidence; new lighting and tanks need visual review. An uncertain frame is not counted as absent or immobile.

The dynamic box uses the v6.4 pose-supported segmentation and prior-box logic. It is independent of the fixed search ROI and does not prove the anatomical points are correct. The MP4 is rendered at the uploaded dimensions and FPS. The browser preview may estimate FPS; the result and manifest record FPS and frame count read by OpenCV in the Colab runtime. The manifest records the experiment title, group and notes, plus both the original file SHA-256 and the SHA-256 of the uploaded copy. Reattachment compares original-file hashes even if preparation creates different bytes. Lossy compression and downscaling can affect fine anatomical details, so comparative studies need frame review.

## Indicators and review

`relativeMotion` and `centroidMotion` are observed movement normalized by the diagonal of the fixed ROI per second. They require at least three valid point pairs at likelihood >= 0.60 and reject jumps greater than 25% of that diagonal. `silhouetteChange` is the absolute frame-to-frame change in the fraction of visually detected foreground pixels per second; it is a visual proxy, not a trained behavior label. One and three-second windows use the v6.2 reliability rule (at least 60% measurable frames and mean pose coverage at least 12%). Low and high observed movement are review priorities based on each animal's quartiles, never behavior predictions. All automatic classifications are `NOT_CLASSIFIED`. Human annotations are append-only events with subject, time interval, label, source, analysis version, timestamp, and run ID. They are stored with the local experiment. The reviewed manifest export joins them to the selected run's immutable manifest.

## Local artifacts

The Colab job stores each file below the app's `results` directory using the job UUID as a prefix. Downloads verify size and SHA-256 before publication:

- `<job>.json`: UI result, frame indicators and compact per-frame pose arrays in uploaded-video pixels; source dimensions are recorded for coordinate conversion.
- `<job>-animal_N_pose_raw.csv`: one row per point and frame, crop and original coordinates, likelihood.
- `<job>-animal_N_pose_raw.npz`: raw pose array, FPS, original ROI, point names.
- `<job>-presence.csv`, `<job>-presence_events.csv`, `<job>-presence_summary.csv`, `<job>-activity.csv`, `<job>-boxes.csv`, `<job>-activity_windows_1s.csv`, `<job>-activity_windows_3s.csv`, `<job>-review_shortlist.csv`: independent per-animal observations and review priorities.
- `<job>-run_manifest.json`, `<job>-execution_report.json`: algorithm and video identity, parameters, quality and runtime.
- `<job>-dlc.mp4`: MP4 annotated only for confirmed presence.

The checkpoint key hashes the original video SHA-256, fixed ROIs, DLC version, model identity, frame count, FPS, engine, and algorithm version. A changed input receives a different cache directory. Cache reuse is available while the same Colab runtime retains `/content/behavetracker/fst-cache`; historical local artifacts are never overwritten by a new job. The model fingerprint is a configuration fingerprint, not a checksum of the downloaded neural weights.

The notebooks in `Downloads` are experimental references. A local presence smoke check decoded the first 12 seconds of `nado01.mp4` to 960 × 540 JPEG frames at 5 FPS and used approximate full-cylinder ROIs; the first confirmed presence was 3.4 s for animal 1 and 3.6 s for animal 2. This check exposed and resolved a static-reflection false positive in animal 1. It does not validate full-resolution presence accuracy, CUDA inference, the Colab API, or video rendering on a real GPU run. Those require a real Colab run and manual frame review before scientific use.
