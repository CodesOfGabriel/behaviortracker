# Behavior Tracker dataset card

Review date: 2026-11-27. **No public training dataset is released by this card.**
The Apache-2.0 code license is not a grant to experimental videos, annotations,
pseudoannotations, model weights or third-party datasets.

## Origin and purpose

The maintainer reports creating custom datasets during development from
experimental rodent-video frames, manual annotations and pseudoannotations.
These materials supported detector/pose adaptation and development of
behavioral-analysis workflows. SuperAnimal adaptation and transfer learning
were also used; the exact data/checkpoint chain for the distributed Wistar
bundle remains under review. See [MODEL_CARD.md](MODEL_CARD.md).

Original experimental-video ownership and authorization to redistribute them
are **not yet confirmed**. Application artwork is a different category: the
maintainer states they created the images/icons; that statement must not be
treated as permission to release study data.

## Composition and annotation

| Item | Documented state |
| --- | --- |
| Species/model | Wistar rat detector workflow; other model-zoo workflows are separate. |
| Original recordings | Experimental videos reported by the maintainer; no complete public accession list. |
| Number of animals, sessions, frames and institutions | Not established by the supplied evidence; no counts are invented. |
| Detector annotation | Manual and pseudoannotation use reported; per-version schemas, annotator identities and quality records require preservation. |
| Pose annotation/adaptation | HRNet adaptation and SuperAnimal development history reported; exact upstream models and annotation partitions unresolved. |
| Rearing annotation | Human frame/interval/apex tools are implemented. The distributed classifier manifest is untrained; tool availability does not establish a labeled training cohort. |
| Train/validation/test partitioning | No complete, independently auditable split manifest tied to the distributed Wistar checkpoint hashes has been supplied. |
| Ethics approvals, consent and access permissions | Not established in this repository review; no protocol numbers or permissions are invented. |
| Public dataset license | Not assigned. |

For a reproducible dataset version, record video SHA-256, animal/session IDs
with an appropriate pseudonymization policy, acquisition geometry/timing,
species/strain, condition and apparatus, label definitions, frame/interval
timestamps, annotator and reviewer provenance, ambiguity/occlusion, and any
pseudoannotation model/version/hash. Preserve manual observations separately
from automated proposals and corrections.

Freeze data partitions by animal/session/video rather than randomly mixing
correlated frames. Keep a genuinely independent test set, document exclusions
and annotation coverage, and preserve inter-observer procedures. These are
requirements for future data curation, not a claim that the existing data
already meet them.

## Data included in the repository

`tests/fixtures/` and `samples/pose.demo.csv` provide synthetic/generic software
examples. They are not a scientific benchmark or substitutes for a validation
cohort. Original experimental training videos and model checkpoint files were
not found in the current tracked source list.

`docs/reports/` and some `artifacts/` contain development results, selected
study-derived images, tables, paths or diagnostics. They remain present, as
requested; no imagery is removed by this review. Before archiving, determine
the permissible scope of these derived materials independently of authorship
of the application's visual assets. The review does not certify all retained
study-derived content as publicly redistributable.

## Access, limitations and next steps

There is no dataset DOI, public download offer, blanket data license or
guaranteed access procedure established here. Requests should be made to the
maintainers through the repository, who must verify the applicable permissions
before sharing any study material. Researchers may use their own properly
authorized videos with the local/Colab workflows and preserve their own data
and run manifests.

Development recordings, pseudoannotations and repeated tuning on the same
sessions do not establish independent accuracy. Lighting, camera, apparatus,
animal appearance, reflections and occlusions can limit generalization. Do
not report synthetic tests, in-sample diagnostics or unknown labels as
independent behavioral validation.

Before any dataset release, confirm ownership and redistribution authority,
applicable upstream/data terms, required ethical/privacy handling, a complete
composition manifest, annotation protocol/quality and partitions. Select an
appropriate data license only after those facts are established. Preserve a
versioned dataset manifest even when the data themselves must remain private.
