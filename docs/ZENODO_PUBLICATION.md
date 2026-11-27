# Zenodo publication metadata

Status on 2026-11-27: **draft for author approval; publication pending**. This
preparation does not create a release, tag, DOI, or Zenodo deposit. The
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
| Current repository version | `version: "0.1.6"` | `version: "0.1.6"` |
| Repository | `repository-code` and `url` | `related_identifiers` |
| English | English text and a language comment | `language: eng` |
| Nine supplied keywords | `keywords` | Identical ordered `keywords` |
| Gabriel's ORCID | Full URI in `authors[].orcid` | Identifier in `creators[].orcid` |
| Thiago's ResearchGate profile | `authors[].website` | Attributed profile URL in `notes` |
| Project license | Absent; maintainer confirms none exists | Absent; license decision pending |

CFF 1.2.0 does not permit a root-level `language` or `languages` property.
English is recorded in the text/comment in that file and explicitly encoded as
`eng` in the Zenodo metadata; no unsupported CFF property is added.

The version matches `package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and
`src-tauri/tauri.conf.json`. No version was incremented. When an approved future
release changes the application version, update both metadata files to that
version before preparing its tag. Do not reuse a version number for different
released source snapshots.

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
| Gabriel Silva Santos | Supplied by maintainer | Pending | `0009-0005-1967-0084`, supplied by maintainer |
| Thiago Alves Vargas | Supplied by maintainer | Pending | Not supplied; ResearchGate only |

Gabriel's ORCID is recorded as a full `https://orcid.org/...` URI in CFF and as
the bare identifier in JSON. Its format and check digit have been verified;
the identity association is based on the maintainer's confirmation, not an
independent verification of the public profile.

Thiago's supplied [ResearchGate profile](https://www.researchgate.net/profile/Thiago-Vargas-5)
is recorded as his `website` in CFF and as an attributed URL in the Zenodo
`notes`. It is not an ORCID. The absence of a supplied ORCID does not establish
that he has none; his ORCID field remains absent unless confirmed later.

Individual affiliations remain absent from both metadata files. The README
mentions Neurocell, NeuroLab, and UFPel, but does not establish each author's
approved affiliation. No affiliations have been inferred from the supplied
profile links.

## License unresolved

The maintainer confirms that **no project license exists**. The source audit
also found no license for Behavior Tracker itself:
no root `LICENSE`/`COPYING` was found, and the application package manifests do
not declare a project license. `docs/licenses/shadcn-ui-MIT.txt` concerns a
third-party component; FFmpeg notices concern the bundled video tools. Neither
establishes the license of this project or its trained weights.

Consequently, no SPDX identifier, license text, or copyright owner has been
invented. The requested title is preserved verbatim, including “Open-Source”,
but the project's licensing still needs to be established before publication.

**Do not publish with the license fields absent.** The
[Zenodo deposit documentation](https://developers.zenodo.org/#deposit-metadata)
describes default licenses for omitted values; omission must not be treated as
approval to apply a service default. Have the responsible authors establish
the project license, then add its actual text
and matching license identifiers to both metadata files. Check the applicable
terms for weights and bundled components separately.

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

- Confirm individual affiliations and final author metadata/order; record
  Thiago's ORCID only if supplied and confirmed.
- Resolve the project license and explicitly synchronize its identifiers;
  remove draft comments/notes after the pending decisions are resolved.
- Approve the scientific description and the documented reproducibility limits.
- Match the application version, both metadata files, and the source snapshot
  selected for the release; run the repository's existing release checks.
- Decide how to preserve required weights and their permitted reuse alongside
  the source. Existing GitHub model assets must not be assumed to be included
  in the Zenodo source archive.
- Obtain the maintainer's explicit approval before creating or publishing a
  release. Review the resulting Zenodo record and its actual identifiers after
  an authorized publication.

These are review steps; no automatic publication barrier has been added to the
existing workflows.

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
