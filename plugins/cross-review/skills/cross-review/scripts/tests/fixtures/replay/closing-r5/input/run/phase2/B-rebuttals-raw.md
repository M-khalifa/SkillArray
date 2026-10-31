### P1
Claim: P1
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```text
Independent source confirmation; the live process reproduction was not rerun.

plugins/pair-review/skills/pair-review/scripts/claude-dispatch.mjs:256-262
The already-exited, unanswered timeout branch sets only stream.timedOut,
then calls cleanup() and resolves. cleanup() cancels the exit-wait timer.

claude-dispatch.mjs:332-333
The cancelled exit-wait path would have set stopIncomplete and exitedOutputOpen.

claude-dispatch.mjs:523-525,551
The warning requires exitedOutputOpen; the timeout message instead says "killed".

plugins/pair-review/skills/pair-review/scripts/codex-dispatch.mjs:680-687
The equivalent branch resolves timedOut without either warning flag.

codex-dispatch.mjs:798-805
The later exit-wait callback returns when settled, so it cannot repair the record.

Severity MEDIUM is supported for the incorrect record and missing warning.

Additional fix consideration:
review-run.mjs:834-837 returns unless record.stoppedAfterAnswer is true.
Setting stopIncomplete and exitedOutputOpen alone would therefore not make an
unanswered failed attempt propagate through noteAnswerStop into the report caveat.
```

### P2
Claim: P2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
PowerShell stdin piped to node.
Imported shipped initBody, seatBlockedLine and validateProblems.
Filesystem reads used an in-memory fixture map; no physical files were written.
Each fixture contained a complete claim followed by the tested section.

Selected results:
Heading                         Validator problems  Section read  Manifest
## Checks performed             0                   yes           completed
## Checks performed:            0                   yes           completed
### Checks performed            0                   yes           incomplete
#### Checks performed           0                   yes           incomplete
## (1) Checks performed         0                   yes           incomplete
## **Checks performed**         0                   yes           incomplete
## `Checks performed`           0                   yes           incomplete
# Checks performed              0                   yes           incomplete
## No findings.                 0                   yes           incomplete
### No findings                 0                   yes           incomplete
    ## Checks performed         0                   no            completed

Twelve heading shapes were executed.

plugins/pair-review/skills/pair-review/scripts/build-manifest.mjs:260-261
Lines are trimmed, then matched against:
  /^##\s+Checks performed\b/i
  /^##\s+No findings$/i

review-run.mjs:776,784 accepts broader headings after removing emphasis/code marks.
build-report.mjs:270 separately requires an exact level-two Checks performed heading.

Severity MEDIUM is supported.
Scope qualification: the "## 4. Checks performed" fixture also produced one
structural-validator problem. That particular row does not establish that
Phase 1 validation passes, but the other reproduced variants do.
```

### P3
Claim: P3
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Corrected severity: HIGH under the packet's rubric for a reproduced blinding bypass.

Executed shipped runDirNamedIn and scrubDir on Windows.
The target and synthetic run directories were separate existing repository folders:
  target = plugins/cross-review
  run    = plugins/pair-review

Relative path:
skills/../../pair-review/skills/pair-review/SKILL.md

Fifteen wrappers tested: eight caught, seven missed.
Every missed form had scrubDir count 0 and runDirNamedIn result null.

Missed:
**skills/../../pair-review/skills/pair-review/SKILL.md**
*skills/../../pair-review/skills/pair-review/SKILL.md*
~~skills/../../pair-review/skills/pair-review/SKILL.md~~
>skills/../../pair-review/skills/pair-review/SKILL.md
|skills/../../pair-review/skills/pair-review/SKILL.md|
a|skills/../../pair-review/skills/pair-review/SKILL.md
**skills\..\..\pair-review\skills\pair-review\SKILL.md**

Plain, quoted, parenthesized, backticked and underscore-wrapped controls were caught.

plugins/pair-review/skills/pair-review/scripts/build-brief.mjs:250
The relative-token boundary excludes the missed wrapping characters.

exchange.mjs:229-235 and blind-relabel.mjs:3109-3112 use the same scrub/guard pair.
build-brief.mjs:284 applies that guard to packet and rules text.
```

### P4
Claim: P4
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Executed the shipped rewritePaths function on Windows with POSIX path keys.
No native Linux/macOS process run is claimed.

rewritePaths(text, [['/home/u/proj', '/srv/new']])

Actual results:
{"input":"see /home/u/proj/a.js","output":"see /srv/new/a.js"}
{"input":"see /mnt/backup/home/u/proj/a.js","output":"see /mnt/backup/srv/new/a.js"}
{"input":"see /data/home/u/proj/a.js","output":"see /data/srv/new/a.js"}
{"input":"see x/home/u/proj/a.js","output":"see x/srv/new/a.js"}
{"input":"see /container/root/home/u/proj/a.js","output":"see /container/root/srv/new/a.js"}

Ten POSIX-shaped inputs were executed: the direct path rewrote correctly;
nine longer paths also had their embedded suffix rewritten.

Two drive-rooted Windows controls remained unchanged.

plugins/pair-review/skills/pair-review/scripts/build-recheck-packet.mjs:323
The replacement expression has an end boundary but no start boundary.

Severity MEDIUM is supported for wrong paths published into the next packet.
The defect predates this round's end-boundary change.
```

### P5
Claim: P5
Action: DISPUTE
Counter-fact: On this host, the unset USER forms do not resolve to the existing folder. Actual shell checks fail for those paths. When USER is defined as the real username, all five tested USER forms resolve and the shipped guard catches them.
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
Executed shipped expandPathVars and runDirNamedIn against an existing repository
folder, plus actual PowerShell Test-Path checks.

Host:
{"USERNAME":"dev","USER":null}

Ten variable spellings tested:
$USER, ${USER}, $env:USER, ${env:USER}, %USER%
$USERNAME, ${USERNAME}, $env:USERNAME, ${env:USERNAME}, %USERNAME%

With the actual environment:
  Five USER forms: expanded path does not exist; guard false.
  Five USERNAME forms: expanded path exists; guard true.

Temporarily defining USER=USERNAME inside the test process:
  All five USER forms: expanded path exists; guard true.
The original environment was restored.

Actual PowerShell result:
{"UserEnvSet":false,"UserVariableSet":false,"UserNamePathExists":true,"UserEnvPathExists":false,"UserVariablePathExists":false,"LiteralPercentUserPathExists":false}

plugins/pair-review/skills/pair-review/scripts/path-utils.mjs:24-25
Unknown or empty variables are preserved rather than assigned an invented value.

The reported non-expansion is reproducible, but it does not establish a working
run-folder spelling bypass. USER and USERNAME are distinct environment variables.
Inferring USERNAME for an unset USER would change the path's meaning.

A reader guessing and substituting a username is an inference about interpreting
an incomplete path, not the demonstrated variable-expansion leak claimed here.
```

### P6
Claim: P6
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: DETERMINISTIC
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/build-brief.mjs:200
The delta brief permits:
  "this brief, your Phase 1 brief, the task packet, your own output and your scratch folder"

review-run.mjs:265
The resume message permits:
  "the delta brief, your Phase 1 brief, the task packet and your own scratch folder"

review-run.mjs:264
The Phase 1 message similarly omits its own findings file from the explicit read
list while instructing the reviewer to add findings to that file incrementally.

The same omission appears in:
plugins/pair-review/skills/pair-review/references/phase-2-cross-examination.md:274
plugins/pair-review/skills/pair-review/references/phase-2-cross-examination.md:288
plugins/cross-review/skills/cross-review/references/phase-2-cross-examination.md:436
plugins/cross-review/skills/cross-review/references/phase-2-cross-examination.md:450

Severity LOW is supported for the contradictory permission lists.
An actual reviewer stopping because of that contradiction was not reproduced.
```

web: 0 queries, 0 page fetches