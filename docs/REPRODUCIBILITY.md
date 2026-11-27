# Reproducing Behavior Tracker analyses

This inventory describes the source prepared for application version **0.1.7**, reviewed
on 2026-11-27. It records implemented dependency choices and known gaps; it does
not certify scientific accuracy or successful execution on every platform.

## Source and application dependencies

Preserve the exact source commit/tag, application version, operating system,
architecture, and toolchain versions used for an analysis. The repository URL is
<https://github.com/CodesOfGabriel/behaviortracker>.

| Layer | Recorded dependency source | Reproduction notes |
| --- | --- | --- |
| React/TypeScript/Vite/Tauri JavaScript packages | `package.json`, `package-lock.json` | Use `npm ci`; CI selects Node 22. See [QUALITY_GATE.md](QUALITY_GATE.md) for local prerequisites. |
| Rust/Tauri/SQLite backend | `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` | Use Cargo's `--locked` option when invoking Cargo directly. CI selects the moving `stable` toolchain; record `rustc -Vv` and `cargo -V`. |
| Native desktop dependencies | `.github/workflows/build-installers.yml` | Linux system packages and platform targets are listed there. System packages and runner images are not fully frozen. |
| FFmpeg/FFprobe sidecars | `scripts/prepare-video-tools.mjs`, installer workflow | CI installs `ffmpeg-static@5.3.0` and `@derhuerst/ffprobe-static@5.3.0` in a separate directory. Development can fall back to PATH binaries. Record each binary's version/build and SHA-256; the encoder must include `libx264`. |
| Python regression-test environment | `scripts/quality/requirements.txt` | Direct test dependencies are pinned; this is not a complete inference or training environment lock. |

The existing quality setup is documented in [QUALITY_GATE.md](QUALITY_GATE.md).
For a prepared development machine, the existing commands are:

```sh
npm ci
npm run test:setup
npm run verify
```

These commands are instructions, not evidence that a particular archived source
snapshot passed all checks. Desktop compilation additionally requires the
native Tauri prerequisites and the OAuth build configuration enforced by the
existing build scripts. Record configuration requirements without distributing
private credentials or local environment files.

## Python processing environments

| Workflow | Dependencies selected in code | Source |
| --- | --- | --- |
| Local classical OFT/RAM and local FST presence | `opencv-python-headless==4.13.0.92` in an isolated environment; NumPy is resolved as a dependency | `src-tauri/src/local_tracking.rs` |
| Local Wistar detector/pose | Python 3.10–3.13, 64-bit; `deeplabcut==3.0.2`, `opencv-python-headless==4.13.0.92` | `src-tauri/python/local_wistar.py` |
| Local Wistar PyTorch CPU or CUDA 13.0 branch | `torch==2.14.1`, `torchvision==0.29.1`; wheel index selected as `cpu` or `cu130` | `pytorch_build()` in `local_wistar.py` |
| Local Wistar CUDA 12.8 branch | `torch==2.8.0`, `torchvision==0.23.0`, `cu128` wheel index | Same function, according to detected NVIDIA capabilities/driver |
| Colab Wistar hybrid and FST setup | DeepLabCut `3.0.2`; CUDA required, other packages partly inherited from Colab | `prepare_hybrid_environment()` and `prepare_fst_environment()` in `src-tauri/src/colab.rs` |
| Other/legacy Colab setup | Also contains a `deeplabcut[modelzoo]>=3.0.0rc1,<4` installation path | `src-tauri/src/colab.rs`; do not assume every Colab route has the same environment |
| Optional local behavior classifier | `onnxruntime==1.20.1`, `opencv-python-headless==4.13.0.92`, isolated from tracking | `src-tauri/src/local_behavior.rs`; trained classifier bundle required |
| Experimental rearing training | Script/notebook-specific PyTorch, ONNX, NumPy, OpenCV, scikit-learn and export dependencies | `scripts/behavior/`, [OFT_REARING_V1.md](OFT_REARING_V1.md) |

These are installation choices read from code, not a newly tested compatibility
matrix or a guarantee that every wheel exists for every OS/Python combination.
The Intel macOS wheel limitations are documented in
[OFT_REARING_V1.md](OFT_REARING_V1.md) and [QUALITY_GATE.md](QUALITY_GATE.md).

There is no complete, platform-specific Python inference/training lock with
transitive package hashes. Colab runtimes and automatically selected CUDA
builds can change. Before preserving a study, save `python --version`,
`python -m pip freeze --all`, the selected package indexes, GPU/driver/CUDA
information when applicable, and FFmpeg/FFprobe build details from the actual
environments used. A freeze records versions but does not itself preserve
wheels, system libraries, or model files.

## Neural model inventory

The authoritative delivery manifest for current Wistar inference is
[`models/wistar_df_v2/manifest.json`](../models/wistar_df_v2/manifest.json):
bundle `wistar_df_v2`, revision `r1`, release tag `models-wistar-df-v2-r1`,
runtime contract `deeplabcut-pytorch-3`, Faster R-CNN ResNet-50 FPN v2 detector,
and HRNet-W32 pose with 27 keypoints. It is used by OFT and experimental RAM,
not by the FST SuperAnimal route.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `best_detector.pth` | 173392347 | `211891e0ec5f5b3f56d0f0be5b9255319ce9857284e72e558ccfc9f4ca93eef0` |
| `snapshot-hrnet_w32-001.pt` | 118196193 | `d81c8f18ba0729263168b96eab3e09b6bc3d0ee194b131fb381d2526266ff215` |
| `pytorch_config.yaml` | 5996 | `847076c1253f53816155fe247ca1448a13039498d902c2d75b24dac9d800f907` |

The manifest contains fixed GitHub download URLs for the two checkpoints. The
YAML is tracked in the repository and bundled with the application. Checkpoints
are excluded from the tracked source and installer resources; an ordinary
GitHub source archive sent to Zenodo does not include them. See
[MODEL_DELIVERY_V2.md](MODEL_DELIVERY_V2.md) for caching and integrity checks.

```sh
node scripts/check-release-models.mjs
node scripts/check-release-models.mjs --local
```

The first command checks the registry, small configuration, and absence of
checkpoint resources in the installer configuration. The second also verifies
local weights under `models/wistar_df_v2/`. For a complete remote payload
integrity check, `node scripts/check-release-models.mjs --remote` streams about
292 MB; availability of a release page alone does not verify its payload bytes.

During the 2026-11-27 metadata audit, the local check above passed. The public
GitHub release API also reported asset URLs, sizes, and SHA-256 digests matching
both manifest checkpoints. During the subsequent 0.1.7 preparation, the full
`--remote` streaming check also passed for both assets; no new model release
was created. This establishes retrieval and integrity at the check time,
not permanent archival preservation or a license grant.

The older `models/wistar_df_v1.manifest.json` identifies a different detector
hash/size. Preserve the manifest actually used by an analysis rather than
substituting v1 and v2 weights. The v2 manifest explicitly states
`experimental; train/validation only; independent test unavailable`.

The FST neural route calls DeepLabCut's `superanimal_quadruped` / `hrnet_w32`
model with its separate visual presence pipeline. `fst_pipeline.py` records a
model name and a cache fingerprint covering video, configuration, code, and
DeepLabCut version. That fingerprint is not a SHA-256 of the downloaded model
weights. No equivalent committed, immutable SuperAnimal asset manifest with
expected weight hashes was found. Preserve the exact downloaded weights,
upstream revision, hashes, and applicable terms for a reproducible FST study.

`models/oft_rearing_v1/manifest.json` has version `0.1.0-untrained`, an empty
`files` object, `availability: awaiting_human_annotations_and_training`, and no
validation results. It is a classifier contract, not a distributed trained
model. Operator-fitted peak models are separate, session-derived experimental
artifacts; preserve their exported manifest, data, labels, and training
parameters. Neither detector/pose weights nor a local peak fit establish an
independently validated rearing classifier.

## Preserving an analysis and remaining gaps

Archive the original input video and its SHA-256, any prepared video and frame
mapping, experimental protocol/geometry/calibration, request/configuration,
model bundle and hashes, raw detections/poses, quality masks, reviewed
annotations and annotator identities, metric policy/version, and available run
manifests. Keep automated observations and human corrections distinguishable.
Artifact names vary by workflow; the [README](../README.md#reprodutibilidade-e-exportação)
lists the current export families. Video/annotation redistribution requires the
appropriate permissions and is not implied by publication of the source.

The Wistar manifests document architectures and checkpoint identities, but the
repository does not provide a complete public training-data/annotation archive,
split manifest, and training history sufficient to recreate those trained
weights. Inference reproducibility and retraining reproducibility therefore
have different remaining requirements. The maintainer has authorized Apache-2.0
for the project code. Explicit reuse terms and upstream provenance for the
distributed Wistar weights still require clarification; third-party notices
must not be used to infer those permissions. See the
[third-party license review](THIRD_PARTY_LICENSES.md), including SuperAnimal's
non-commercial research terms and CoTracker's CC BY-NC 4.0 license.

The optional CoTracker recovery assets already have immutable code/checkpoint
revisions and expected sizes/SHA-256 in
`src-tauri/python/hybrid/temporal_assets.py`. Both the code ZIP and checkpoint
passed full remote size/SHA-256 streaming checks during the 0.1.7 preparation.
FST/SuperAnimal remains the route without an equivalent committed immutable
weight manifest. No inference engine has been changed merely to make a
reproducibility claim.

Before a scientific archive, resolve those licensing decisions, preserve the
required model assets through an approved archival route, capture the actual
runtime environments, and document any data that cannot be shared. No model
DOI, dataset DOI, funding, or validation result is asserted here. Metadata
approval remains tracked in [ZENODO_PUBLICATION.md](ZENODO_PUBLICATION.md).
