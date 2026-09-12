---
name: pair-review
description: >-
  Review code, designs, or documents with two distinct Claude models.
  Supports collaborative, adversarial, and independent passes, first-run
  model setup, saved preferences, and changing models anytime.
  Use for pair review, two Claude reviewers, or /pair-review.
license: MIT
compatibility: >-
  Requires Node.js 22+ and a harness that can run two isolated Claude
  reviewers with explicit model selection and resume or relay their findings.
  Claude Code is the primary target. Model access depends on the user's account.
metadata:
  version: 1.1.0
---

# Pair Review

Two distinct Claude models independently review the same target, then exchange
findings. The orchestrator coordinates and verifies; it never fills either seat.

## Start here: model setup

Read [references/configuration.md](references/configuration.md) before dispatch.
Run the bundled configuration helper's `show` command. If no saved configuration
exists, ask the user to choose both models and optional effort levels before
the first review. Do not silently install a default pair.

`/pair-review setup` runs the same setup anytime; `/pair-review config` shows
current choices. A request such as "change pair-review's second model to Sonnet"
also updates setup. These commands configure only; they do not launch a review.

## Invocation

```text
/pair-review setup
/pair-review config
/pair-review reset
/pair-review [collaborate|adversarial|none] [modelA[:effort]] [modelB[:effort]] -- <task>
```

The delimiter separates optional model selectors from task text. Natural-language
requests work too; do not infer a model selection from a model name mentioned
inside the review target. Existing positional invocations remain supported when
unambiguous; otherwise ask which part is the task.

- Saved mode defaults to `collaborate` at setup. `adversarial` attacks each
  other's findings; `none` stops after independent passes.
- Explicit run choices override saved values without saving them. Missing
  selectors use saved choices. A model change clears that seat's saved effort
  to `default`, unless the user also supplies an effort.
- For an ID containing a colon, use an explicit named seat and separate effort
  in natural language rather than interpreting the ID as `model:effort`.
- Both resolved models must be distinct, including when different aliases map
  to the same actual model. Never silently substitute.

## Review workflow

1. Resolve configuration and validate availability using
   [references/model-capabilities.md](references/model-capabilities.md).
   Snapshot the selected settings for this run; do not reread preferences
   between review rounds.
2. Read the target and [references/review-protocol.md](references/review-protocol.md).
   Give both seats the same task packet: scope, current source snapshot,
   actual test commands, constraints, and expected output.
3. Create a unique run directory under the harness scratchpad or OS temporary
   directory. Assign `A-findings.md` and `B-findings.md`; keep artifacts
   outside the reviewed source. Include a run ID in both agent names.
4. Start both isolated reviewers concurrently using this harness's supported
   model/effort mechanism. Pass the protocol and task explicitly; do not
   assume subagents inherit this conversation. In Phase 1, neither seat may
   read the peer's file. Review only; no source edits or commits.
5. Wait for both independent passes to complete. A reviewer may return after
   its initial pass; resume it for the exchange. This avoids agents waiting
   indefinitely for a peer that has not been released by the orchestrator.
   Missing files may be recovered verbatim from a valid final response.
6. Unless mode is `none`, send each peer's completed findings to the other
   reviewer for one exchange round. Use file-ready messages when supported;
   otherwise relay via the orchestrator. Append rebuttals without overwriting
   original claims. Wait for both exchanges before synthesis.
7. Verify the highest-impact claims yourself, apply the protocol's evidence
   and confidence rules, and preserve unresolved disagreements.
   Write `joint-findings.md` for collaborate mode or a scorecard for
   adversarial/independent mode. Emit the run manifest with honest
   requested-versus-observed model and effort information.

A failed or unavailable seat means an incomplete review. Report what completed
and the failure; never label a single pass as a completed pair review.
