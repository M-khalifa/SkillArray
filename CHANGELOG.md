# Changelog

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
