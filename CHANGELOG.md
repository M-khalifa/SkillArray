# Changelog

## 1.6.0 - 2026-09-22

Fixes from a cross-review of the skill itself, plus field feedback from
three live runs.

- Fixed blinding leaks:
  - A vendor name in the target repo's branch name or an ignored folder
    exempted that name everywhere, so a real identity leak scanned clean.
  - The docs pointed the auditor at a folder that also held the seat
    mapping. The auditor now reads only a staged folder that
    `audit-prep` builds.
  - Peer labels such as "P12" survived into the auditor's files. A new
    scan check stops them.
- Fixed corrupted findings.json fields:
  - "Suggested fix:" lines, and the fence lines of back-to-back evidence
    blocks, leaked into `evidence`.
  - Relabel and translate rewrote any letter-plus-digits token, so a
    product name like "A100" became "P100". They now rewrite only real
    claim IDs, and translate refuses a claim ID in the auditor's prose
    fields.
- Fixed false hard stops: vendor names now match whole words only, so
  "affable" no longer matches "fable".
- New commands:
  - `append-rebuttals` checks Phase 2 coverage and appends translated
    rebuttals.
  - `audit-prep` runs the whole Phase 3 double relabel and scan.
  - `build-brief.mjs` builds every brief from the protocol's own text.
  - `scan --target-urls` reports when a reviewer cited a URL taken from
    the reviewed document.
- Lower token use without lower quality:
  - The Claude seat and the auditor now write their own result files.
    This removes about 70 KB of retyped text per run.
  - `preflight --compact` keeps full test logs and the git diff on disk
    instead of pasting them into every brief. On this repo that cuts the
    pre-flight JSON from 66 KB to 21 KB.
  - Redaction rounds now send only the flagged lines.
  - Trade-off, on purpose: a `build-brief.mjs` Phase 1 brief is about 5 KB
    larger than a typical hand-written one, because it always carries the
    full rule text.
- Targets that are not git repositories now get a content-hash snapshot:
  pre-flight can prove the target did not change, and dispatchers report
  which files a reviewer touched instead of "unknown".
- Protocol additions:
  - A severity rubric, with acceptance risk rated separately from code
    risk.
  - A data-exposure lens for serial numbers, WWN/NAA IDs and hostnames in
    captures.
  - Freezing an extracted copy of a .docx/.pdf target.
  - A web-usage counting unit.
  - The reason behind a zero falsification count.
  - Pristine Phase 1 copies for the manifest hashes.
  - A documented resume call for the Claude seat.
  - Unverified orchestrator hypotheses (`H1`, `H2`, ...) for seats to
    test.
- `build-manifest` refuses two files with the same name instead of
  silently keeping one hash.
- The docs now say that dispatchers stop a seat after 30 minutes unless
  `--timeout` says otherwise.
- The model list lives only in the catalog, and GPT-6 Sol and GPT-6 Luna
  were added to it.
- This release also carries the version bump 1.5.0 missed: plugin.json
  and both SKILL.md files still said 1.4.0.

## 1.5.0 - 2026-09-20

- Fixed a real identity-blinding bug: on a CRLF (Windows-line-ending) Phase 1
  file, the seat-header and rebuttal-heading regexes silently failed to
  match, so relabeling left the reviewer's real seat letter in peer-facing
  text instead of blinding it.
- Added optional live web verification: reviewers can now fetch external
  documentation to check a claim the target/repo itself can't settle (a
  deprecated API, an outdated error string, a spec mismatch), gated by
  claim-checkability rather than review profile, default-on, with a
  5-fetch-per-seat-per-phase cap and mandatory URL+quote citation. See
  `docs/design/web-verification.md`.
- Reviewers now report every location a confirmed defect pattern occurs,
  not only the first instance found.

## 1.4.0 - 2026-09-17

- Fixed a real bug: on Linux/macOS, a timed-out Tier-2 preflight command
  wasn't actually killed — it kept running in the background while
  reporting itself as stopped. Windows was unaffected.
- Reviewer identity can no longer leak into blinded output, even when
  quoted inside evidence.
- Findings now get their severity and evidence from the reviewers'
  original claims instead of the auditor's paraphrase of them.
- Dispatchers default to a 30-minute timeout and a filtered environment
  instead of running unbounded with full environment access.
- Added token-usage reporting to dispatcher results (no cost yet — no
  price table for either provider).
- Replaced the old fourth review phase with an opt-in falsification pass
  for disputed high-severity claims.
- Added an experimental benchmarking harness (`bench/`) for comparing
  SkillArray against simpler review strategies. No results yet.

## 1.3.0 - 2026-09-14

Engineering detail: [docs/releases/1.3.0-engineering-notes.md](docs/releases/1.3.0-engineering-notes.md).

- Added machine-readable `findings.json` output, with independent
  corroboration tracked automatically instead of self-reported.
- Fixed two identity-blinding bypasses that could leak a reviewer's real
  identity through the blind.
- Fixed `--isolate` worktree handling that could delete the wrong
  directory or silently reuse a tampered worktree.
- Added review profiles (Code, Architecture, Document) and an optional
  falsification pass for disputed high-severity claims.
- Added `release-check.mjs`, one command that runs the full release gate.

## 1.2.1 - 2026-09-12

- Fixed a crash on JavaScript object-prototype provider names.
- Fixed silent acceptance of unknown providers under OpenCode.
- Brought `pair-review`'s configuration up to date with `cross-review`'s.

## 1.2.0 - 2026-09-12

- Made `cross-review` provider-neutral — no longer a fixed Claude+Codex pairing.
- Added Fable and refreshed the Codex/OpenCode model catalog.

## 1.1.0 - 2026-09-12

- Added first-run model/effort setup, saved preferences, and offline test suites.
- Published `pair-review`, `cross-review`, and `shared-brain` under SkillArray.
