# Behavior Tracker model card

Software source version: **0.1.7**, published on **2026-11-27**:
[10.5281/zenodo.24612625](https://doi.org/10.5281/zenodo.24612625).
The desktop installers currently available are **0.1.6**. This card
distinguishes evidence in the repository/checkpoints from the maintainer's
development history and from unresolved provenance. It does not license model
weights under Apache-2.0 or certify behavioral accuracy.

## Implemented model families

| Family | Architecture and role | Current status |
| --- | --- | --- |
| Wistar detector | Faster R-CNN ResNet-50 FPN v2; background/Wistar detection, bounding boxes | Custom-trained in Colab according to the maintainer; distributed as `best_detector.pth` in `models-wistar-df-v2-r1`. |
| Wistar pose | HRNet-W32; 27 named keypoints and likelihoods | Adapted anatomical estimator according to the maintainer; `snapshot-hrnet_w32-001.pt` in the same model release. |
| FST SuperAnimal | DeepLabCut SuperAnimal Quadruped HRNet-W32 with a separate visual-presence pipeline | Optional Colab route; behavioral categories remain unclassified pending human annotation. |
| Other/legacy SuperAnimal routes | SuperAnimal TopViewMouse, including adaptation | Used during development and retained in parts of the Colab integration; not interchangeable with the custom Wistar bundle. |
| Temporal recovery | CoTracker3 online, bounded image tracking | Optional image-supported estimates; recovered/predicted points do not become confirmed anatomical observations. |
| Rearing classifier | Baseline/visual/temporal training and ONNX runtime infrastructure | Distributed `oft_rearing_v1` is explicitly untrained. Local peak fits are experimental session-derived artifacts. |

The non-neural OpenCV paths remain available without neural-weight downloads.
No tracking, metric policy or model execution path was changed by this review.

## Exact distributed Wistar identities

The delivery manifest is
[`models/wistar_df_v2/manifest.json`](models/wistar_df_v2/manifest.json).

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `best_detector.pth` | 173392347 | `211891e0ec5f5b3f56d0f0be5b9255319ce9857284e72e558ccfc9f4ca93eef0` |
| `snapshot-hrnet_w32-001.pt` | 118196193 | `d81c8f18ba0729263168b96eab3e09b6bc3d0ee194b131fb381d2526266ff215` |
| `pytorch_config.yaml` | 5996 | `847076c1253f53816155fe247ca1448a13039498d902c2d75b24dac9d800f907` |

Local integrity and full remote streaming checks passed for both Wistar
checkpoints. This confirms the retrieved bytes and availability at review
time; it does not establish their training lineage or redistribution rights.
The configuration is tracked in the repository; weights are external assets.

## Training and provenance evidence

The maintainer reports using experimental video frames, manual annotations and
pseudoannotations, plus SuperAnimal TopViewMouse, video adaptation and transfer
learning during development. The exact chain from those sources to the two
currently distributed checkpoint hashes is **not yet established**.

Read-only examination of supplied original development notebooks found:

| Notebook evidence | What it establishes | Limit |
| --- | --- | --- |
| `BehaveTracker_Wistar_Detector_v2_Colab.ipynb`, SHA-256 `f236f31c251b3068dbd8135de7a8f07d391ebc8aca9b9cdc81060ece0bb58d00` | The training code selects a previous detector or `FasterRCNN_ResNet50_FPN_V2_Weights.DEFAULT`. | The notebook is not a cryptographic training receipt for the current checkpoint. The previous-checkpoint branch must also be traced. |
| Revised detector notebook, SHA-256 `42f8cc16b636cf06841273785f02383d80932c890b6bb1525b51b2e524d07bd0` | The same two initialization routes appear. | Dataset and initial-checkpoint identities are not sufficient to establish the complete distributed-model lineage. |
| `Diagnostico_DeepLabCut_Wistar_A100_COMPLETO.ipynb`, SHA-256 `352eaedb1291b10dcf1f98b95679ee152ca8f41b1ab2f2f3f44b942670fa42c1` | References `superanimal_topviewmouse` and video adaptation. | It proves that this workflow exists in the supplied materials, not that a particular output became the current HRNet file. |

Notebook outputs/private paths have not been republished. Checkpoints were
examined as ZIP containers with static pickle-opcode inspection, without
unpickling or executing them. Detector state/epoch and HRNet
metadata/model/optimizer-related keys were present, but no conclusive license,
upstream checkpoint hash, dataset identity or SuperAnimal lineage declaration
was identified. Tensor names or a `pretrained: false` configuration field
cannot prove training from scratch.

To resolve provenance, preserve the initial checkpoint/hash and source terms,
training notebook/code hash, actual parameters/seeds, dataset/split manifests,
manual and pseudoannotation sources, adaptation steps, environment, training
logs and resulting checkpoint hash. Do not reconstruct missing facts from
architecture names alone.

## Licenses and conditions of use

- Apache-2.0 applies to authorized Behavior Tracker code. It does **not** grant
  rights to the distributed custom weights, training videos or pseudoannotation
  sources.
- DeepLabCut 3.0.2 code is LGPL-3.0; its
  [SuperAnimal models are limited to non-commercial research use](https://github.com/DeepLabCut/DeepLabCut/blob/v3.0.2/README.md#license).
  A derivative's permitted redistribution cannot be assumed from the license
  of the surrounding application.
- CoTracker code and checkpoint remain subject to
  [CC BY-NC 4.0](https://github.com/facebookresearch/co-tracker/blob/82e02e8029753ad4ef13cf06be7f4fc5facdda4d/LICENSE.md).
  Its immutable revisions and hashes are in
  `src-tauri/python/hybrid/temporal_assets.py`; both remote assets passed
  integrity checks during this review.
- TorchVision code and pretrained-weight/training-data terms are distinct;
  see the [upstream model documentation](https://docs.pytorch.org/vision/stable/models.html).
- Custom Wistar weight redistribution remains **not cleared by this review**
  until lineage and applicable permissions are documented. Existing public
  assets and earlier installers have not been deleted or relicensed.

## Limitations and evaluation

The Wistar manifest states `experimental; train/validation only; independent
test unavailable`. No independently validated generalization claim, rearing
accuracy, complete training cohort, or numerical performance result is added
here. Lighting, apparatus, camera, strain, reflection and occlusion can affect
results. Human review, observation-quality masks and protocol-specific
geometry remain necessary. FST lacks a committed immutable weight manifest
with expected payload hashes; Python inference/training environments are not
fully locked. See [DATASET_CARD.md](DATASET_CARD.md) and
[docs/REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md).

## Proposed modular delivery

Keep the core desktop/OpenCV application independent of optional neural
providers. For a future reviewed migration, give each provider a manifest
recording upstream source, immutable revision, filename, size/hash, license
URL/identifier, use restrictions, runtime contract and training lineage.
Download upstream models directly from their official source rather than
rehosting them as Apache assets. Keep caches and provenance receipts separate
per provider. Also support verified user-supplied bundles and training on
researcher-controlled data locally or in Colab.

Unresolved legacy Wistar bundles must remain explicitly identified. A future
provider/import flow should check terms and identity before use and preserve
the evidence in each run manifest. Training/export tooling must carry forward
upstream and dataset terms; it cannot convert restricted inputs into an
unrestricted checkpoint by relabeling the result. This is an architecture
proposal, **not a claim that the current Wistar downloader has already been
replaced**. No neural route has been removed or silently switched.
