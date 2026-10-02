# Changelog

## 1.0.0 - 2026-10-01

### What it does

- `cross-review`: two reviewers from different providers (a Claude seat, and
  a Codex or OpenCode-routed seat) review the same target on their own. They
  exchange findings once, with model names and claim numbers hidden, and each
  accepts or disputes the other's claims with evidence. A fresh auditor, which
  never sees who wrote what, settles every finding.
- `pair-review`: the same process with two different Claude models, in
  collaborate, adversarial or independent mode.
- Output: `findings.json` (each finding with its severity, evidence, each
  reviewer's response and the auditor's own check), a scorecard, and
  `manifest.json` with content hashes, the models and skill versions used, and
  each seat's token use and working time.
- Blinding: claim numbers are relabeled for each reader, and every handoff is
  scanned for model and vendor names, seat letters and leftover claim numbers,
  evidence blocks included. A hit stops the run until the reviewer redacts it.
- Evidence rules: every finding says how it was found and how strong its
  evidence is. A rebuttal overturns a claim only with a checkable counter-fact.
  The audit checks disputed claims (light) or every claim ("double check all
  claims"), and optional verifiers re-check disputed high-severity findings
  ("deep verify disputed high-severity findings").
- Pre-flight evidence: repository state, optional test runs tied to a content
  snapshot of the target, and how far each clone is behind its upstream.
- Model setup on first run, saved preferences, and `setup`, `config` and
  `reset` commands.

### Known limitations

- A light audit does not re-check claims both reviewers agree on. When both
  are wrong the same way, only a full audit catches it.
- Writing style can still hint at a reviewer's identity. The scan catches
  explicit mentions only.
- There is no protection against prompt injection in the reviewed material.
- A Claude seat (seat A in cross-review, both seats in pair-review) is
  read-only by instruction only; the target is checked for changes after each
  phase. A Codex seat runs in a read-only sandbox and an OpenCode seat in a
  disposable worktree.
- An OpenCode seat has no web access.
- Resuming an ended orchestrator session was tested headless only.
- `translate` takes the auditor's word that a dispute carried a counter-fact;
  it does not re-read the rebuttals.
