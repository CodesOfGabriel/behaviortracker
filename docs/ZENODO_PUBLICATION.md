# Zenodo publication metadata

Published edition: **0.1.7 software source release**, **2026-11-27**.

| Distribution | Identifier |
| --- | --- |
| Version DOI: archived source 0.1.7 | [10.5281/zenodo.24612625](https://doi.org/10.5281/zenodo.24612625) |
| Zenodo record | [24612625](https://zenodo.org/records/24612625) |
| Source tag and commit | `v0.1.7` / `8b1ffb02b1d51c57291a669a35f0c5170d8c305c` |
| Desktop installers currently available | [0.1.6](https://github.com/CodesOfGabriel/behaviortracker/releases/tag/v0.1.6) |

Final scientific reference:

> Santos, Gabriel Silva; Vargas, Thiago Alves. (2026). *Behavior Tracker: An Open-Source Computational Platform for Automated Behavioral Analysis in Rodent Experiments* (Version 0.1.7) [Software]. Zenodo. https://doi.org/10.5281/zenodo.24612625

The public DOI resolves to the deposited source. The version DOI identifies this
edition, not a dataset, pretrained model or journal article. The GitHub–Zenodo
release webhook remains enabled. Post-publication citation changes on `main`
leave the existing tag and archive untouched; no new release is needed for them.

The maintainer approved keeping exactly 62 study-derived files local and removing
them from Git tracking, with individual `.gitignore` rules and local integrity
checks. After review, the maintainer authorized publication of v0.1.7. Its source
archive omits these files because they are
absent from the Git tree, without `export-ignore` rules. Previous public commits,
model assets and historical releases are unchanged.

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
| Scientific source version | `version: "0.1.7"` | `version: "0.1.7"` |
| Published version DOI | `doi: "10.5281/zenodo.24612625"` | Deliberately not pinned; Zenodo assigns each release's DOI |
| Publication date of 0.1.7 | `date-released: "2026-11-27"` | Deposit date assigned by Zenodo, not fixed for future releases |
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
`src-tauri/tauri.conf.json`. These source-version fields do not identify the
currently distributed installers or replace the actual installed application
version. The public download fallback and GitHub Latest reference remain at the
verified 0.1.6 installers. The institutional page displays the installer version
separately from the archived source citation. The About page also shows the
running application's own version. See [CHANGELOG.md](../CHANGELOG.md).

The DOI, metadata and deposited files were checked against the public Zenodo
record. The requested CFF `date-released`, **2026-11-27**, is the GitHub release
date (`2026-11-27T23:14:03Z`, also 27 November in America/Sao_Paulo). Zenodo's
API separately reports `publication_date: 2026-11-28`; its record creation time
is `2026-11-27T23:14:09.663794+00:00`. This documentation records that difference
without guessing its cause or editing the deposited record. The site's/software's
date is explicitly labeled as the release date. The record's concept DOI is
[10.5281/zenodo.24612624](https://doi.org/10.5281/zenodo.24612624); use the version
DOI above when citing 0.1.7. No article, funding award, rights holder, or
institutional publisher has been asserted.

The official version badge used in the README is
`https://zenodo.org/badge/DOI/10.5281/zenodo.24612625.svg`, linked to the version DOI.
The website and software share the final citation in
`src/lib/scientific-publication.ts`, independently of installer/runtime versions.

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

## Future releases and automatic DOI assignment

Keep `.zenodo.json` without a top-level `doi` or fixed `publication_date`. Copying
the 0.1.7 DOI/date into that reusable file would carry an old version's identifiers
into a later release. Zenodo uses `.zenodo.json` instead of CFF for this integration,
so the version-specific DOI/date can remain in the CFF citation for 0.1.7.
Before archiving a different source version, update the source/metadata version
fields and remove the previous edition's `doi` and `date-released` from CFF; after
Zenodo publishes it, record the newly confirmed version DOI/date and update the
shared citation and badge. Never retag a published source snapshot.

- Review final author metadata/order; add Thiago's ORCID only if supplied and
  confirmed. Names, affiliations and the project license are already recorded.
- Confirm rights for the materials actually included in the source archive.
  The approved local-only study-material list is in
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
  do not attach them to a source-only release or assume existing GitHub release
  assets are included in Zenodo's code archive. Their unresolved rights and
  incomplete lineage remain documented; no unrestricted grant is inferred.
- Address the remaining FST weight pinning and Python environment capture gaps
  before claiming complete inference reproducibility. No scientific runtime
  was silently changed to make an archival claim.
- Obtain the maintainer's explicit approval before creating or publishing each
  future release. Review the resulting Zenodo record and its actual identifiers
  after an authorized publication. The 0.1.7 publication is already complete.

These are review steps; no automatic publication barrier has been added to the
existing workflows.

All original application images, icons and audiovisual assets are retained,
as explicitly requested by the maintainer, who states they created them. The
62 study files are kept locally, ignored individually and removed from Git's
index with `git rm --cached`; their sizes and SHA-256 remain unchanged. There
is no blanket exclusion of images or all of `artifacts/`/`docs/reports/`.
The [public validation guide](VALIDATION_GUIDE.md) preserves the reusable
procedures without publishing the private pilot/results. The
[preparation report](releases/v0.1.7-preparation.md) is the historical record of
the earlier review; the current decision is in
[the source review](releases/v0.1.7-source-review.md). The desktop publishing
workflow was not used for this source-only release.

Validate a source ZIP from the reviewed index/tree before committing, then
generate it again from the actual commit with `git archive --format=zip`.
Check that none of the 62 paths are included, that local hashes are unchanged,
and that application media/icons, source, training scripts, synthetic fixtures,
lockfiles and metadata remain included. Record the archive hash and per-file
manifest outside the source tree. The 0.1.7 checks confirmed 490 deposited files,
matching the approved content with all 62 study files absent. Future citation-only
commits do not create a new Zenodo record; a separately authorized release is the
archiving trigger.

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
