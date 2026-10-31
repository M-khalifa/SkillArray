### P1
Claim: P1
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Command: node --input-type=module
Imported shipped scrubDir and scanText; used 16 in-memory path shapes.

{"pathShapes":16,"misses":9}

Selected results:
{"shape":"home-posix","redactions":0,"blocking":0}
{"shape":"profile","redactions":0,"blocking":0}
{"shape":"home-variable","redactions":0,"blocking":0}
{"shape":"braced-profile","redactions":0,"blocking":0}
{"shape":"drive-less","redactions":0,"blocking":0}
{"shape":"dot","redactions":0,"blocking":0}
{"shape":"wrapped","redactions":0,"blocking":0}

path-utils.mjs:85-101 constructs literal alternatives without these expansions.
exchange.mjs:227 and blind-relabel.mjs:3109 publish the returned text.

Concede HIGH: multiple independently reproduced aliases disclose the run
location to blind readers. A concrete existing 8.3 alias was not verified;
the other reproduced variants establish the defect.
```

### P2
Claim: P2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Command: node --input-type=module
Called shipped seatBlockedLine on 16 shapes, both with and without an
earlier exact healthy declaration: 32 cases.

Representative input:
## No findings
## Checks performed
Blocked: none
- [ ] Blocked: shell EPERM

Result: ""

Heading, bullet, parenthesized-number, checkbox and table-row blocks
also disappeared after the earlier healthy declaration.

The earlier completion-gate execution independently returned exit 0,
clean=true and warning=false for heading and checkbox variants.

review-run.mjs:774 recognizes only unadorned level-two section headings.
review-run.mjs:785 excludes several leading Markdown markers.

Corrected severity: HIGH for missed real blocks that preserve a clean
result. The annotated "none (...)" examples are not grounds for concession:
the packet reserves the exact healthy form and deliberately treats other
block declarations conservatively.
```

### P3
Claim: P3
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Command: node --experimental-vm-modules --input-type=module
Called shipped peerLabelLines, claim-ID scanners and translateFindings.

Matrix: five reserved label families, bare and hyphenated.
{"labelShapes":10,"earlyWarnings":2,"laterRejections":10}

preflight.mjs:1815-1819 recognizes only the peer-label family.
Both repository-rule and packet warnings use this helper.

Corrected severity: LOW. The packet template already prohibits these
colliding labels; the remaining defect is a missing advisory warning
before downstream rewriting or refusal. The supplied severity rubric
rates missed advisory warnings LOW.
```

### P4
Claim: P4
Action: CONCEDE
Basis: EXECUTED
Evidence strength: SUPPORTED
Evidence:
```text
Command: node --experimental-vm-modules --input-type=module

Loaded the shipped dispatcher modules in memory, exposing their existing
runner functions. Spawn/kill were recording doubles; timers were accelerated.
Executed ten runner cases across both dispatcher families.

Selected results:
{"platform":"win32","family":"file-channel","shape":"exited-zero","code":0,"stopIncomplete":true,"killRequests":0}
{"platform":"win32","family":"final-message","shape":"exited-zero","code":0,"stopIncomplete":true,"killRequests":0}

The live-after-answer controls requested cleanup; exited controls did not.

spawn-utils.mjs:59 returns immediately on Windows.
claude-dispatch.mjs:280-289 and codex-dispatch.mjs:721-727 resolve without
descendant cleanup.
The fixture starts a detached, indefinitely running child with inherited
output; claude-dispatch.test.mjs:654 and :666 explicitly kill it afterward.

Concede HIGH for Windows: reporting stopIncomplete does not satisfy the
cleanup requirement. The accepted outside-process-group deviation names
Linux/macOS only. No live orphan was started during this cross-check;
the peer's live test supplies that evidence, while this check confirms
the missing cleanup branch.
```

### P5
Claim: P5
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```text
build-brief.mjs:164-165 assigns file-channel reviewers their own scratch
folder beside their output.

references/review-protocol.md:214-215 permits the files named by the brief,
including the task packet, own output and scratch folder.

build-brief.mjs:200 instead permits only:
"this brief and your own output"

references/phase-2-cross-examination.md:21-29 requires resuming the same
reviewer session.

Concede LOW as an own-artifact access restriction: a resumed reviewer
cannot reread its assigned scratch inputs or original packet under the
delta wording. Later instructions can narrow earlier permissions, so this
is not an unavoidable logical contradiction, but the omitted exceptions
can obstruct reproducing a counter-fact.
```

### P6
Claim: P6
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Command: node --experimental-vm-modules --input-type=module

Loaded the shipped path-utils module with Linux platform semantics and
node:path.posix. Tested twelve capitalization combinations in memory.

{"platform":"linux","caseShapes":12,"caseDistinctPaths":11,"caseDistinctPathsRewritten":11,"guardFoldsCase":false}

path-utils.mjs:100 unconditionally supplies the "gi" flags.
build-brief.mjs:213 folds case only on Windows and macOS.

Corrected severity: MEDIUM. On Linux these strings can identify different
folders; rewriting them corrupts an evidence reference handed to another
reader. This is a wrong artifact value, rather than merely wording or an
advisory warning. No filesystem fixture was created.
```

### P7
Claim: P7
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Command: node --experimental-vm-modules --input-type=module
Called shipped pathStartRe for Linux and macOS with one through five
leading slashes: ten shapes.

Selected results:
{"platform":"linux","slashes":2,"normalized":"/root/link/a.log","starts":1}
{"platform":"linux","slashes":3,"normalized":"/root/link/a.log","starts":0}
{"platform":"darwin","slashes":3,"normalized":"/root/link/a.log","starts":0}

build-brief.mjs:250 accepts only one or two leading slashes.
build-brief.mjs:268 performs filesystem resolution only for recognized starts.
preflight.mjs:1434 repeats the restriction.

Corrected severity: MEDIUM. The guard variant can bypass a blinding
boundary through a link or dot-segment spelling; it is more than a missed
advisory path warning. Literal direct paths can still be caught by the
earlier substring check. No live symlink experiment was performed, so
these results do not establish HIGH severity for an executed end-to-end leak.
```

web: 0 queries, 0 page fetches