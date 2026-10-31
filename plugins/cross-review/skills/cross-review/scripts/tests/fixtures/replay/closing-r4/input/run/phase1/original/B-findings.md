# Seat B findings

## B1 [AC-2] [AC-8] [AC-10] [H1] — Directory-led relative paths bypass run-folder protection
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: Windows, when packet text or findings cite the run folder through a relative path beginning with a directory name. Frequency unknown.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/build-brief.mjs:246-276
The tokenizer recognizes rooted paths, "~", "./" and "../", but not directory-led relative paths.

Node stdin harness imported shipped runDirNamedIn, scrubDir and build.
Target: plugins/pair-review/skills/pair-review/scripts
Synthetic run directory: its sibling references directory.
Fixture packet/output I/O was held in memory.

Input: tests/../../references/review-protocol.md
RELATIVE bare {"rewrites":0,"guard":null}
BARE_RESOLVES_INSIDE true targetContainsRun false

Shipped builders:
BRIEF 3 "tests/../../references/review-protocol.md"
{"phase1":{"accepted":true,"pathIncluded":true},
 "auditor":{"accepted":true,"pathIncluded":true}}

Twelve shapes tested. Both builders refused the "../" and "./" controls,
but accepted ten directory-led variants, including backslashes, mixed
separators, dot segments, Markdown links, quoting and file:line notation.

tests/build-brief.test.mjs:641-652 tests parent-relative paths and absolute
paths containing "..", but omits directory-led relative paths.
```
Suggested fix: Resolve directory-led path tokens against the target before hand-off; extend builder and hand-off tests with these variants.
Same shape elsewhere: build-brief.mjs:157,159,320,324; exchange.mjs:235; blind-relabel.mjs:3112, all under the same shared scripts directory.

## B2 [AC-1] [AC-10] [H2] — Formatted section headings let a blocked no-findings review pass clean
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: Everywhere; reproduced on Windows. A no-findings file has an earlier clean declaration and later reports a block beneath an emphasized or parenthesized checks heading. Frequency unknown.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/review-run.mjs:773-796
Section recognition tests the raw heading. Unrecognized level-two headings
end the preceding recognized section, hiding subsequent block declarations.

Relevant fixture input:
## No findings
Blocked: none

## **Checks performed**
Blocked: target: EACCES

Node stdin harness called shipped run:
run(['phase1','--run-dir',base,'--wait',
     '--native-done','A,B','--max-wait','1'], io)

Filesystem operations used an in-memory Map. The validation runner invoked
shipped validateProblems against the actual fixture texts.

WAIT "## **Checks performed**"
{"code":0,"advanced":true,
 "output":"...validate Phase 1: clean\nnext: run: review-run phase2 ..."}

Eleven heading variants tested. Six passed despite the declared block:
parenthesized numbering, bold, italic, underline-style emphasis and code marks.
Plain headings correctly stopped the run. The separate 80-cell prefix matrix
had no misses.

tests/review-run.test.mjs:2345-2347 varies label formatting and heading levels,
but omits formatting around the section name.
```
Suggested fix: Normalize section-heading markup and parenthesized numbering before recognition, then exercise the actual completion gate in regression tests.
Same shape elsewhere: review-run.mjs:849-855 consumes the missed declaration; review-run.mjs:860-864 also loses the corresponding warning.

## B3 [AC-2] [AC-5] [AC-9] [AC-10] [H10] — Sibling directory names still get rejected or rewritten
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: Everywhere; reproduced on Windows. Evidence names a distinct sibling directory with punctuation, Unicode or a quoted space.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/path-utils.mjs:101-105
plugins/pair-review/skills/pair-review/scripts/build-brief.mjs:231-238
plugins/pair-review/skills/pair-review/scripts/build-recheck-packet.mjs:313-324

Node stdin harness called shipped scrubDir, runDirNamedIn and rewritePaths
on twelve backticked sibling paths. Selected actual output:

{"suffix":"+1","scrubbed":0,"guard":true,"recheckChanged":false}
{"suffix":"@x","scrubbed":0,"guard":true,"recheckChanged":false}
{"suffix":"(2)","scrubbed":0,"guard":true,"recheckChanged":false}
{"suffix":"é","scrubbed":0,"guard":true,"recheckChanged":false}
{"suffix":"中","scrubbed":0,"guard":true,"recheckChanged":false}
{"suffix":" 2","scrubbed":1,"guard":false,"recheckChanged":true}
{"suffix":".é","scrubbed":0,"guard":true,"recheckChanged":true}
{"suffix":".中","scrubbed":0,"guard":true,"recheckChanged":true}

The new scrubber preserves several siblings, but mentionsDir still uses an
ASCII boundary and refuses them. Quoted space-continued siblings are silently
rewritten; recheck path replacement also rewrites Unicode dot-suffix siblings.

The quoted-space reproduction is outside the accepted unquoted-space deviation.
```
Suggested fix: Align all three directory-boundary checks, including complete quoted paths, so sibling names survive unchanged.
Same shape elsewhere: exchange.mjs:229-235; blind-relabel.mjs:3109-3112; build-recheck-packet.mjs:503-511.

## B4 [AC-1] [AC-8] [AC-10] [H9] — Manifest rebuild accepts malformed and truncated seat files as completed
Severity: MEDIUM
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: Everywhere; reproduced on Windows. A finished audit remains while a Phase 1 file is truncated, malformed or contains only a quoted heading.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/build-manifest.mjs:255-257
The completion check searches raw text for any letter-number claim heading
or a "No findings" prefix. It neither excludes fences nor validates the role
or claim fields.

Node stdin harness called shipped initBody with an in-memory run and compared
each text using shipped validateProblems. Eleven shapes tested.

MANIFEST empty {"status":"incomplete","missing":["B"],"valid":false}
MANIFEST claim-heading {"status":"completed","valid":false}
MANIFEST partial-fields {"status":"completed","valid":false}
MANIFEST quoted-heading {"status":"completed","valid":false}
MANIFEST quoted-no-findings {"status":"completed","valid":false}
MANIFEST wrong-role {"status":"completed","valid":false}
MANIFEST no-findings-prefix {"status":"completed","valid":false}

Six malformed shapes were accepted. Valid ordinary and BOM-prefixed
no-findings files remained accepted.

tests/build-manifest.test.mjs:1445-1452 checks truncation before a claim heading,
but not truncation after it or headings inside fences.

build-report.mjs:727,734 derives COMPLETE and reviewer-pass count from this manifest.
```
Suggested fix: Reuse existing unfenced, role-specific schema validation before marking the review completed.
Same shape elsewhere: build-report.mjs:727,734 propagates the incorrect completion and pass count.

## B5 [AC-5] [H5] — Native Phase 2 prompts retain the read restriction removed from delta briefs
Severity: LOW
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Trigger: Everywhere, on native Phase 2 resumes.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/build-brief.mjs:200
"except this brief, your Phase 1 brief, the task packet, your own output
and your scratch folder"

plugins/pair-review/skills/pair-review/scripts/review-run.mjs:265
"Do not read any other file in the run folder. Do not edit any other file."

The native resume message still forbids the packet, earlier brief and scratch
work that the corrected delta brief permits. The scratch write permission
also conflicts with the resume message.
```
Suggested fix: Carry the delta brief’s explicit read and scratch permissions into the native resume message and matching manual instructions.
Same shape elsewhere: pair-review/references/phase-2-cross-examination.md:274,288 and cross-review/references/phase-2-cross-examination.md:436,450, beneath their respective plugins’ skill directories.

## B6 [AC-4] [AC-10] [H11] — Remaining Windows stop paths can target a reused PID
Severity: HIGH
Basis: EXECUTED
Evidence strength: SUPPORTED
Trigger: Windows: a command exits while inherited output remains open, then a stop signal or applicable timeout arrives after its PID has been reused. The reuse window is uncommon; frequency unknown.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/preflight.mjs:550-561
stopOnSignal unconditionally calls killTree.

plugins/cross-review/skills/cross-review/scripts/opencode-dispatch.mjs:73-83,534-550
Signal and timeout callbacks likewise lack an exited-child guard.

Node stdin harness invoked shipped runWithTimeout with an injected child and
process emitter. Process spawning was intercepted; no real kill was executed.
The child emitted exit before SIGINT.

PROCESS_BEFORE pid 4194301: absent
KILL_REQUESTS 10
{"command":"C:\\Windows\\System32\\taskkill.exe",
 "args":["/pid","4194301","/T","/F"]}
PROCESS_AFTER pid 4194301: absent

All ten exited-state variants requested the kill. The third dispatcher’s
signal helper also requested kills for all eight exited states in its
ten-state matrix. The other two dispatchers correctly skipped those states.

Actual PID reuse and an unrelated victim kill were not exercised.
```
Suggested fix: Apply the existing exited-child guard to these signal and timeout callbacks before any tree-kill request.
Same shape elsewhere: preflight.mjs:725,1307,1310,1336,1338,1365,1413,1415,1580,1582,1786,2071; plugins/cross-review/skills/cross-review/scripts/opencode-dispatch.mjs:537.

## B7 [AC-1] [AC-10] [H8] — A resumed native turn can reuse the previous written reply
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: Everywhere, for assistant-message transcripts whose resumed turn ends without reply text.
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/native-agent.mjs:125-135
agentLastReply resets on task-start events, but not on a new user prompt.
An empty assistant message therefore leaves the previous reply intact.

Node stdin harness called shipped agentState and agentLastReply against
eleven in-memory transcript shapes. Selected actual output:

AGENT task-empty {"state":"done","reply":null}
AGENT native-empty {"state":"done","reply":"written"}
AGENT native-text-empty {"state":"done","reply":"written"}
AGENT native-text-space {"state":"done","reply":"written"}
AGENT native-handback-empty {"state":"done","reply":"written"}
AGENT native-handback-missing {"state":"done","reply":"written"}

Each native reproduction contained an earlier "written", a genuine new user
prompt, then a final empty message or hand-back. Explicit new replies and
explicit block replies were read correctly.

review-run.mjs:241-243 sees "written", so neither missing-reply warning fires.
```
Suggested fix: Reset the remembered reply on genuine new user prompts, using the existing prompt predicate while excluding tool results and meta entries.
Same shape elsewhere: review-run.mjs:682 covers both reviewer phases; review-run.mjs:1365 covers the auditor.

## Checks performed

- AC-1: Executed completion-gate, manifest and transcript fixtures against shipped functions; residual defects are B2, B4 and B7. NOT MET
- AC-2: Tested twelve relative-path shapes through both brief builders and twelve sibling-name shapes; B1 and B3 remain. NOT MET
- AC-3: Reconciled twelve benchmark count fixtures and a criterion/hypothesis fixture independently. Live report cost accounting was not exercised. PARTIAL
- AC-4: Captured stale-PID kill requests with simulated children; process snapshots confirmed the fixture PID absent before and after. No servers, watchers or background commands were started. B6 remains. NOT MET
- AC-5: Repository metadata validation passed; checked generated instructions against native resume messages and manual procedures. B5 remains. NOT MET
- AC-6: Valid ordinary and BOM-prefixed seat markers remained accepted. Exhaustive historical-run rendering was not executed. PARTIAL
- AC-7: No substantiated weight finding; inspection concentrated on correctness and changed trust boundaries. PARTIAL
- AC-8: Inspected all six feedback issue inventories and relevant fixes. Run-path, completion and sibling-input defects remain in B1–B4, B6 and B7; accepted deviations were excluded. NOT MET
- AC-9: Reviewed the closing diff’s boundary, heading, completion and exit-state changes. B3 exposes inconsistent acceptance after the narrower rewrite. POSIX slash and case branches retained their intended behavior. NOT MET
- AC-10: Existing matrices omit the broken relative-path, section-heading, truncation and resumed-message variants demonstrated above; the native prompt overlay also remains unchecked. NOT MET
- H1: Home, standard-variable, drive-less, encoded and explicit dot-relative controls were caught or rewritten. Directory-led relative variants survive both builders and the shared hand-off guard; B1. PARTLY CONFIRMED
- H2: Eighty prefix/section combinations passed, but six formatted section variants advanced the actual completion gate despite a declared block; B2. PARTLY CONFIRMED
- H3: Twelve label/checklist shapes verified the expanded helper; both packet and repository-rule warnings use it. REFUTED
- H5: Delta text is corrected, but native resume and manual messages retain the conflicting restrictions; B5. PARTLY CONFIRMED
- H6: Executed scrubber case branches for Windows, Linux and macOS; Linux preserved differently cased siblings. REFUTED
- H7: Executed one, two, three, four and ten leading-slash cases for both POSIX tokenizer branches; inspected the matching preflight pattern. REFUTED
- H8: Task-event transcripts now expose the missing reply. Assistant-message transcripts retain an earlier reply after a resumed blank turn; B7. PARTLY CONFIRMED
- H9: Empty and pre-heading truncations are rejected; six malformed post-heading or quoted shapes still produce completed manifests; B4. PARTLY CONFIRMED
- H10: Several sibling suffixes are preserved by redaction but then falsely refused; quoted spaces and Unicode dot suffixes still suffer rewrites; B3. PARTLY CONFIRMED
- H11: Ten-state matrices verified both updated dispatchers. The equivalent preflight and third-dispatcher paths remain unguarded; B6. PARTLY CONFIRMED
- Installation: All four installed copies matched repository bytes: 100 files per pair-review copy and 104 per cross-review copy. Shared scripts also matched. No applicable review-plugin cache copy was present.
- Validation: Repository metadata/shared-file validation passed; twelve syntax checks passed. Full suites were not run because they create files and no scratch directory was authorized. Supplied preflight contains Tier 1 evidence only.
- Coverage: read fully — closing diff and benchmark helpers; read partly — lifecycle scripts, protocol, tests, documentation and feedback evidence; not read — every remaining unchanged file body.
- Search fallback completed with Node after the preferred search executable was unavailable; repository status succeeded despite its global-ignore warning.

Blocked: rg execution: command not found; git global ignore configuration: Permission denied
web: 0 queries, 0 page fetches