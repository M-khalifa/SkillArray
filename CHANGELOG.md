# Changelog

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
