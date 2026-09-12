# Changelog

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
