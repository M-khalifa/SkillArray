# Seat A findings — cross-review skill self-audit

> HISTORICAL TEST FIXTURE: recorded output from a past review pass, kept as a stable
> input for blind-relabel.mjs's own tests. Not a claim about the current code.

## A1 — `--isolate` on a non-git target completes successfully with zero protection, and its own note misstates what protects the run
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
Built a fake `opencode` shim in a scratch dir, dispatched with --isolate against a non-git target:

relay: --isolate requested but --cd "...\iso\target" is not a git repository; OpenCode ran directly against --cd, protected only by touchedFiles detection
relay: --cd "...\iso\target" is not a git repository; file changes cannot be tracked
EXIT=0
{ "sessionId": "sess-1", "touchedFiles": null, "isolated": false, "worktreePath": null,
  "touchedFilesNote": "... is not a git repository; file changes cannot be tracked",
  "isolationNote": "--isolate requested but ... protected only by touchedFiles detection",
  "status": "completed" }
```
The `isolationNote` at opencode-dispatch.mjs:594-595 promises "protected only by touchedFiles detection", but the exact same non-git condition makes `isGitRepo(cdAbs)` fail again at line 616, so `touchedFiles` is `null` too — no protection at all. Same false text in USAGE at lines 133-135. status is `completed`, exit 0, so an orchestrator gating only on those (phase-1-independent-passes.md:86: "Require a zero dispatcher exit and `status: completed`") accepts this run. phase-1-independent-passes.md:76-78 and review-protocol.md:231-232 call an `isolationNote` "a hard stop for this run, not a warning" — that hard stop exists only as orchestrator-side prose instruction; the dispatcher never fails closed. Same branch reachable on a git repo with an unborn HEAD (`git worktree add ... HEAD` fails at line 294, falls into the same setup.ok===false note at line 605).

## A2 — POSIX SIGKILL escalation is unreachable dead code; "whole process tree" is a Windows-only property
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
codex-dispatch.mjs:54-57 and opencode-dispatch.mjs:77-80, identical:
child.kill('SIGTERM');
setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
```
Node sets `child.killed` true when the signal is successfully sent, not when the process terminates. After a successful SIGTERM send, `child.killed` is already true, so the SIGKILL escalation can never fire — exactly the case (a child ignoring SIGTERM) it exists for. The POSIX branch also kills only the direct child (no `detached: true`, no process-group kill), so a wrapper that forks a real binary leaves the grandchild running. USAGE text calling this `killTree` ("whole process tree") is accurate only on win32, where `taskkill /T` walks the tree. No POSIX host available to execute; this is a code read plus Node's documented `killed` semantics.

## A3 — Both timeout tests prove the status field, not the kill
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
tests/dispatch-integration.test.mjs:76-79 (codex) and :106-109 (opencode) assert only:
exit status 1, output.status === 'timed-out', error string matches /timeout 2s/.
```
Neither checks that the hung fake process actually died — no pid liveness check, no post-test process enumeration. `runCodex`'s timer (codex-dispatch.mjs:379-385, mirrored opencode-dispatch.mjs:464-469) deliberately resolves on a 5-second grace timer regardless of whether `killTree` worked (own comment says so). So `status: "timed-out"` is written on the grace path whether or not the child died. Both tests pass identically against a build where the kill is entirely broken. Combined with A2, the untested half is exactly the half broken on POSIX.

## A4 — `model-capabilities.md` still states the pre-rewrite position and directly contradicts the new `--isolate` docs
Severity: HIGH
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
model-capabilities.md:68-79: "No CLI-level read-only sandbox exists for OpenCode, verified."
"... the read-only guarantee holds for a Codex seat ... but NOT for an OpenCode seat —
opencode-dispatch.mjs's touchedFiles is detection after the fact, never prevention."
Never mentions --isolate.
```
Flatly contradicted by the rewrite: review-protocol.md:17-20 names OpenCode `--isolate` as real prevention; phase-1-independent-passes.md:72-80 says `--isolate` makes the guarantee real instead of detection-only. SKILL.md:61-62 tells the reader to inspect model-capabilities.md, which gives the superseded answer. File mtimes: model-capabilities.md Sep 12 12:34; the three phase docs and review-protocol.md Sep 13 19:36. This file is one of the three the repo validator enforces byte-identical with pair-review, so the stale text ships in both packages.

## A5 — Phase-3's scorecard example uses prose that is not in the protocol's `Peer response` enum
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
review-protocol.md:139: Peer response: unaddressed | conceded | disputed-no-counter-fact | disputed-with-counter-fact
phase-3-scorecard.md:51-52 rows use: "Conceded after check", "Disputed without counter-fact"
```
The example rows use free prose instead of the closed enum. The second is a near-miss rename of `disputed-no-counter-fact`; the first adds a qualifier the enum has no slot for. The auditor subagent receives review-protocol.md but not SKILL.md (phase-3-scorecard.md:29-31), and the orchestrator builds the table from the phase-3 template — two audiences working from different vocabularies for the same column.

## A6 — Phase 3 instructs the auditor to apply a "confidence-floor rule" that is defined nowhere
Severity: MEDIUM
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```
phase-3-scorecard.md:34-36: "apply the refutation-asymmetry and confidence-floor rules
... defined in review-protocol.md's Synthesis section."
Grep for confidence-floor across the skill directory: exactly one hit, that line itself.
```
review-protocol.md's Synthesis section (lines 130-160) has no such rule and no confidence field. "Refutation asymmetry" is at least recoverable from the unnamed paragraph at lines 126-128; nothing corresponds to a confidence floor. Looks like a survivor of the old Verdict/Basis/Confidence schema — Confidence was replaced by Basis + Evidence strength, but the rule referencing it was not updated. The auditor is a fresh subagent with no other context; it must invent the rule or drop it silently.

## A7 — The blind-exchange grep is not mechanically applicable; its own exemption rule is self-contradictory on this repo
Severity: HIGH
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
review-protocol.md:101-116: strip fenced/inline-backtick spans, grep remaining prose for
vendor/model tokens; "A match outside evidence is a hard stop."
```
Three gaps, unrunnable as written when the reviewed target is this skill itself (exactly this case). First: the exemption is by location (inside backticks), not content — a reviewer writing a filename in prose without backticks trips a hard stop on "codex" while saying nothing about its own identity; no rule distinguishes "prose mention of the target's filename" from "self-identification". Second: the remedy (return to reviewer's own context for redaction) has no bounded cost or retry limit, and on a self-review of this repo, where every finding legitimately discusses `codex-dispatch.mjs`/`opencode-dispatch.mjs`, that is a likely-repeating round trip. Third: the exemption's own example, `gpt-5.1-codex`, is a stale ID — SKILL.md:32-33 says never offer deprecated GPT-5.1 choices, and provider-catalog.mjs:16-21 lists only gpt-6-astra/gpt-5.6-sol/gpt-5.6-terra/gpt-5.6-luna. Fourth, narrower: phase-3-scorecard.md:13-22 says relabel claim IDs embedded in rebuttal prose too, but a naive `A\d+`→`X\d+` substitution will also rewrite hex digests, cell references, and identifiers inside Evidence blocks the doc elsewhere says to preserve verbatim; no rule resolves that.

## A8 — Neither dispatcher enforces any part of the blind protocol; it is entirely orchestrator-instruction
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
Read both dispatchers end to end, grepped scripts/ for relabel/scan/P/X/Y/manifest logic: none found.
```
No relabeling code, no vendor-token scan, no P/X/Y handling, no manifest writer anywhere in codex-dispatch.mjs, opencode-dispatch.mjs, review-config.mjs, or provider-catalog.mjs. The entire three-namespace scheme (review-protocol.md:27-42), including the coin flip, the seat_to_audit_label mapping, and the hard-stop grep, exists only as prose an orchestrator is asked to follow by hand. review-protocol.md:113-116 concedes the residual-limitation half ("writing style ... can still hint at identity") but nowhere says the mechanical half is also unimplemented. No test of any blinding behavior exists. Design gap, not a code bug, but it is the central claim of the rewrite with zero mechanical backing.

## A9 — Config accepts a cross-vendor pair with no Claude seat, which no phase document can dispatch
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
$ node review-config.mjs setup --a-provider openai --a-runtime codex --a gpt-6-astra \
    --b-provider google --b-runtime opencode --b google/gemini-x
{ "saved": true, "config": { "reviewers": {
    "A": { "provider": "openai", "runtime": "codex", "model": "gpt-6-astra", ... },
    "B": { "provider": "google", "runtime": "opencode", "model": "google/gemini-x", ... } } } }
```
The helper saves this — the only cross-review constraint enforced is that the two provider IDs differ (review-config.mjs:59). But the phase docs hardcode seat A as Claude: phase-1-independent-passes.md:28 titles it "Claude (seat A)" with a harness-agent dispatch path and no CLI alternative; only seat B gets Codex/OpenCode dispatcher templates. SKILL.md:84 says "run Claude and Codex concurrently". A saved configuration the helper calls valid has no documented dispatch path for seat A. It also silently falsifies the mandatory limitation statement phase-3-scorecard.md:39-41 tells the orchestrator to put in the report verbatim ("the auditor is still the same model family as one or both reviewers (Claude)") — untrue when neither reviewer is Claude, and the docs give no conditional wording for that case.

## A10 — `result.json` field sets diverge between the two dispatchers, and neither matches its own USAGE block
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
SKILL.md:98: "Result metadata records requested model/effort" (general property).
codex-dispatch.mjs:561-566 emits modelRequested/effortRequested/modelResolved/effortResolved/selectionNote.
opencode-dispatch.mjs:665 emits { sessionId, touchedFiles, isolated, worktreePath } — none of the five.
```
An orchestrator building the manifest's model_requested/effort_requested entries (review-protocol.md:192-196) from an OpenCode seat's result.json finds nothing there. USAGE blocks are stale both directions: codex-dispatch.mjs:111-126 documents six result fields and omits all five model/effort fields the code writes. review-protocol.md:231-232 says `isolated`/`worktreePath` "mirror the dispatcher's own result.json for that seat" as a general property, but codex-dispatch.mjs writes neither field in any of its five write paths. opencode-dispatch.mjs:558-568's writeErrorResult omits touchedFilesNote/isolationNote entirely, shaped differently from every later result; codex's equivalent (:479-486) includes touchedFilesNote.

## A11 — `--isolate` writes into the reviewed repository, and cleanup guidance is incomplete
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
Ran phase-1 then a phase-2 resume against a real git repo with a tracked modification and
an untracked file. Reuse worked: both phases reported the same worktreePath
(...\iso2\run\worktree), dirty state carried in.
$ ls target/.git/worktrees
worktree
```
`git worktree add` writes metadata inside the user's real `.git` directory — a run flagged `--isolate` is not read-only with respect to the target after all, only with respect to the working tree. Neither review-protocol.md:17-20 (lists `--isolate` under "real prevention") nor model-capabilities.md mentions this. phase-3-scorecard.md:62-68 gives the cleanup command `git worktree remove --force <worktreePath>` but not which directory to run it from (requires the repo, not the worktree), and never mentions `git worktree prune` — the only recovery if the scratchpad holding the worktree is cleared before cleanup runs, a realistic ordering since phase-1-independent-passes.md:7 puts the run directory under "the harness scratchpad or OS temporary directory". Separately: opencode-dispatch.mjs:128-129 USAGE says the worktree is reused "with the same --brief parent"; the code (line 598, `path.join(briefDir, '..', 'worktree')`) keys reuse on the brief's grandparent — correct for the documented phase1/phase2-as-siblings layout, but the USAGE sentence describing it is wrong.

## A12 — The protocol's SPECULATIVE-drop rule is unreachable in cross-review's only supported mode
Severity: LOW
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
review-protocol.md:152-154: "Drop SPECULATIVE claims that neither the peer raised
independently nor attempted to attack" — requires no attack was attempted.
SKILL.md:56: "Cross-review always uses adversarial exchange."
review-protocol.md:122-123: adversarial = "each seat attempts to refute every peer
claim or explicitly concedes with a reason."
```
If every claim is attacked or conceded by construction, the "neither ... nor attempted to attack" condition is never satisfied, and the filter can never fire. phase-3-scorecard.md:60 still requires the report to state how many SPECULATIVE claims were filtered — structurally always zero for this skill. Rule is presumably inherited from the shared protocol where pair-review's collaborate/none modes can reach it; the cross-review phase doc should not demand this statistic.

## Checks performed
- Full test suite: `node --test tests/*.test.mjs` — 64 pass, 0 fail, 7273ms.
- Repo validator from repo root: `node scripts/validate-repository.mjs` — passed, exit 0.
- Shared-file parity verified by diff on all five files SKILL.md's Maintenance section names — byte-identical, mechanically enforced by validate-repository.mjs:80-103.
- Old-schema leftover grep (CL\d, CX\d, CONCERN, Verdict, Confidence:, PASS/FAIL) — none found except A6's dangling "confidence-floor" and A5's enum drift.
- Claim-ID scheme consistency across all four reference docs (A/B → P → X/Y) verified consistent.
- Finding-schema field names consistent between review-protocol.md and phase-3 scorecard columns.
- CLI flag examples checked against actual parseArgs implementations — all exist and behave as documented; --effort alias for --variant confirmed at opencode-dispatch.mjs:205-207.
- Codex resume argument handling verified against integration test (dispatch-integration.test.mjs:46) — --sandbox/-C dropped on resume, matching phase-2-cross-examination.md.
- Worktree isolation executed end to end on a real git repo — tracked mod and untracked file both propagated, phase-2 resume reused the same path.
- Argument-parsing hardening reviewed and covered by passing tests (takeValue guard, --model/--variant metachar rejection, --timeout positive-integer validation, --effort rejecting literal "default").
- Windows-specific paths reviewed: WIN32_UNSAFE_CHARS rejection, absolute taskkill.exe resolution, pathToFileURL direct-run guard, OPENCODE_SPAWN_STDIO stdin-ignore with its regression test.
- Porcelain -z parsing and rename/copy handling — unit-tested, not re-derived.
- isSupportedPair prototype-pollution safety confirmed via Object.hasOwn, covered by passing test.
- Repository cleanliness after all runs: git status --porcelain identical before/after — 11 pre-existing modified files, nothing added or changed. Untracked scripts/result.json covered by the skill's own .gitignore, not created by this pass.

## What was not checked
- No live CLI behavior — neither codex nor opencode was invoked; every dispatch used a fake shim. Vendor-specific claims in source comments (opencode run ignoring stdin content but waiting for EOF, -s resume not dropping --dir, codex exec resume rejecting --sandbox/--cd, last text/agent_message event being the final response, -f attachment honored) are unverified, resting on the source comments' own claims.
- No POSIX execution — A2's SIGKILL-escalation and process-group findings are a code read plus documented Node semantics, not a reproduction (Windows-only host).
- No end-to-end protocol run — did not execute a real two-seat review; blind relabeling, coin flip, auditor spawn, and manifest writer assessed as documents only (A7, A8).
- Timeout kill effectiveness — confirmed the tests don't verify the kill (A3) but did not instrument process liveness after a timeout to determine whether win32 taskkill /T actually works.
- review-config.mjs read only in part — grepped for runtime/seat logic and executed setup for A9, did not audit line by line; its 30 passing tests taken at face value.
- Not reviewed: README.md, .github/, validate-package.mjs, and validate-repository.mjs beyond the parity-enforcement section — outside stated file scope.

## Rebuttals (from B) of A claims

### A1
Action: concede
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
`opencode-dispatch.mjs:591-609` records failed isolation but continues with the original `cdAbs`; `:629-638` launches the reviewer there; `:726-730` can return `status: completed`. For a non-git target, `:616-622` also disables touched-file detection, making the "protected only by touchedFiles detection" note false. The later orchestrator hard stop cannot prevent writes that already occurred.

### A2
Action: concede
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
`codex-dispatch.mjs:54-57` and `opencode-dispatch.mjs:77-80` test `child.killed` after sending `SIGTERM`. That property indicates successful signal delivery, not process termination, so the `SIGKILL` branch is skipped when a process ignores `SIGTERM`. The POSIX branch targets only the direct child PID and contains no process-group handling.

### A3
Action: concede
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
`dispatch-integration.test.mjs:76-79` and `:106-109` assert dispatcher exit, JSON status, and error text only. Neither records the fake child PID nor tests its post-timeout liveness. The unconditional grace resolution at `codex-dispatch.mjs:379-384` and `opencode-dispatch.mjs:464-469` permits those assertions to pass even if termination fails.

### A4
Action: concede
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
`model-capabilities.md:68-79` says the OpenCode path has post-hoc detection only. `review-protocol.md:17-20` and `phase-1-independent-passes.md:72-80` describe worktree isolation as preventive protection. These are contradictory operational statements. The absence of a native CLI sandbox does not negate prevention supplied by the wrapper's worktree.

### A5
Action: concede
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
`review-protocol.md:139` defines the closed values `unaddressed`, `conceded`, `disputed-no-counter-fact`, and `disputed-with-counter-fact`. `phase-3-scorecard.md:51-52` instead demonstrates "Conceded after check" and "Disputed without counter-fact." The examples therefore do not conform to the declared schema.

### A6
Action: concede
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
`phase-3-scorecard.md:34-36` instructs the auditor to apply a "confidence-floor" rule. `review-protocol.md:130-160`, the cited synthesis section, defines no such rule or confidence field. The only related calibration field is `Evidence strength`, and no floor behavior is specified for it.

### A7
Action: concede
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
`review-protocol.md:103-116` defines exclusions by Markdown location but gives no deterministic parser, case-matching rule, fixed-string rule, or distinction between target-related prose and self-identification. Legitimate prose discussing dispatcher filenames can therefore trigger the same hard stop as an identity leak. Claim-ID replacement similarly lacks boundaries protecting quoted evidence. The deprecated model ID cited as the exemption example is merely an evidence example, not an offered configuration choice, so that subpoint is cosmetic rather than functional; it does not invalidate the broader blind-transformation gap.

### A8
Action: concede
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
The scoped scripts contain no claim relabeler, Markdown-aware token scanner, coin-flip implementation, audit-label map, or manifest writer. The protocol assigns these operations to the orchestrator, but provides neither an executable helper nor tests for them. Thus the central blinding controls are instruction-enforced and manually interpreted, despite the protocol describing part of the check as mechanical.

### A9
Action: concede
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
`review-config.mjs:53-65` enforces adversarial mode and distinct declared provider IDs, but no seat topology. `phase-1-independent-passes.md:28-36` supplies execution mechanics only for a Claude-harness seat A and a CLI-dispatched seat B. `phase-2-cross-examination.md:7-10` repeats that assumption. Therefore a valid no-Claude configuration lacks a documented workflow, and `phase-3-scorecard.md:39-41` can require a factually false limitation statement.

### A10
Action: concede
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
`codex-dispatch.mjs:561-566` records requested/resolved model and effort fields; `opencode-dispatch.mjs:665` does not. Neither USAGE field list fully describes actual output. Early OpenCode errors at `:558-568` also use a reduced shape. The absence of `isolated`/`worktreePath` in Codex results is less material since that dispatcher has no `--isolate` mode, but a uniform schema would still need explicit false/null values if the manifest is expected to mirror dispatcher results directly.

### A11
Action: concede
Basis: STATIC_TRACE
Evidence strength: SUPPORTED
Evidence:
`git worktree add` at `opencode-dispatch.mjs:294` necessarily registers metadata beneath the source repository's `.git` directory. This does not modify reviewed source content and therefore is not equivalent to violating the protocol's "no fixes or commits" rule, but the side effect should be documented. `phase-3-scorecard.md:64-68` gives no repository context for `git worktree remove`; the command needs execution within the owning repository or an explicit `git -C <target-dir>`. Recovery after the temporary worktree disappears is also undocumented. USAGE `opencode-dispatch.mjs:128-129` says reuse is keyed by the same brief parent, while `:598` actually uses the brief directory's parent.

### A12
Action: refute
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
`review-protocol.md:122-123` defines two alternatives for every peer claim: attempt refutation or explicitly concede. A concession is not an attempted attack. Therefore a unique SPECULATIVE claim that the peer concedes satisfies both conditions at `review-protocol.md:152-154`: the peer did not raise it independently and did not attempt to attack it. The drop rule is reachable, although its treatment of conceded speculative claims may itself deserve clarification.
