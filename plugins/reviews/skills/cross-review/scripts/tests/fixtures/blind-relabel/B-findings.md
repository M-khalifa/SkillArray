# Seat B findings — cross-review skill self-audit

> HISTORICAL TEST FIXTURE: recorded output from a past review pass, kept as a stable
> input for blind-relabel.mjs's own tests. Not a claim about the current code.

## Findings

### B1 — Provider/model mismatch can defeat cross-vendor enforcement

Severity: HIGH  
Basis: EXECUTED  
Evidence strength: REPRODUCED  
Evidence:

```text
Command:
node --input-type=module -e "import {resolveConfig} from './plugins/reviews/skills/cross-review/scripts/review-config.mjs'; const c=resolveConfig(null,'cross-review',{'a-provider':'anthropic','a-runtime':'claude',a:'opus','b-provider':'google','b-runtime':'opencode',b:'anthropic/claude-opus-5'}); console.log(JSON.stringify(c.reviewers));"

Output:
{"A":{"provider":"anthropic","runtime":"claude","model":"opus","effort":"default"},"B":{"provider":"google","runtime":"opencode","model":"anthropic/claude-opus-5","effort":"default"}}
```

`review-config.mjs:41-47` validates provider, runtime, and model independently. `review-config.mjs:63-64` compares only declared provider strings. It never verifies that an OpenCode model’s `provider/model` prefix matches `seat.provider`.

Result: configuration can claim two different providers while both selected models route to the same provider. Preflight prose asks the orchestrator to check runtime output, but the structural helper accepts and can persist an invalid cross-vendor pairing.

### B2 — `--isolate` fails open and runs against the real source tree

Severity: HIGH  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:

```text
opencode-dispatch.mjs:591-609
- If --cd is not a git repository, or worktree creation fails, code sets
  isolationNote but leaves cdAbs pointing at the original target.

opencode-dispatch.mjs:629-638
- runOpencode() is then called with that original cdAbs.

opencode-dispatch.mjs:726-730
- The dispatch can still finish with status: "completed".
```

This directly conflicts with `phase-1-independent-passes.md:76-78` and `review-protocol.md:231-233`, which call failed isolation a hard stop. The documented completion-gate check occurs only after the unrestricted reviewer has already run, so it cannot protect source integrity.

The test at `opencode-dispatch.test.mjs:269-277` verifies only that the setup helper reports failure. No test verifies that the dispatcher refuses to launch after that failure.

### B3 — Configuration supports seat layouts that phase instructions cannot execute

Severity: HIGH  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:

```text
SKILL.md:20-22
"A seat can use the Claude harness, Codex CLI, or OpenCode's configured
provider bridge."

review-config.mjs:53-65
Cross-review requires only different provider IDs; it does not constrain
seat A to the Claude harness or seat B to a CLI dispatcher.

review-config.test.mjs:140-149
Explicitly verifies seat A can be an uncatalogued OpenCode provider.
That test passed in the executed suite.

phase-1-independent-passes.md:28-36
Defines seat A only as a Claude-harness agent and seat B only as Codex
or OpenCode.

phase-2-cross-examination.md:7-10
Again assumes a Claude agent plus a CLI-resumed seat B.
```

Valid configurations such as seat A via OpenCode and seat B via another CLI—or reversed Claude/CLI seats—lack defined Phase 1 and Phase 2 mechanics. `phase-3-scorecard.md:39-41` also hardcodes the auditor-family limitation around a Claude reviewer, which is false for configurations containing no Claude reviewer.

### B4 — OpenCode results omit model/effort metadata promised by the skill

Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:

```text
SKILL.md:98-100
"Result metadata records requested model/effort..."

codex-dispatch.mjs:561-566
Writes modelRequested, effortRequested, modelResolved, effortResolved,
and selectionNote.

opencode-dispatch.mjs:665
baseFields contains only sessionId, touchedFiles, isolated, and worktreePath.

opencode-dispatch.mjs:726-730
Completed result adds finalMessage and status, but no model/variant metadata.
```

The OpenCode dispatcher passes `-m` and `--variant` to the child, but does not record requested or resolved selections in `result.json`. Its tests do not assert such fields.

### B5 — Unix timeout escalation never sends `SIGKILL`

Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:

```text
codex-dispatch.mjs:54-57
child.kill('SIGTERM');
setTimeout(() => {
  if (!child.killed) child.kill('SIGKILL');
}, 5000);

opencode-dispatch.mjs:77-80
Uses the same logic.
```

In Node, `child.killed` becomes true when a signal is successfully sent; it does not mean the process exited. Therefore, a child that ignores `SIGTERM` will not receive the intended `SIGKILL`. The watchdog resolves the dispatcher after five seconds, potentially leaving the reviewer process running.

`dispatch-integration.test.mjs:53-110` checks only that the wrapper exits and writes `timed-out`. It does not verify the child PID/process tree is gone, and the executed platform followed the Windows `taskkill` branch rather than this Unix branch. This finding is based on reading only for the Unix path.

### B6 — Blind-token screening is underspecified and has no mechanical implementation

Severity: MEDIUM  
Basis: SOURCE_CITATION  
Evidence strength: SUPPORTED  
Evidence:

```text
review-protocol.md:103-116
Requires relabeling, stripping fenced code and inline-backtick spans,
excluding Evidence, adding configured tokens, and grepping remaining prose.

phase-2-cross-examination.md:14-25
Repeats the requirement but provides no command or transformation format.

phase-3-scorecard.md:12-24
Adds coin-flipped X/Y relabeling and repeats the same prose scan.
```

No scoped script implements relabeling, Markdown-aware evidence removal, token normalization, scanning, or the coin flip. The prose leaves unresolved mechanical decisions:

- Case sensitivity is unspecified; ordinary `grep` would miss capitalized proper names.
- “Evidence block” boundaries are not defined for rebuttals, whose prompt does not require fenced evidence.
- Legitimate target discussion outside Evidence can contain the same vendor/model tokens and trigger a hard stop.
- Literal configured strings may need fixed-string rather than regex matching.
- Claim-ID replacement must distinguish claim references from identical text inside quoted source.

The protocol can be performed through judgment, but not reliably or reproducibly “as written.” No tests cover any blind-exchange transformation or leak detection.

### B7 — Model-capabilities documentation still describes pre-isolation behavior

Severity: MEDIUM  
Basis: SOURCE_CITATION  
Evidence strength: DETERMINISTIC  
Evidence:

```text
model-capabilities.md:68-79
States there is no OpenCode read-only sandbox and that touchedFiles is
post-hoc detection, "never prevention." It requires a clean baseline.

review-protocol.md:17-20
Names OpenCode --isolate as real prevention.

phase-1-independent-passes.md:72-80
States --isolate redirects execution into a disposable worktree and is
the primary guarantee.
```

The first sentence about absence of a native CLI sandbox remains true, but the conclusion that the skill provides only detection is stale after the worktree implementation. Operators reading the model-capabilities reference receive contradictory security guidance.

### B8 — Partial worktree setup can leave a poisoned worktree that later appears reusable

Severity: MEDIUM  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:

```text
opencode-dispatch.mjs:285-290
Any existing <worktree>/.git causes immediate { ok: true, reused: true }.

opencode-dispatch.mjs:293-324
The worktree is registered before tracked changes and untracked files
are copied.

opencode-dispatch.mjs:300-317
A diff/apply/list failure returns { ok: false } without removing the
partially prepared worktree.
```

After such a failure, a retry using the same run directory sees `.git`, reports successful reuse, and skips the failed snapshot-copy steps. Reviewer can then inspect clean or incomplete content while `isolated: true` is reported.

Filesystem failures during `mkdir`/`copyFile` at `opencode-dispatch.mjs:319-323` also escape rather than returning the documented structured failure. Tests cover only successful setup/reuse and failure before worktree creation.

### B9 — Timeout result schema contradicts dispatcher output

Severity: LOW  
Basis: STATIC_TRACE  
Evidence strength: DETERMINISTIC  
Evidence:

```text
codex-dispatch.mjs:125-126
opencode-dispatch.mjs:154-155
Document error as present only when status is "error".

codex-dispatch.mjs:574-579
opencode-dispatch.mjs:676-681
Both write error for status: "timed-out".
```

Consumers following the documented schema may reject or discard the timeout explanation.

## Checks performed

- Ran `node --test tests/*.test.mjs` from the dispatcher directory. Initial restricted run: 55 passed, 9 failed because OS-temp `mkdtemp` returned `EPERM`; no product assertion failed.
- Reran the exact suite with disposable OS-temp access: `64 passed, 0 failed, 0 skipped`, duration `6934.313ms`. Shell startup also emitted an unrelated PowerShell-profile parser warning; command exited successfully.
- Ran `node scripts/validate-repository.mjs` from repo root. Output: `SkillArray: repository metadata and shared review files passed`.
- Exact legacy-schema scan found zero `Verdict:`, `Confidence:`, `CLn`/`CXn` headings, `PASS | FAIL | CONCERN`, `final_state`, or `evidence_strength` remnants.
- Dispatcher argument tests confirmed model/effort forwarding on fresh and resumed Codex calls.
- Session-identity tests confirmed missing and mismatched session IDs fail closed.
- Git-porcelain tests confirmed spaces, non-ASCII names, renames, and status-code changes are handled.
- Windows unsafe-argument tests passed.
- Basic worktree test confirmed tracked modifications and ordinary untracked files are copied and reused.
- Repository remained unedited by this review; test artifacts were created only under disposable OS-temp locations.

Not checked: live paid reviewer calls, actual authentication/model entitlement, Unix process behavior by execution, hostile/complex worktree fixtures such as untracked symlinks or nested repositories, and a real end-to-end three-phase blind review.

## Rebuttals (from A) of B claims

### B1 — Provider/model mismatch can defeat cross-vendor enforcement
Action: concede
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
Independently reproduced. Genuine gap missed by the other pass's own Phase 1 (which tested a no-Claude-seat pairing but never a declared-provider-vs-model-routing mismatch).
```
$ node --input-type=module -e "import {resolveConfig} from './plugins/reviews/skills/cross-review/scripts/review-config.mjs'; const c=resolveConfig(null,'cross-review',{'a-provider':'anthropic','a-runtime':'claude',a:'opus','b-provider':'google','b-runtime':'opencode',b:'anthropic/claude-opus-5'}); console.log(JSON.stringify(c.reviewers));"
{"A":{"provider":"anthropic","runtime":"claude","model":"opus","effort":"default"},
 "B":{"provider":"google","runtime":"opencode","model":"anthropic/claude-opus-5","effort":"default"}}
```
review-config.mjs's validateSeat checks seat.model only against a token regex and a not-inherit guard; it never parses the provider/ prefix or compares it to seat.provider. The cross-vendor rule is a bare provider-string comparison. Severity is justified: this defeats the skill's stated core premise (SKILL.md: "requires different providers"), and produces a manifest asserting cross-vendor topology with two different declared providers while both models actually route to the same vendor. Refinement: the provider/model prefix is only meaningful for the opencode runtime; a claude- or codex-runtime seat's model has no prefix to check, so the fix is narrower than "validate all models" — OpenCode seats specifically.

### B2 — `--isolate` fails open and runs against the real source tree
Action: concede
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
Same defect found independently. Executed run against a non-git target with a fake CLI shim confirmed cdAbs stays on the real target, the run proceeds, status completed with exit 0 — the completion-gate check happens only after the unrestricted reviewer already ran. Additional finding: the isolationNote is itself false in the non-git branch — it promises fallback protection via touchedFiles, but the same non-git condition re-fails isGitRepo, so touchedFiles is null too. Fail-open plus a misleading assurance, not just fail-open. Test-coverage claim confirmed: the existing test asserts only the helper's own failure return, nothing about dispatcher behavior after that failure.

### B3 — Configuration supports seat layouts that phase instructions cannot execute
Action: concede
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
Same defect found independently, upgraded to an executed persistence — a no-Claude-seat cross-vendor config was saved to disk, not merely accepted in memory. The phase-3-scorecard.md limitation-statement point is the sharpest: it instructs the orchestrator to state verbatim that the auditor is still the same model family as one or both reviewers (Claude) — false under this configuration. Note: not fully redundant with B1 — B1 is a config that lies about being cross-vendor; B3 is a config that is honestly cross-vendor but has no dispatch mechanics. Same root cause: validateConfig enforcing only a provider-inequality check.

### B4 — OpenCode results omit model/effort metadata promised by the skill
Action: concede
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
Independently found; confirmed opencode-dispatch.mjs's baseFields contains exactly sessionId/touchedFiles/isolated/worktreePath against codex's five-field block. Addition: the divergence runs both directions — review-protocol.md says isolated/worktreePath "mirror the dispatcher's own result.json for that seat", but codex-dispatch.mjs writes neither field in any of its five write paths. General schema-drift, not an OpenCode-only omission. Also: codex-dispatch.mjs's own USAGE omits all five model/effort fields the code actually writes — neither dispatcher's USAGE is a reliable schema.

### B5 — Unix timeout escalation never sends `SIGKILL`
Action: concede
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
Identical finding independently, including the child.killed semantics reasoning. Addition: the USAGE text is affirmatively wrong off-Windows, not merely untested — both files promise "whole process tree" and the helper is named killTree, but the POSIX branch spawns with no detached:true and no process-group kill, signaling only the direct child; a forking shim orphans the grandchild. Also: the grace-resolve writes status timed-out regardless of whether the kill landed, and the touchedFiles snapshot is taken before that point, so a surviving reviewer process's post-timeout writes are invisible to the audit — worse than a stray process.

### B6 — Blind-token screening is underspecified and has no mechanical implementation
Action: concede
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
Converges with independent findings on the same gap; confirmed the absence of any implementation across all four scoped scripts and all five test files. Sharper decomposition on: case-sensitivity (tokens listed lowercase, but the highest-risk leak form is a capitalized proper noun at sentence start); the "legitimate target discussion triggers a hard stop" point rated most serious because it is certain, not possible, when the reviewed target is this skill itself; and the exemption's own worked example is itself a stale, deprecated model ID per the skill's own catalog. Verdict — performable through judgment, not reliably "as written" — is correct and is why this is a design gap, not a code bug.

### B7 — Model-capabilities documentation still describes pre-isolation behavior
Action: concede
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
Identical finding independently, exact citations confirmed. The distinction preserved: the first sentence (no native OpenCode CLI sandbox flag) remains true; only the conclusion is stale. Additions: file mtimes corroborate staleness (the stale file is a day older than the rewritten docs); and the blast radius is larger than one file — the repo validator enforces this file byte-identical between cross-review and pair-review, so the contradictory guidance ships in both packages, and the validator passes precisely because both stale copies match each other. Parity enforcement guarantees consistency, not correctness.

### B8 — Partial worktree setup can leave a poisoned worktree that later appears reusable
Action: concede
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
Strongest claim in the peer set; missed entirely in the other pass's own Phase 1 (which tested worktree reuse only on the happy path). Constructed the interrupted state directly by simulating a crash right after git worktree add but before the copy steps, then calling the exported helper: it reported {"ok":true,"reused":true} against a worktree missing both the tracked modification and the untracked file that existed in the real target. Mechanism: the early-return treats mere existence of the worktree's .git as proof of a complete snapshot, but git worktree add creates .git before the diff-apply and untracked-file copy steps run — existence proves registration, not population. Consequence is worse than "inspect incomplete content": it directly violates the same-source-snapshot requirement with isolated:true and status:completed both reported, and nothing in the pipeline can detect it. For a review whose purpose is auditing uncommitted work, this can make one seat's pass vacuous while looking clean. Second half confirmed: the copy loop is unguarded and the call site has no try/catch in main, so a filesystem error throws past the structured-failure contract into the top-level catch, producing a nonzero exit with no result.json at all — a fourth failure shape none of the docs describe.

### B9 — Timeout result schema contradicts dispatcher output
Action: concede
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
All four cited locations verified directly and are exact. LOW severity is appropriate — the code behavior (writing error on timeout) is more useful than the documented contract, so the documentation should change, not the code. Same class as B4 and the other pass's own equivalent finding: at least three separate USAGE/code drifts in these dispatchers — worth treating as one documentation-sync defect rather than three unrelated ones.
