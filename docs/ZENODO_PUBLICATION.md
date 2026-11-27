# Zenodo publication metadata

Edition: **0.1.7 software source release**. The exact source-archive candidate
and study-material decisions are recorded in
[the source review](releases/v0.1.7-source-review.md). Creating or publishing
the release follows the maintainer's approval of that content. The
GitHub–Zenodo integration is already enabled, as reported by the maintainer.

## Metadata and consistency

[`CITATION.cff`](../CITATION.cff) supplies citation metadata to GitHub and citation
tools. [`.zenodo.json`](../.zenodo.json) supplies the Zenodo deposit metadata.
According to the [Zenodo documentation](https://help.zenodo.org/docs/github/describe-software/zenodo-json/),
when both exist, Zenodo uses **only `.zenodo.json`** for GitHub release archiving.
Approval and subsequent corrections must therefore cover both files.

| Information | CITATION.cff | .zenodo.json |
| --- | --- | --- |
| Requested scientific title | `title` | `title` |
| Software resource | `type: software` | `upload_type: software` |
| Ordered authors | `authors` | `creators` in the same order |
| Scientific description | `abstract` | Identical text in `description` |
| Prepared repository version | `version: "0.1.7"` | `version: "0.1.7"` |
| Repository | `repository-code` and `url` | `related_identifiers` |
| English | English text and a language comment | `language: eng` |
| Nine supplied keywords | `keywords` | Identical ordered `keywords` |
| Gabriel's ORCID | Full URI in `authors[].orcid` | Identifier in `creators[].orcid` |
| Thiago's ResearchGate profile | `authors[].website` | Attributed profile URL in `notes` |
| Individual affiliations | Confirmed affiliation in `authors[].affiliation` | Identical affiliation in `creators[].affiliation` |
| Project license | `license: Apache-2.0` | `license: Apache-2.0` |

CFF 1.2.0 does not permit a root-level `language` or `languages` property.
English is recorded in the text/comment in that file and explicitly encoded as
`eng` in the Zenodo metadata; no unsupported CFF property is added.

The version matches `package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and
`src-tauri/tauri.conf.json`. The application was incremented from 0.1.6 to 0.1.7
after confirming that tag `v0.1.7` was absent locally and remotely. No tag or
release was created. The public download fallback intentionally remains at
the verified 0.1.6 assets until new installers are actually published and
verified. See [CHANGELOG.md](../CHANGELOG.md).

Neither a DOI nor a publication date is invented. GitHub release archiving will
provide the actual publication context. Once Zenodo assigns identifiers, record
the version DOI and concept DOI with their respective meanings. No article,
funding award, rights holder, or institutional publisher has been asserted.

## Author confirmation

The names and identifiers below reflect the maintainer's supplied author list
and subsequent clarification. Thiago's full name has been updated to Thiago
Alves Vargas. The author order is preserved.

| Supplied name | Full name confirmed | Individual affiliation | ORCID |
| --- | --- | --- | --- |
| Gabriel Silva Santos | Supplied by maintainer | Confirmed, see below | `0009-0005-1967-0084`, supplied by maintainer |
| Thiago Alves Vargas | Supplied by maintainer | Confirmed, see below | Not supplied; ResearchGate only |

Gabriel's ORCID is recorded as a full `https://orcid.org/...` URI in CFF and as
the bare identifier in JSON. Its format and check digit have been verified;
the identity association is based on the maintainer's confirmation, not an
independent verification of the public profile.

Thiago's supplied [ResearchGate profile](https://www.researchgate.net/profile/Thiago-Vargas-5)
is recorded as his `website` in CFF and as an attributed URL in the Zenodo
`notes`. It is not an ORCID. The absence of a supplied ORCID does not establish
that he has none; his ORCID field remains absent unless confirmed later.

The maintainer confirmed the Institute of Biology and Department of Physiology
and Pharmacology in the UFPel affiliation context for both authors. Both files
use the same English metadata string:

> Department of Physiology and Pharmacology, Institute of Biology,
> Universidade Federal de Pelotas (UFPel), Brazil

This is an academic affiliation, not an assertion of institutional copyright
ownership, funding, or endorsement. No affiliation was inferred from a
ResearchGate or ORCID name match.

## Authorized project license

After confirming that no previous project license existed, the maintainer
explicitly confirmed rights-holder authorization for **Apache License 2.0**.
The unmodified [official Apache text](https://www.apache.org/licenses/LICENSE-2.0.txt)
is in [`LICENSE`](../LICENSE), and the SPDX identifier `Apache-2.0` is recorded
in CFF, Zenodo JSON, npm and Cargo metadata. No copyright owner or patent
ownership has been invented.

The project license does not relicense external models, datasets, media or
institutional marks. The [third-party review](THIRD_PARTY_LICENSES.md) records
the non-commercial terms of SuperAnimal and CoTracker, and the separate
GPL/LGPL/source obligations of dependencies and video binaries. The runtime
model licenses and archive-media permissions require their own evidence.

## Scientific scope and reproducibility

The English description reflects the implemented local/OpenCV and optional
neural workflows, protocol-specific metrics, quality controls, human review,
and exports. It distinguishes available infrastructure from independently
validated scientific performance. The shipped `oft_rearing_v1` manifest is
untrained; training and annotation tools do not constitute a trained,
generalizable behavioral classifier.

See [REPRODUCIBILITY.md](REPRODUCIBILITY.md) for dependency versions, model
identifiers, checksums, reproduction commands, and documented gaps. In
particular, a source archive alone does not contain the neural checkpoints,
original experimental videos, or complete training data.

## Required before an approved release

- Review final author metadata/order; add Thiago's ORCID only if supplied and
  confirmed. Names, affiliations and the project license are already recorded.
- Confirm rights for the materials actually included in the source archive.
  Review the explicit study-material list in
  [the archive plan](releases/v0.1.7-archive-plan.json); retain all original
  application artwork and synthetic UI illustrations. Preserve the separate
  custom-weight, data and upstream-license limitations described in
  [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
  Consult the root [model](../MODEL_CARD.md), [dataset](../DATASET_CARD.md)
  and [asset](../ASSET_LICENSES.md) cards. The maintainer declares authorship
  of application images/icons; no visual replacement is authorized.
- Approve the scientific description and the documented reproducibility limits.
- Match the application version, both metadata files, and the source snapshot
  selected for the release; run the repository's existing release checks.
- Keep neural checkpoints, datasets and installers as independent components;
  do not attach them to this source release or assume existing GitHub release
  assets are included in Zenodo's code archive. Their unresolved rights and
  incomplete lineage remain documented; no unrestricted grant is inferred.
- Address the remaining FST weight pinning and Python environment capture gaps
  before claiming complete inference reproducibility. No scientific runtime
  was silently changed to make an archival claim.
- Obtain the maintainer's explicit approval before creating or publishing a
  release. Review the resulting Zenodo record and its actual identifiers after
  an authorized publication.

These are review steps; no automatic publication barrier has been added to the
existing workflows.

All original application images, icons and audiovisual assets are retained,
as explicitly requested by the maintainer, who states they created them. The
archive candidate proposes individual `export-ignore` paths for study-derived
frames, tables and mixed reports, keeping those files in Git and requiring
approval of the selection. There is no blanket exclusion of images or all of
`artifacts/`/`docs/reports/`. The [preparation report](releases/v0.1.7-preparation.md)
is the historical record of the earlier review; the current exact selection
is in [the source review](releases/v0.1.7-source-review.md). No DOI or publication
date is assumed. The desktop publishing workflow is not used for this
source-only release.

## Metadata checks

The preparation checks YAML/JSON parsing, exact equality of title/description,
ordered authors and keywords, repository identity, and version agreement with
the existing application manifests. CFF is validated against the official
[CFF 1.2.0 schema](https://raw.githubusercontent.com/citation-file-format/citation-file-format/1.2.0/schema.json).

Zenodo's linked
[legacy deposit schema](https://github.com/zenodo/zenodo/blob/master/zenodo/modules/deposit/jsonschemas/deposits/records/legacyrecord.json)
does not list `version` and `language`, although both are supported in the
current official Zenodo JSON example linked above. The remaining JSON fields
are checked against that legacy schema; `version` and `language` are checked
separately as the documented strings. This is local structural verification,
not a Zenodo server-side deposit validation or approval to publish.
