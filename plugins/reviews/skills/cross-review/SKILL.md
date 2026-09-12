---
name: cross-review
description: >-
  Review code, designs, or documents with one Claude reviewer and one
  OpenAI Codex reviewer, then cross-examine their findings. Includes
  first-run model setup, saved preferences, and changing models anytime.
  Use for cross-vendor review, Claude plus Codex review, or /cross-review.
license: MIT
compatibility: >-
  Requires Node.js 22+, an installed authenticated Codex CLI, and a harness
  that can run an isolated Claude reviewer and background shell processes.
  Git is recommended for source-change auditing. Claude Code is the primary target.
metadata:
  version: 1.1.0
---

# Cross Review

Reviewer A uses Claude; reviewer B uses OpenAI through Codex CLI.
The orchestrator is neither reviewer. Choosing this skill opts into reviewing
the supplied material through both providers; state the resolved pairing before
dispatch. Do not change authentication or provider configuration during setup.

## Start here: model setup

Read [references/configuration.md](references/configuration.md) before dispatch.
Run the bundled configuration helper's `show` command. Without saved choices,
ask the user to choose the Claude model, the OpenAI model, and optional effort
levels before the first review. Do not inherit an unidentified Codex default.

`/cross-review setup` changes choices anytime; `/cross-review config` shows them.
Natural-language requests to change either seat also enter setup. Setup, config,
and reset do not dispatch reviewers.

## Invocation

```text
/cross-review setup
/cross-review config
/cross-review reset
/cross-review [claude-model[:effort]] [codex-model[:effort]] -- <task>
```

Use the delimiter when task text could look like a model selector. Existing
positional calls remain supported when unambiguous. IDs containing colons must
be supplied as a named seat with a separate effort in natural language.

Explicit choices override saved values for one run only. A changed model resets
its old effort to `default` unless effort is also supplied. Cross-review always
uses adversarial exchange. For two Claude reviewers or collaborative mode,
use pair-review.

## Preflight

1. Resolve preferences and inspect
   [references/model-capabilities.md](references/model-capabilities.md).
   Verify both models are available through their selected runtime. Unknown or
   unsupported explicit choices require user resolution, never silent fallback.
2. Check `node --version`, `codex --version`, `codex login status`,
   `codex exec --help`, and `codex exec resume --help`. Ensure the CLI accepts
   the model and config flags needed by this run. Do not read credential files.
   Confirm the effective Codex provider is OpenAI; custom-provider or local-model
   routing does not satisfy this skill's vendor boundary.
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
   verify contested claims and retain unresolved disagreements. At most one
   additional round, only when a concrete check can settle a high-stakes claim.

Dispatch Codex with [scripts/codex-dispatch.mjs](scripts/codex-dispatch.mjs).
Pass the resolved `--model` on every dispatch, including resume. Pass `--effort`
only when explicitly selected; omit it for `default`. Snapshot these arguments
for the run. The dispatcher does not load user preferences itself.

Result metadata records requested model/effort; it is not proof of server-side
selection. Use runtime evidence for resolved values, otherwise record `null`
and explain what could not be verified. Any dispatcher error or missing seat
means the review is incomplete; do not synthesize a completed two-vendor verdict.

The optional bundled OpenCode helper is retained for existing integrations.
It is not selected by this workflow and is never a silent Codex fallback.

## Maintenance

This directory is independently installable. Its configuration helper, helper
tests, configuration reference, model-capability reference, and review protocol
are also bundled with pair-review. Keep those copies identical when maintaining
both packages; neither package imports files from the other. The phase references
and dispatchers are maintained here and do not require updates to another skill.
