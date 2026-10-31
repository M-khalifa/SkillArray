# Seat A findings

## A1 — blocked line: reader misses a block written as a bold label, italic label, numbered item, upper case or with no space, so a blocked No findings seat with a strict "blocked line: none" passes phase1 --wait as clean
Severity: HIGH
Basis: EXECUTED
Evidence strength: REPRODUCED
Trigger: the exit-0 clean pass needs a No findings seat that writes both the strict closing "blocked line: none" and a block line; the more likely hit is a claims seat whose only block line is in one of these shapes (no report caveat). Shapes: a seat that writes its block in a common Markdown label shape ("**blocked line**: x", "- **blocked line**: x", "*blocked line:* x", "_blocked line:_ x", "1. blocked line: x", "blocked line: x", "blocked line:x") anywhere in Checks performed / No findings, plus the strict closing "blocked line: none". Uncommon, but bold labels ("**Label**: value") are the usual model style in a Checks performed list. Holds everywhere (pure string code).
Evidence:
```
review-run.mjs:770-771 (both skills, all four installed copies identical):
  const strict = /^(?:- )?Blocked: (\S.*)$/.exec(text);
  const m = strict ?? /^[\s>*+-]*(?:\*\*|__)?Blocked:(?:\*\*|__)?\s+(\S.*)$/.exec(text);
The loose pattern needs the colon directly after "Blocked" (or after a closing **/__), at least one space after it,
exact case, and no digit list marker.

node bl.mjs (scratch harness importing the shipped seatBlockedLine), text = "## No findings\n\nBlocked: none\n<line>":
"" <= ["Blocked: none","**Blocked**: rg missing"]
"" <= ["Blocked: none","- **Blocked**: rg missing"]
"" <= ["Blocked: none","*Blocked:* rg missing"]
"" <= ["Blocked: none","_Blocked:_ rg missing"]
"" <= ["Blocked: none","1. Blocked: rg missing"]
"" <= ["Blocked: none","BLOCKED: rg missing"]
"" <= ["Blocked: none","Blocked:rg missing"]
"rg missing" <= ["Blocked: none","Blocked: rg missing"]   (control)

Caller review-run.mjs:816-822: declared === '' on a noFindingsOnly seat skips both StepErrors, so phase1 --wait
exits 0 with no caveat. For a claims seat whose only block line is "**Blocked**: x", declared is null: --wait prints
the "wrote no Blocked: line" warning, but nothing goes to seat-warnings-phase1.json, so build-manifest / build-report
carry no blind caveat.
review-protocol.md "All seats" promises: "a block counts in any shape".
```
Suggested fix: review-run.mjs:771 make the loose pattern case-insensitive and allow a numbered marker and emphasis around the label with an optional space: /^[\s>*+\-\d.)]*(?:\*{1,2}|_{1,2})?Blocked(?:\*{1,2}|_{1,2})?\s*:(?:\*{1,2}|_{1,2})?\s*(\S.*)$/i, then add these shapes to the round 6 test in review-run.test.mjs.
Same shape elsewhere: heading variants also drop the line, because own is set only by an exact "## Checks performed" / "## No findings" heading (review-run.mjs:767): "## Checks performed:" or "## Checks Performed (partial)" followed by "blocked line: rg missing" also read as "" after an earlier strict none (reproduced in the same harness). No other blocked line: reader found (searched scripts/*.mjs for "Blocked").

## A2 [AC-1] — review-run never shows the dispatchers' stopIncomplete / stoppedAfterAnswer WARNING, so on the default route nobody is told a seat process may still be running
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Trigger: a CLI seat (claude or codex) that answers and leaves a process outside its tree holding stdout open (the stopIncomplete case the Known deviations accept "because the run says so"); or any seat stopped after its answer. Holds everywhere; the leaked-process case is the Windows one the deviation names.
The orchestrator on the review-run route reads only review-run's lines, so the "check the process list" warning, which is the whole remedy the Known deviation relies on ("the run says so with stopIncomplete and a WARNING"), never reaches anyone, and the report has no caveat either.
Evidence:
```
grep -rn "stoppedAfterAnswer|stopIncomplete" over the pair-review skill (scripts, SKILL.md, references), tests excluded:
  only claude-dispatch.mjs (lines 61, 228, 275, 285, 300, 482-487), codex-dispatch.mjs (135, 660-777, 1226-1231)
  and CHANGELOG.md:19. No reader in review-run.mjs, build-manifest.mjs, build-report.mjs, SKILL.md or references/.

claude-dispatch.mjs:488 / codex-dispatch.mjs:1232 write the warnings with log(), i.e. to the dispatcher's
stderr (result.stderr.log on the review-run route) and set the flag in result.json.

review-run.mjs:636-637 (waitSeats, after a CLI seat finishes):
  const note = await checkTouched(`seat ${role}`, resultFile(desc, phase, role));
  report.lines.push(`seat ${role}: completed (cli ${actor.runtime})${note ? `; ${note}` : ''}`);
review-run.mjs:813-826 (assertSeatsRan) reads that stderr log only for exec_command failure lines (SEAT_EXEC_FAILED_RE).
```
Suggested fix: review-run.mjs:636 read the record (readResult) and append "; stopped 30 s after its answer" and, when record.stopIncomplete, push a "warning: seat X's process may still be running (stopIncomplete); check the process list" line.
Same shape elsewhere: the same waitSeats path serves phase2 resumes and the CLI auditor through the same dispatchers (review-run.mjs waitCli callers); cross-review copies identical. opencode-dispatch.mjs has no after-answer stop (accepted deviation), so not affected.

## A3 [AC-8] — packet path scan: the H5 split covers "=", "," and "|" but not the sibling joiners ";", "&" and "<br>" (one false missing path, both real paths lost), and still loses paths in smart quotes, "~~", "--opt:path" and before "!"
Severity: LOW
Basis: EXECUTED
Evidence strength: REPRODUCED
Each feeds the Phase 1 "packet names N path(s) that do not exist" / "outside the target" warnings and the reach probe (review-run.mjs:714-718). Windows-specific only in that the test paths use drive letters; the trim and split code holds everywhere.
Evidence:
```
pr.mjs (scratch harness calling the shipped packetReach from preflight.mjs; b.log and c.md exist under <S>\x;
paths under the run folder land in otherRuns, which is "found"). Text = "Evidence: <shape>":
"<S>\x\b.log;<S>\x\c.md"     other []          notFound ["<S>\x\b.log;<S>\x\c.md"]
"<S>\x\b.log&<S>\x\c.md"     other []          notFound ["<S>\x\b.log&<S>\x\c.md"]
"<S>\x\b.log<br><S>\x\c.md"  other []          notFound ["<S>\x\b.log<br><S>\x\c.md"]
"“<S>\x\b.log”"              other []          notFound []
"~~<S>\x\b.log~~"            other []          notFound []
"--log:<S>\x\b.log"          other []          notFound []
"<S>\x\b.log!"               other []          notFound []
controls found: "*..*", "...:12", "[..](..)", "<..>", "'..',", "(see ...)."

preflight.mjs:1449  const parts = word.split(/\]\(|[=,|]/)...
preflight.mjs:1426/1423 trim sets: /^["'(<\[*|]+/ and /["'.,;:)\]>*|]+$/ (no “ ” ~ !)
```
Suggested fix: preflight.mjs:1449 split on /\]\(|<br\s*\/?>|[=,;&|]/i, and add “”‘’~! to the start/end trim classes at 1426/1423.
Same shape elsewhere: none found (searched preflight.mjs for other word-splitting of packet text; packetPorts is a separate regex).

## A4 [AC-5] — Manual route: the Completion gate says the report "must say" a seat with claims may have reviewed blind, but the only source of that caveat is seat-warnings-phase1.json, which only review-run writes and no doc names
Severity: MEDIUM
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Trigger: an orchestrator on the documented manual route (no review-run sequencer) with a seat that has claims and a "blocked line: <x>" line. Holds everywhere.
On the manual route the orchestrator is told the report must carry the caveat, is told to paste build-report output verbatim, and has no documented step that makes build-report carry it, so the published report shows the blocked seat as a full review. This is the claims-seat half of the hypothesis about the manual completion gate; the No findings half is fixed by the new text.
Evidence:
```
references/phase-1-independent-passes.md:241-243 (both skills):
  "Read each seat's `Blocked:` line yourself (`validate` does not): ... A seat with claims and a block keeps its
   claims, and the report must say it may have reviewed blind."
SKILL.md:50 (pair-review): build-report ... "paste the output verbatim as your reply, never retype it"
build-manifest.mjs:253-254:
  // review-run phase1 --wait records seats whose own lines say a read or command was blocked.
  const blind = (await readJsonOrAbsent(path.join(runDir, 'seat-warnings-phase1.json')))?.blind;
build-report.mjs:744-746: the "Seat X may have reviewed blind" caveat comes only from m.seat_blind_lines.
grep -rn "seat-warnings" SKILL.md references/ scripts/*.mjs: only build-manifest.mjs:254 and review-run.mjs:840.
```
Suggested fix: phase-1-independent-passes.md:243 add the step: write `<run-dir>/seat-warnings-phase1.json` as {"blind": {"<seat>": ["blocked line: <its line>"]}} before build-manifest (or have blind-relabel validate write it when it reads the line).
Same shape elsewhere: SKILL.md step 3 of Review phases in both skills (pair-review SKILL.md:185, cross-review SKILL.md:231) names only the No findings case and does not mention claims seats at all.

## A5 [AC-2] — The default seat and auditor transport is native, so on the default route whatever the host loads (which SKILL.md itself says includes the user's memory) still reaches seat and auditor; the fix only documents it and tells them to ignore it
Severity: MEDIUM
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Trigger: every run whose seat or auditor runtime matches the host (review-config default) on a host that loads the user's global instructions and memory into sub-agents, which the new SKILL.md text itself says happens. Holds everywhere.
AC-2 asks that no seat or auditor "is told ... a vendor or model name, before the protocol allows it", and the protocol hands earlier verdicts to seats only as hypotheses. The change turns the earlier false claim into a true one, but the leak it described stays on the default path, protected only by an instruction to ignore what was read; it is not under Known deviations. Inference: an instruction cannot undo anchoring on an earlier verdict.
Evidence:
```
review-config.mjs:189 (both skills):
    transport: seat.runtime === nativeRuntime ? (transport ?? 'native') : 'cli',
review-config.mjs:178: "The auditor repeats seat A unless --auditor names another model"
SKILL.md:53 (pair-review), also cross-review SKILL.md:54 and task-packet-template.md:13-15:
  "A native seat or auditor (started with the host's agent tool) also gets whatever the host loads into every
   agent, such as the user's global instructions and memory: its brief tells it to treat that as unchecked
   context, never as evidence. Use CLI seats when that matters."
```
Suggested fix: either list it under Known deviations as an accepted cost of native seats, or have `review-config seats` print a one-line warning when a native seat or auditor is chosen and the host is known to load user memory (Use --transport cli to avoid it).
Same shape elsewhere: native auditor route (review-protocol.md "Fresh-context auditor", lines 810-814) gets the same context; same text in both skills.

## Checks performed

- H1: ran shipped seatBlockedLine on "    blocked line: none", "\tblocked line: none", "  - blocked line: none", "> blocked line: none", a "~~~" fence and an indented "```" fence holding "blocked line: none": all return null (no line). Round 6 test in review-run.test.mjs passes (1/1). REFUTED
- H2: "blocked line: x" then "blocked line: none" returns "x" in both orders and across both sections; but a block written as "**blocked line**: x", "*blocked line:* x", "1. blocked line: x", "blocked line: x" or "blocked line:x" after a strict none reads as none (claim about the bold-label shapes). PARTLY CONFIRMED
- H3: claude-dispatch test "a CLI still running after a successful answer..." run alone: pass (54 s), node process count 1 before and 1 after. codex runCodex traced (lines 709-777) and its test is in cross-review dispatch-integration.test.mjs:941-975 (not run). Defect gone in the dispatchers; their WARNING is not shown by review-run (claim about the stopIncomplete warning). REFUTED
- H4: packetReach on a backticked existing path with a "my -y dir" folder and a literal "100%20done.txt" (author test, read) and decodeFileUrls test read; my own run of the closing-round preflight-host test failed only because my scratch temp folder sits inside a run folder (paths land in otherRuns), not a defect. REFUTED
- H5: harness: bold, table bar, Markdown link, "(..)", "<..>", quotes, ":12" found; ";", "&", "<br>" joiners, smart quotes, "~~", "--opt:path" and "path!" still lost or false missing (claim about the path scan joiners). PARTLY CONFIRMED
- H6: packetPorts returns "host:7", "localhost:8", "[::1]:3"; "localhost:0" and ":99999" dropped. REFUTED
- H7: cross-review SKILL.md:20-22 now says seat B runs through Codex, the CLI on Claude Code or a native Codex agent on a Codex host. REFUTED
- H8: both SKILL.md step 3 and phase-1-independent-passes.md Completion gate now tell the orchestrator to read the blocked line: line; the claims-seat caveat has no manual-route mechanism (claim about the manual Completion gate). PARTLY CONFIRMED
- H9: SKILL.md, task-packet-template.md and review-protocol.md now say native seats and the auditor get host-loaded context; the sentence is no longer false. The leak itself stays on the default route (claim about native transport and AC-2). REFUTED
- AC-1: dispatcher stopIncomplete/stoppedAfterAnswer warnings never reach review-run output (claim about the stopIncomplete warning); blocked line: misread (claim about the bold-label shapes). NOT MET
- AC-2: native default transport leaks host memory to seats and auditor (claim about native transport). PARTIAL
- AC-3: the only number the diff adds to printed output is the grace seconds in the dispatcher warning, answerGraceMs()/1000 by construction; the claims and web counts used by the warnings were not recounted this round. MET
- AC-4: after-answer stop test leaves no node process (count 1 before and after); stopIncomplete case is the accepted Windows deviation; its only gap, that the warning is not surfaced, is claimed under AC-1 (claim about the stopIncomplete warning). MET
- AC-5: dispatcher --help text matches answerGraceMs (30 s default, REVIEW_ANSWER_GRACE_MS); review-protocol "a block counts in any shape" does not hold for bold-label shapes (claim about the bold-label shapes); manual-route caveat instruction has no mechanism (claim about the manual Completion gate). NOT MET
- AC-6: no change to manifest or seat-warnings format in the diff; older seat files with a single strict blocked line: line read as before (round 6 test). MET
- AC-7: no removable code found in the diff. MET
- AC-8: spot-checked on current code: linux-2 F1 (existing path then "Reporter/Reporter.py") found; linux-1 F6 / linux-2 F5 (main.tf:40, a.proto:12 not taken as ports, https endpoint kept); mac-1 round4-F7 (native "blocked line:" reply now a StepError, review-run.mjs:232); mac-2 F1 and F2 (build-recheck-packet.mjs:514, 528 refuse); linux-1 F4 (~/ and path:40 forms found). Other feedback items not re-run. The path-scan feedback leaves sibling joiners open (claim about the path scan joiners). PARTIAL
- AC-9: seatBlockedLine: old trim accepted an indented "blocked line: none" as none, now null by design; old last-line-wins now first-block-wins by design; no input found that the old reader read as a block and the new reads as none. decodeFileUrls: old decoded %XX in plain paths, so a bare "C:\x\a%20b.log" naming "a b.log" was found and is now a false missing path; that is the intended change (a literal %20 name is the case it fixes), and build-brief keeps the decoded view so the run-folder guard loses nothing (author test, read). trimEnd now strips "*" and "|": a glob "C:\x\*" now resolves to the existing folder "C:\x\" (harmless). MET
- AC-10: codex after-answer stop tested only in cross-review's dispatch-integration test (shared script, acceptable); no test for the bold-label blocked line: shapes (they are broken) or for review-run showing stopIncomplete; covered by the claim about the bold-label shapes and the claim about the stopIncomplete warning. PARTIAL
- Installed copies: diff -rq of both skills against both installed locations: no difference. Shared scripts in both skills: cmp equal.
- Coverage: read fully: since.diff, seatBlockedLine and assertSeatsRan, runClaude, the codex after-answer hunk, packetPaths helpers; read partly: review-run.mjs waitSeats, build-manifest.mjs, build-report.mjs, review-config.mjs, build-recheck-packet.mjs, the four feedback files (summaries and selected findings); not read: exchange.mjs, blind-relabel.mjs, detach-utils.mjs, opencode-dispatch.mjs, bench/, release-check/install-check/validate-repository.
- Full suite not run (packet asks for single files); preflight-host closing-round test not usable with my temp folder inside a run folder.
Blocked: none

web: 0 queries, 0 page fetches
