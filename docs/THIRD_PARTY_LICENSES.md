# Third-party license review for 0.1.7

Review date: 2026-11-27. The maintainer confirmed rights-holder authorization
to adopt Apache License 2.0 for the project. The official, unmodified text is
in [`LICENSE`](../LICENSE). No individual or institution has been invented as
the copyright owner.

## Dependency declarations

The [machine-readable inventory](licenses/dependency-inventory.json) records
the versions and declared licenses in `package-lock.json` and the package
metadata resolved with `cargo metadata --locked`. It includes optional,
development, and other-platform packages; it is not a list of files shipped by
every installer. Package versions were not upgraded for this preparation.

| Material | Evidence and terms | Assessment for the proposed source release |
| --- | --- | --- |
| JavaScript dependencies | Locked declarations: MIT, Apache-2.0 and dual licenses, BSD, ISC, MPL-2.0, BlueOak-1.0.0, CC0-1.0, MIT-0 and 0BSD | Preserve applicable notices. MPL-covered files retain their terms; do not describe all dependencies as Apache. |
| Rust dependencies | Exact locked package declarations in the inventory, including MPL-2.0, Unicode-3.0 and compound SPDX expressions | No dependency is relicensed. Review licenses and corresponding source requirements for the files actually redistributed in each platform bundle. |
| Direct Python test dependencies | Installed metadata for NumPy 2.2.6, OpenCV 4.13.0.92, SciPy 1.15.3, pandas 2.3.3, scikit-learn 1.6.1, ONNX 1.20.1 and ONNX Runtime 1.20.1 | The test environment is not shipped in the source archive. Wheel notices can include additional bundled libraries; package summary licenses alone are insufficient for a binary distribution. |
| DeepLabCut 3.0.2 code | [Versioned LGPL-3.0 license](https://github.com/DeepLabCut/DeepLabCut/blob/v3.0.2/LICENSE) | The application prepares it separately in Python. Preserve LGPL/GPL notices and applicable replacement/source provisions when conveying it. This does not establish a license for the models. |
| PyTorch/TorchVision inference/training | External Python packages; [PyTorch license](https://github.com/pytorch/pytorch/blob/main/LICENSE), [TorchVision license](https://github.com/pytorch/vision/blob/main/LICENSE) | Preserve the actual installed wheel notices. They are not bundled in the source archive; pretrained weights have separate provenance and terms. |
| FFmpeg/FFprobe | Local 6.1.1-tessus builds report GPL v3 or later, `--enable-gpl`, `--enable-version3`, and libx264 | Source archives exclude the binaries. Installer redistribution needs the correct license notices and corresponding source for each actual binary/build; generic distributor links are not evidence that all obligations are fulfilled. |
| shadcn/ui | Existing [MIT notice](licenses/shadcn-ui-MIT.txt) | Retained; applies to that component. |

Mozilla permits larger works under other terms while retaining the requirements
for MPL-covered material; see the [official MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).
For FFmpeg, the effective license depends on the enabled components; see
[the project's licensing information](https://ffmpeg.org/legal.html). Only the
local macOS video binaries were examined here. Windows/Linux/macOS release
installers and their source-distribution arrangements were not independently
audited.

## Models and datasets

| Asset or workflow | Observed provenance | Conditions and remaining requirements |
| --- | --- | --- |
| Wistar detector and HRNet | Versioned GitHub assets, sizes and SHA-256 in `models/wistar_df_v2/manifest.json`; full remote payload verification passed during this preparation | The maintainer reports custom Colab training/adaptation and earlier SuperAnimal transfer learning. Notebook and static checkpoint inspection did not establish the full chain to the distributed hashes. Weight/data redistribution remains unresolved; see `MODEL_CARD.md`. |
| SuperAnimal Quadruped / TopViewMouse | DeepLabCut model-zoo routes; the [DeepLabCut 3.0.2 README](https://github.com/DeepLabCut/DeepLabCut/blob/v3.0.2/README.md#license) restricts SuperAnimal models to non-commercial research use | These weights cannot be represented as unrestricted Apache-2.0 assets. FST still lacks a committed immutable weight manifest with expected hashes; no upstream permission or archival model DOI has been invented. |
| CoTracker temporal recovery | Code commit `82e02e8029753ad4ef13cf06be7f4fc5facdda4d`, checkpoint revision `bf55ea50d4390e1820a267f131cd6587240fb2c5`; pinned sizes/hashes in `src-tauri/python/hybrid/temporal_assets.py` | [CC BY-NC 4.0](https://github.com/facebookresearch/co-tracker/blob/82e02e8029753ad4ef13cf06be7f4fc5facdda4d/LICENSE.md). Preserve attribution and non-commercial restrictions. The downloaded code/weights remain separate from this source archive. |
| TorchVision pretrained initialization | `MobileNet_V3_Small_Weights.DEFAULT` in rearing training and Keypoint R-CNN defaults in custom training | Record the resolved weight version and training-data terms. [TorchVision explicitly distinguishes pretrained-weight terms](https://docs.pytorch.org/vision/stable/models.html) from the library's license. |
| Distributed `oft_rearing_v1` | Untrained manifest with no weight files or validation results | There is no trained classifier to license or archive as a validated model. Locally fitted peak models require their own data/provenance records. |
| Experimental videos and human annotations | The maintainer reports manually and pseudoannotated experimental frames; original-video ownership/redistribution still need confirmation | No public dataset license, consent to redistribute, or complete retraining archive has been established. The Apache grant for project code does not supply these permissions; see `DATASET_CARD.md`. |

The license review does not alter protocol eligibility, recovered-point
handling, tracking, or scientific metrics. Non-commercial dependencies limit
the affected workflows even if the independent application code is Apache
licensed. No claim of unrestricted commercial use of the complete neural
stack is made.

## Media and archive review

`public/rats_background.mp4` is a 23.83-second, 720 × 1280 video used by the
login page. Its file metadata does not establish authorship or a reuse license.
The maintainer states that they created all images and icons and reports
AI-assisted visual development. All original public assets, desktop icons,
illustrations, video, GIF and application styling have been preserved. Their
inventory and the distinction between authorship and asset-specific reuse
terms are recorded in [ASSET_LICENSES.md](../ASSET_LICENSES.md). Academic
affiliation does not itself assign rights in institutional marks.

`artifacts/` and `docs/reports/` remain unchanged in the source tree and are
not newly excluded by this preparation. They contain development screenshots,
study-specific images, tables and diagnostics. Redistribution of
study-derived material requires a separate decision from authorship of
application artwork. No existing images or icons are removed or replaced.

The source scan checks tracked text for private-key blocks and known token
patterns without printing matched secrets, plus sensitive file extensions,
notebook outputs and personal filesystem paths. `.env` credentials, model
checkpoints, SQLite databases and original study videos were not found in the
tracked file list. The versioned test fixtures are synthetic examples. Pattern
scanning is a bounded check, not a guarantee that no sensitive information
exists; the publication review must also cover the retained media.

## Release decision

The project license and institutional affiliation decisions are recorded.
Permission/provenance for custom weights and datasets, asset-specific reuse
terms, immutable
FST weights, full Python environment capture, and platform-specific binary
license/source obligations remain explicit review items. Until these are
resolved for the materials being distributed, do not describe the complete
release as cleared or independently reproducible. Final release publication
also requires the maintainer's separate approval.
