# Changelog

## 1.3.0 - 2026-09-14

Full implementation history, root causes, and regression detail:
[docs/releases/1.3.0-engineering-notes.md](docs/releases/1.3.0-engineering-notes.md).

### Added

- Machine-readable `findings.json` output, produced by `blind-relabel.mjs
  translate` from the auditor's adjudicated findings. Includes
  `independently_discovered` status (derived mechanically, never
  self-reported) and a required `auditor_check` verification object per
  finding — a finding cannot be marked settled without actual agreement or
  refutation evidence.
- Canonical findings: when both reviewers independently discover the same
  underlying defect, it is now reported as one corroborated finding instead
  of two separate rows.
- Review profiles (`review-profiles.md`): Code, Architecture, and Document
  lenses, selectable per target instead of one fixed rubric.
- Optional Falsification pass: on request ("deep verify disputed
  high-severity findings"), a fresh, independent verifier subagent checks
  disputed HIGH/CRITICAL claims with no path back to the original reviewers.
- `scripts/release-check.mjs`: one command that runs repository parity
  validation, both packages' own validators and test suites, the benchmark
  scorer's own test suite, and Shared Brain's profile validation, stopping
  at the first failure. `--release` refuses to run against an uncommitted
  working tree.
- `bench/score.mjs`: a repository-level (not part of either shipped plugin)
  scorer for measuring a review run's `findings.json` against a labeled
  ground-truth defect set — precision/recall/F1 over the system's surfaced
  output, severity-weighted recall, cost-per-confirmed-defect, and empirical
  evidence-reliability tables. Its own test suite is part of the release
  gate; no benchmark run against real reviewer output has happened yet. See
  `docs/design/benchmark-harness.md`. `docs/design/` and `docs/releases/`
  added alongside it for 1.4 design work and this release's engineering
  detail, respectively.

### Changed

- Identity scanning now catches third-person identity mentions ("the Codex
  reviewer found this"), not only first-person self-identification.
  **Behavior note:** a run that previously exited 0 on this now exits 1.
- An OpenCode seat's declared provider must match what its model ID actually
  routes to. **Compatibility note:** a saved config with a bare/unprefixed
  OpenCode model ID needs `setup` re-run.
- Replaced the old fourth review phase (a full extra round for disputed
  claims) with the opt-in Falsification pass. **Behavior note:** a
  previously-escalated high-stakes dispute now reports as
  `unresolved-high-stakes` unless falsification is explicitly requested.
- A single-origin claim the peer disputes without a counter-fact, with no
  independent discovery and no falsification verifier, is now reported
  `unresolved-*` rather than `settled-agree`. **Behavior note:** bare
  disagreement no longer needs a counter-fact to block settlement — it now
  also needs the auditor or a verifier to affirmatively settle the claim
  before it counts as agreed. (A dispute WITH a counter-fact was already
  blocked from `settled-agree` before this release, unless a falsification
  verifier independently confirmed the claim; that part is unchanged.)
- Removed "Production-ready" framing and other stale/inaccurate wording from
  `marketplace.json`, `SECURITY.md`, and `review-profiles.md`; `SECURITY.md`
  now names every provider each skill's reviewers can actually reach.
- Protocol documentation (`review-protocol.md`, `phase-3-scorecard.md`,
  `pair-review`'s SKILL.md) rewritten into atomic MUST/MUST NOT/numbered-step
  rules; no rule semantics changed, verified by direct read-through of each
  rewritten section.

### Security / Reliability

- Fixed two independent identity-blinding bypasses in `blind-relabel.mjs`:
  an over-permissive fence-detection regex, and a missing backslash-escape
  check in inline code-span matching. Both could hide a reviewer's real
  identity or a real claim ID from the blind. Full detail in the engineering
  notes; both are release-blocking classes and are now covered by regression
  tests.
- Fixed `--isolate` worktree handling: it could delete an unrelated
  directory or another repository's worktree with no snapshot marker
  present, and could silently reuse a worktree that had been mutated
  directly instead of through the source repository. Both now fail closed.
- Fixed several `translate` provenance and contradiction checks that
  allowed an internally inconsistent `findings.json` — for example a finding
  simultaneously marked `settled-refuted` and independently confirmed by the
  auditor.

### Known limitations

- Inline code-span matching in `relabel`/`scan` is single-line only. A
  multiline code span is fail-safe (over-scanned, never a leak) but can
  mutate evidence that legitimately spans lines. Not fixed for 1.3.0: a
  naive cross-line parser would itself open a new blinding bypass.
- `scan`'s target-derived exemption is token-global: it does not distinguish
  a token's occurrence that legitimately cites the target from the same
  token merely occurring somewhere in the target.
- A canonical finding's own `evidence`, `severity`, `basis`, and
  `evidence_strength` are still transcribed from the auditor's JSON and
  trusted as-is, not yet cross-checked against the finding's actual Phase 1
  origin content.
- The Falsification pass's dispute classification is still the auditor's own
  reading of Phase 2, not mechanically verified against the rebuttal text.
- The Phase 3 auditor can be the same model family as one or both reviewers;
  this is recorded in the manifest but not yet prevented by default.
- gitignored files and untracked nested git repositories are excluded from
  `--isolate`'s drift detection, including on worktree reuse.
- `cross-review`'s two provider dispatchers currently pass the full,
  unfiltered parent environment to spawned provider CLIs (pair-review's
  Claude seats are harness subagents, not spawned processes, and are
  unaffected), and external provider calls have no default timeout
  (`--timeout` is opt-in). Tracked for 1.4.0.
- CI and `release-check.mjs` run the test suites in different concurrency
  modes; the historical flake this was meant to guard against could not be
  reproduced in 22 stress-test runs. Tracked for 1.4.0.

## 1.2.1 - 2026-09-12

- Fixed `isSupportedPair` crashing with a raw `TypeError` on JavaScript
  object-prototype provider names (`constructor`, `toString`, …); it now
  rejects them cleanly via `Object.hasOwn`.
- Fixed the same function silently accepting any provider string under the
  `opencode` runtime; unknown providers are now validated against the catalog,
  with a bounded fallback (plain lowercase token) for real but uncatalogued
  OpenCode-routed vendors, confirmed against live `opencode models` output.
- Ported `cross-review`'s v2 configuration helper, provider catalog, and tests
  into `pair-review`, which had drifted to the v1 schema and could not load a
  v2 config file or run the `catalog` command its own docs described.
- Extended `validate-repository.mjs`'s parity check to the configuration
  helper, provider catalog, and helper tests, so this class of drift fails CI
  going forward.
- `opencode-dispatch.mjs` now accepts `--effort` as an alias for `--variant`
  (SKILL.md instructed passing `--effort` to every dispatcher; it previously
  exited 2), validates `--model`/`--variant` token syntax, and rejects
  short-flag argument injection the same way `codex-dispatch.mjs` already did.
- Documented that OpenCode seats have no CLI-level read-only sandbox (verified
  against the installed CLI); `touchedFiles` there is detection, not
  prevention. Updated the phase references accordingly and split their
  `--model`/`--effort` dispatch templates between Codex and OpenCode seats.
- Fixed a garbled, duplicated clause in `cross-review`'s frontmatter
  description and restored a `--help` line dropped from the shared helper.

## 1.2.0 - 2026-09-12

- Made `cross-review` provider-neutral: each seat now saves provider, runtime,
  model, and effort; cross-review requires different providers rather than a
  fixed Claude + Codex pairing.
- Added Fable to the Claude setup catalog and replaced stale GPT-5.1 suggestions
  with GPT-6 Astra and GPT-5.6 Luna, Sol, and Terra.
- Added explicit OpenCode routing for configured Google, xAI, Mistral, Moonshot,
  DeepSeek, OpenRouter, and other provider/model IDs.

## 1.1.0 - 2026-09-12

- Added first-run model and effort configuration for `pair-review` and
  `cross-review`, with isolated saved preferences and one-run overrides.
- Added standalone package validation and offline test suites.
- Added explicit runtime/model verification and fail-closed review completion.
- Added Codex model and effort forwarding on fresh and resumed dispatches.
- Published `pair-review`, `cross-review`, and `shared-brain` under SkillArray.
