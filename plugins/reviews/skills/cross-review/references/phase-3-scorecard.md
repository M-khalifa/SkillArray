# Phase 3 — Scorecard

Read both independent findings and both rebuttals. Apply the evidence,
refutation, and confidence rules in [review-protocol.md](review-protocol.md).

One row per surviving original claim ID:

| Claim | Verdict | Basis | Confidence | Peer response | State | Evidence |
|---|---|---|---|---|---|---|
| CL1 | FAIL | EXECUTED | HIGH | Conceded after check | settled-agree | Actual command/output |
| CX1 | CONCERN | READING-ONLY | MEDIUM | Disputed without counter-fact | unresolved-low-stakes | Actual cited source |

Example rows illustrate the format, not actual findings.

Spot-check the highest-impact or most-contested claims yourself. Rebuttals
without counter-facts cannot refute a claim. Agreement based only on reading
remains READING-ONLY. Report important evidence gaps as well as disagreements.
State how many LOW-confidence claims were filtered; never filter EXECUTED + FAIL.

## Optional fourth phase

Only one additional round is allowed when a high-stakes unresolved claim has a
concrete check that could settle it. Reuse the same reviewer identities, model
and effort snapshot, exact Codex thread ID, target directory, and read-only
sandbox. Put its brief and result in `<run-dir>/phase4/`. Follow Phase 2's
argument forwarding and completion checks. Then report the final state,
resolved or not; never loop.

## Report

Lead with the manifest and whether both seats completed. Include key findings,
the scorecard, prominent unresolved disagreements, execution limitations, and
dispatch count. Unknown actual model/effort and source-write audit results stay
explicitly unknown. Never turn an incomplete review into a completed verdict.
