# Seat B findings

## B1 [AC-1] [AC-10] [H2] — Alternate Markdown block declarations can pass as clean

Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: On every platform, a reviewer writes a strict clean declaration plus a real block inside an ordered list or with emphasis around the label alone. Frequency unknown.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/review-run.mjs:772
The fallback expression accepts neither "1. Blocked: ..." nor "**Blocked**: ...".

Executed through node --input-type=module -, importing seatBlockedLine:

Input:
## Checks performed
Blocked: none
1. Blocked: target: EACCES

Returned: ""

Sibling input:
## Checks performed
Blocked: none
- **Blocked**: target: EACCES

Returned: ""

Also executed shipped run() and validateProblems() against an in-memory
filesystem fixture, with filesystem mutations captured only in memory.
Both inputs produced:
actual validator problems: 0
validate Phase 1: clean
exit: 0

review-run.mjs:818-830 uses that empty return to bypass both the incomplete-seat
failure and the blocked-review warning.
```
Suggested fix: Extend block-only parsing to ordered lists and emphasis ending before the colon; preserve strict parsing for clean declarations and test both variants through the completion gate.
Same shape elsewhere: `review-run.mjs:827` also loses warnings for reviewers with findings, propagating through `build-manifest.mjs:254` and `build-report.mjs:746`. Same shared reader exists in `plugins/cross-review/skills/cross-review/scripts/review-run.mjs:762` and `C:/Users/dev/{.claude,.agents}/skills/{pair-review,cross-review}/scripts/review-run.mjs:762`.

## B2 [AC-3] [AC-10] — Tagged findings overwrite partly-confirmed hypothesis outcomes

Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: On every platform, reviewers partly confirm a hypothesis covering several variants and tag a finding proving only the remaining broken variant.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/build-report.mjs:493
: found.length > 0 ? 'confirmed'

Executed shipped buildReport() and renderMarkdown() through:
node --input-type=module -

Fixture:
- Hypothesis covers the normal path and fallback.
- Both reviewers write PARTLY CONFIRMED: normal path fixed, fallback broken.
- One standing finding carries the hypothesis tag.

Actual result:
{"outcomes":{"A":"PARTLY","B":"PARTLY"},"verdict":"confirmed","confirmed":1,"partly":0}

Rendered summary:
- Hypotheses: 1 confirmed

scripts/tests/build-report.test.mjs:363 tests overriding REFUTED with a
standing finding, but does not cover this partly-confirmed variant.
```
Suggested fix: Preserve explicit partial or mixed outcomes when deriving the aggregate; use finding presence to establish an issue without promoting partial confirmation to full confirmation.
Same shape elsewhere: All report renderers consume the same aggregate, including `build-report.mjs:946`, `:1018`, and `:1088`. Shared copy: `plugins/cross-review/skills/cross-review/scripts/build-report.mjs:493`; installed copies: `C:/Users/dev/{.claude,.agents}/skills/{pair-review,cross-review}/scripts/build-report.mjs:493`.

## B3 [AC-1] [AC-8] [AC-10] — Cancelled native turns can pass completion using a stale or absent reply

Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: A native reviewer’s current turn aborts after leaving schema-valid partial output. Its transcript has either no final reply or an earlier turn’s “written” reply. Holds on every platform using the permitted native route; frequency unknown.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/native-agent.mjs:95-99
turn_aborted is treated as "done".

native-agent.mjs:116-139
agentLastReply retains earlier replies across task_started and turn_aborted.

review-run.mjs:230-235
A null reply causes no failure; an earlier "written" reply passes.

Executed shipped agentState() and agentLastReply() with in-memory transcripts:
node --input-type=module -

First turn aborted:
none {"state":"done","reply":null}

Earlier successful turn, followed by a new aborted turn:
completed {"state":"done","reply":"written"}

Executed shipped phase1 --wait through run(), with an in-memory filesystem,
the permitted native descriptor, and shipped validateProblems():
state: done reply: written
actual validator problems: 0
validate Phase 1: clean
exit: 0

No filesystem writes or child processes occurred in this fixture.
```
Suggested fix: Distinguish aborted turns from successful completion, reject them at completion gates, and scope the final reply to the latest turn.
Same shape elsewhere: Shared native waiting feeds Phase 2 through `review-run.mjs:984` and the auditor through `review-run.mjs:1331`; status also labels this state finished at `review-run.mjs:1419`. Identical modules exist under `plugins/cross-review/skills/cross-review/scripts/` and `C:/Users/dev/{.claude,.agents}/skills/{pair-review,cross-review}/scripts/`, in both `native-agent.mjs` and `review-run.mjs`.

## B4 [AC-6] [AC-9] — Legacy snapshot markers reject unchanged worktrees

Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: On every platform, an isolated run created before these changes resumes after the scripts are updated.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/worktree-utils.mjs:115
if (JSON.stringify(a.changed) !== JSON.stringify(b.changed)) return false;

The diff against ea0b739 introduces "changed" into newly written markers.
Legacy markers have no such field; current fingerprints always have it.

Executed shipped setupIsolatedWorktree() through:
node --input-type=module -

Filesystem reads and git responses were injected in memory, representing an
unchanged clean target and snapshot. No files or processes were created.

Legacy marker:
{"ok":false,"reason":"snapshot fingerprint mismatch: the worktree at this path was built from a different target or the target has drifted since (toplevel/head/diff/untracked-files changed); refusing to reuse or silently rebuild it — remove the stale worktree and restart the affected review passes per review-protocol.md"}

Same fixture, adding changed: [] to both marker fingerprints:
{"ok":true,"reused":true,"skippedDirs":[]}
```
Suggested fix: Recognize legacy markers, verify their existing fields and current target/snapshot byte equality, then upgrade the marker rather than reporting nonexistent drift.
Same shape elsewhere: The same comparison rejects the nested snapshot fingerprint at `worktree-utils.mjs:217`, after the source comparison at `:201`. Shared copy: `plugins/cross-review/skills/cross-review/scripts/worktree-utils.mjs:115`; installed copies: `C:/Users/dev/{.claude,.agents}/skills/{pair-review,cross-review}/scripts/worktree-utils.mjs:115`.

## Checks performed

- AC-1: Executed shipped completion functions with memory-only fixtures; blocked declarations and aborted turns passed clean. NOT MET
- AC-2: Traced packet guards, identity masking, auditor repair messages, and host-context instructions. Live isolation and successful brief generation were not verified. PARTIAL
- AC-3: Compared hypothesis aggregate against both parsed reviewer outcomes; partial outcomes became fully confirmed. NOT MET
- AC-4: Traced terminal-event grace timers and shared shutdown paths. Real process-lifecycle fixtures require unauthorized scratch writes; foreground checks were awaited. PARTIAL
- AC-5: Repository metadata/parity validation passed; inspected changed command guidance and manual completion gates. Not every documented command was executed. PARTIAL
- AC-6: Executed legacy/current marker comparison through the shipped worktree setup function; unchanged legacy fixture was rejected. NOT MET
- AC-7: Checked removed rollout wrappers and changed helper paths; no additional weight finding established. MET
- AC-8: Reviewed all four feedback files against current implementations. Original explicit-block inputs are handled, but cancelled native turns retain the same partial-output completion failure described in the third finding. NOT MET
- AC-9: Legacy markers accepted before the new mandatory comparison are now rejected. Checked option-like paths, percent literals, Markdown path forms, and single-digit ports without finding another demonstrated narrowing regression. NOT MET
- AC-10: Existing tests miss alternate block formatting, aborted native turns, and partial hypotheses carrying findings; executed sibling fixtures expose those gaps. NOT MET

- H1: Spaces and tabs before a clean declaration return null; the original indentation bypass is gone. REFUTED
- H2: Strict block-before-clean and clean-before-block ordering works. Ordered-list and alternate-bold sibling declarations still disappear beside a clean declaration. PARTLY CONFIRMED
- H3: Traced successful terminal events, grace timers, tree-stop waits, and warning fields in both changed dispatchers. Close-only behavior of the unchanged dispatcher is an accepted deviation; process fixtures were not executable without scratch writes. REFUTED
- H4: Executed shipped path scanning with memory-backed existing option-like folders and two literal-percent filenames; all were retained. REFUTED
- H5: Executed emphasis, table, link, option-value, comma-pair, and encoded-colon URL inputs; existing paths were retained without a false joined missing path. REFUTED
- H6: Executed URL, IPv4, localhost, and IPv6 single-digit ports; zero and out-of-range ports were excluded. REFUTED
- H7: Entry-page wording now distinguishes native transport; executed seat configuration selects native transport on the corresponding host. REFUTED
- H8: Both manual phase references explicitly require reading block declarations and carrying blocked-review caveats. REFUTED
- H9: Both entry pages and packet templates acknowledge inherited host context; reviewer and auditor instructions classify it as unchecked context. REFUTED

- Field feedback: Checked cache-drift enumeration, shallow-review warnings, endpoint filtering/caps, path forms, explicit block reporting, effort markers, completion status, and shortened error causes against both Linux feedback files; retained accepted deviations.
- Field feedback: Checked auditor repair redaction, native completion handling, target-path rewriting, subfolder status scope, run-folder guards, synthetic zero-result reporting, companion publication order, verifier-error attribution, and watched-path comparison against both macOS feedback files. Cancellation sibling remains defective.
- Validation: Repository parity check passed. Four selected tests passed; four implicated source modules passed syntax checks. Full write-requiring suites were not run.
- Installed copies: Exact file-set and byte comparison passed for all four installed skills: 100 files per first skill copy, 104 per second skill copy.
- Coverage: read fully — supplied closing diff, four feedback files, native transcript module, both benchmark utilities; read partly — large lifecycle/preflight/report modules, tests, references, README, and repository scripts; not read — remaining unchanged regions and out-of-scope material.
- Brief-builder success-path check hit a refused output write; confirmed the output file remained absent.
Blocked: search utility: command not found; PowerShell path-formatting helper: MethodInvocationNotSupportedInConstrainedLanguage; brief-builder output: EPERM; process command-line inspection: Access denied
web: 0 queries, 0 page fetches