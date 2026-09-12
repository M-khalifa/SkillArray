# Model configuration

The assistant conducts setup conversationally; the Node helper persists and
validates data. It is not an interactive terminal wizard and does not discover
account entitlements or dispatch a paid model call.

## First run and changes

1. Resolve `<skill-dir>` to the directory containing the loaded SKILL.md.
   Run `node "<skill-dir>/scripts/review-config.mjs" show`.
2. For cross-review, run `catalog`. Ask for both reviewer providers, runtimes,
   models, and optional effort. For pair-review, ask for two distinct
   Claude-harness models and optional effort. Present current curated choices,
   then verify availability in the selected runtime. Codex must show the GPT-6
   Astra and GPT-5.6 Luna/Sol/Terra choices; Claude must include Fable when its
   harness exposes it. For OpenCode, show only `opencode models` results.
   Examples are not defaults.
   If the user already supplied both choices, use them without asking again.
3. Validate runtime support as described in
   [model-capabilities.md](model-capabilities.md). The helper validates structure
   only. For pair-review check that aliases resolve to distinct Claude models;
   for cross-review check that the two selected provider IDs differ.
4. Save using `setup`, then read back with `show`. State both models, effort,
   and the saved path. A first review request continues after setup; a setup-only
   request ends without dispatch.
5. On later review requests, use `resolve` with any explicit overrides. It
   returns the run configuration without changing the saved file.
6. `/pair-review setup` or `/cross-review setup` displays existing choices and
   asks what to change. Supply only changed fields to the helper. Natural
   language such as "use this model from now on" saves; "for this review" does not.
   `config` maps to `show`; `reset` removes only this skill's preference file.
   Reset does not clear authentication or review artifacts.

## Storage

Each skill owns one versioned JSON file:
- `$REVIEW_SKILLS_CONFIG_DIR/<skill-name>.json` if set.
- Otherwise `$XDG_CONFIG_HOME/review-skills/<skill-name>.json` if set.
- Otherwise `~/.config/review-skills/<skill-name>.json`, on Windows too.

Overrides must be absolute paths. Use the helper's returned path rather than
guessing platform expansion. Preferences stay outside the skill installation
and target repository. Do not publish user configuration. No credentials, source
content, or global CLI settings are stored or changed.

A corrupt file or unsupported schema stops resolution with an actionable error.
Do not silently overwrite it. Let the user correct it or explicitly reset it.
A missing file is the first-run setup case. If saving is denied, state that
choices were not saved; an explicitly selected temporary run can still use
`resolve` without persistence.

## Helper commands

All commands work in PowerShell, bash, or zsh after substituting the quoted path
and user-selected model IDs. Placeholders here document arguments, not defaults.

```text
node "<skill-dir>/scripts/review-config.mjs" show
node "<cross-review-dir>/scripts/review-config.mjs" catalog
node "<cross-review-dir>/scripts/review-config.mjs" setup --a-provider anthropic --a-runtime claude --a fable --b-provider openai --b-runtime codex --b gpt-5.6-sol
node "<cross-review-dir>/scripts/review-config.mjs" setup --b-provider google --b-runtime opencode --b google/MODEL_ID
node "<pair-review-dir>/scripts/review-config.mjs" setup --a fable --b sonnet
node "<skill-dir>/scripts/review-config.mjs" resolve --a TEMPORARY_MODEL_A
node "<skill-dir>/scripts/review-config.mjs" reset
```

Effort defaults to the literal `default`, meaning omit the runtime override,
not a promise of a particular reasoning level. Set `--a-effort default` or
`--b-effort default` to clear an override. Changing a model automatically clears
that seat's previous effort unless a replacement effort is provided.
An omitted mode uses saved mode (initially collaborate for pair-review and
adversarial for cross-review). Pair-review accepts `--mode collaborate`,
`--mode adversarial`, or `--mode none`.

Explicit run values > saved preferences > effort/mode defaults.
There is no built-in model default. Cross-review first setup needs both complete
reviewer selections; pair-review needs two distinct Claude-harness model IDs.
Do not persist run overrides unless asked.

## During an active review

Keep the run's resolved settings fixed across independent and exchange rounds.
Changing saved preferences is allowed anytime and affects the next review.
If the user explicitly wants new models on the current target, end the old run
as superseded and start both independent passes in a new run directory. Preserve
old artifacts; do not compare a new model's rebuttal with an old model's pass
as if they came from one unchanged reviewer.
