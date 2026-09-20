---
name: cross-review
description: >-
  Review code, designs, or documents with two reviewer providers, then
  cross-examine their findings. Supports Claude/Fable, OpenAI Codex, and
  OpenCode-routed providers, with first-run model setup, saved preferences,
  and changing models anytime.
  Use for cross-vendor review, Claude plus Codex review, or /cross-review.
license: MIT
compatibility: >-
  Requires Node.js 22+, a selected reviewer runtime, and a harness that can run
  an isolated Claude reviewer and background shell processes.
  Git is recommended for source-change auditing. Claude Code is the primary target.
metadata:
  version: 1.4.0
---

# Cross Review

Reviewer A and B use two different providers. The orchestrator is neither
reviewer. Seat A always runs on this harness (Claude); seat B runs through
Codex CLI or OpenCode's configured provider bridge, never the Claude harness —
no other layout has a defined dispatch path, and `review-config.mjs` enforces
this. State the resolved provider, runtime, model, and effort before dispatch.
Do not change authentication or provider configuration during setup.

## Start here: model setup

Read [references/configuration.md](references/configuration.md) before dispatch.
Run the bundled configuration helper's (`scripts/review-config.mjs`) `show` and
`catalog` commands. Without
saved choices, ask for each seat's provider, runtime, model, and optional effort.
Show the catalog returned by the helper. Fable must be offered with the Claude
choices. Codex choices must include `gpt-6-astra`, `gpt-5.6-sol`,
`gpt-5.6-terra`, and `gpt-5.6-luna`; never offer deprecated GPT-5.1 choices.
For an OpenCode seat, run `opencode models` and show only configured providers
and model IDs. Do not inherit an unidentified runtime default.

`/cross-review setup` changes choices anytime; `/cross-review config` shows them.
Natural-language requests to change either seat also enter setup. Setup, config,
and reset do not dispatch reviewers.

## Invocation

```text
/cross-review setup
/cross-review config
/cross-review reset
/cross-review [reviewer-a] [reviewer-b] -- <task>
```

Use the delimiter when task text could look like a model selector. Existing
positional calls remain supported when unambiguous. IDs containing colons must
be supplied as a named seat with a separate effort in natural language.

To request the opt-in Falsification pass (see references/review-protocol.md),
include the phrase **"deep verify disputed high-severity findings"** in the
task text — this is the canonical phrase the orchestrator recognizes as an
explicit request; falsification never runs without it.

Explicit choices override saved values for one run only. A changed provider,
runtime, or model resets that seat's old effort to `default` unless effort is
also supplied. Cross-review always uses adversarial exchange and requires
different providers. For two Claude-harness reviewers or collaborative mode,
use pair-review.

## Preflight

1. Resolve preferences and inspect
   [references/model-capabilities.md](references/model-capabilities.md).
   Verify both models are available through their selected runtime. Unknown or
   unsupported explicit choices require user resolution, never silent fallback.
2. Check the selected runtime only: Claude harness model metadata for `claude`,
   `codex --version`, `codex login status`, `codex exec --help`, and
   `codex exec resume --help` for `codex`; or `opencode --version`,
   `opencode models`, and `opencode run --help` for `opencode`. Do not read
   credential files. Confirm the two selected provider IDs differ.
3. Resolve this skill's actual directory from the loaded SKILL.md location.
   Verify the linked references and bundled dispatcher exist. No sibling skill
   installation is required.
4. Read the target, discover its checks, and freeze the task packet and selected
   settings in a unique run directory. Configuration changes apply to subsequent
   reviews. An explicit request to change models during this review starts new
   independent passes; never relabel existing findings.

## Review phases

Read [references/review-protocol.md](references/review-protocol.md), then the
reference for the phase being executed:

1. [Independent passes](references/phase-1-independent-passes.md):
   run Claude and Codex concurrently against the same snapshot.
2. [Cross-examination](references/phase-2-cross-examination.md):
   exchange completed findings once, preserving both original passes.
3. [Scorecard](references/phase-3-scorecard.md):
   verify contested claims and retain unresolved disagreements. An opt-in
   Falsification pass independently checks a specific HIGH/CRITICAL disputed
   claim before synthesis, when the task explicitly requests it.

Dispatch a Codex seat with [scripts/codex-dispatch.mjs](scripts/codex-dispatch.mjs)
and an OpenCode seat with [scripts/opencode-dispatch.mjs](scripts/opencode-dispatch.mjs).
Pass the resolved `--model` on every dispatch, including resume. Pass `--effort`
only when the runtime supports and the user explicitly selected it; omit it for
`default`. Claude seats use the harness's explicit model/effort mechanism.
Snapshot all arguments for the run. Dispatchers do not load user preferences.

Result metadata records requested model/effort; it is not proof of server-side
selection. Use runtime evidence for resolved values, otherwise record `null`
and explain what could not be verified. Any dispatcher error or missing seat
means the review is incomplete; do not synthesize a completed two-vendor verdict.

OpenCode is selected only when the user chose it. It is never a silent fallback.

## Maintenance

This directory is independently installable. Its configuration helper, helper
tests, configuration reference, model-capability reference, review protocol, and
review profiles are also bundled with pair-review. Keep those copies identical
when maintaining both packages; neither package imports files from the other.
The phase references and dispatchers are maintained here and do not require
updates to another skill.
