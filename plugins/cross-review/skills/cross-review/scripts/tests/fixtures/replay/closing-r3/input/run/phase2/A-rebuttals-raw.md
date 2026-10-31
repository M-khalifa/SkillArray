### P1
Claim: P1
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
My own run of the shipped scrubDir on the run folder C:\Users\<user>\cross-review-runs\closing-r3\run:
0 "C:/Users/<user>/cross-review-runs/closing-r3/./run/x"            (dot segment, not rewritten)
0 "file:///C:/Users/<user>/cross-review-runs/closing-r3%2Frun/x"    (encoded, not rewritten)
0 "C%3A%5CUsers%5C...%5Crun"                                        (percent-encoded, not rewritten)
Then the shipped scan, run the way exchange prepare runs it, passed them: "scan exit 0 scan clean".
path-utils.mjs scrubDir builds its alternatives from pathSpellingsOf(dir) only; it never decodes or normalizes.
```
The same root cause as my own claim about the `<run-dir>` rewrite, which also lists the home-relative, variable, drive-less, 8.3 and line-wrapped spellings. HIGH stands.

### P2
Claim: P2
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
review-run.mjs:770-789 seatBlockedLine: a strict "Blocked: none" sets value to ''; a later line is read only by
  /^[\s>+\-\d.)]*blocked\s*:\s*(.*)$/i after * _ and backticks are removed, so "- [ ] Blocked: x" and
  "### Blocked: x" do not match and '' stays.
My run of the shipped function, with no earlier "none" line: "[x] Blocked: x" => null, "### Blocked: shell: EPERM" => null.
review-run.mjs:841-847: declared === '' with "No findings" passes the gate (only null and a non-empty value stop it).
```
With an earlier "Blocked: none" the missed block turns from a refusal ("no Blocked: line") into a clean pass: a blocked seat reported as clean, so HIGH is right. My own claim about the `Blocked:` reader covers the same missed shapes and the same fix.

### P3
Claim: P3
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
native-agent.mjs:94-99 codexState: the last task_complete gives 'done' whatever its message.
native-agent.mjs:127 agentLastReply: task_started resets reply to null; a task_complete with no string message keeps null.
review-run.mjs:233-242 checkFinalReply: refuses 'aborted' and a "blocked:" reply, warns on a reply that is not
  "written", and does nothing when reply is null.
```
The trace is right, but the severity should be LOW, not HIGH. The file still has to pass the claim-heading check (review-run.mjs:666-672) and later validate. A reply that is present but is not "written" only gets a warning (review-run.mjs:241). So a missing reply is at worst a missing warning, not a blocked or blind seat reported as clean. It also behaves as before this round: the earlier turn's "written" was read then. Corrected severity: LOW.

### P4
Claim: P4
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
build-manifest.mjs:254 checks only that the file is there:
  if (!(await stat(path.join(runDir, 'phase1', `${role}-findings.md`)).catch(() => null))) missingSeatFiles.push(role);
My run of the shipped "blind-relabel.mjs validate --phase1-dir" with an empty B-findings.md:
  "B-findings.md: has zero recognized claim headings and no "## No findings" marker ..." exit 1
```
The gate checks only that the file exists, so the claim holds. The severity should be MEDIUM, not HIGH. On the supported route, audit-prep validates both seat files before findings.json can exist, and validate refuses an empty or headerless file (output above). Reaching COMPLETE needs a seat file emptied or cut short after the audit, followed by a manifest rebuild. The wrong status is real but needs that later damage. Corrected severity: MEDIUM.

### P5
Claim: P5
Action: CONCEDE
Basis: SOURCE_CITATION
Evidence strength: SUPPORTED
Evidence:
```
path-utils.mjs:100 end boundary (?![A-Za-z0-9_-]|\.[A-Za-z0-9_]): a space, comma, "+", "@", "(" or a
  non-ASCII letter after the folder name counts as the end of the run-folder path.
build-brief.test.mjs:285 (title): "any "<run-dir> ..." continued by a space is refused (even an existing
  "<run-dir> 2", which could be a link or walk back with "..")": the run-folder guard deliberately treats a
  space continuation as the run folder.
Known deviations: "a bare (unquoted) path with a space is read up to the space".
```
The rewrite changes those sibling names. The space case, though, matches the guard's own decided rule that a space after the folder name counts as the run folder, so it fails safe. The damage is to how a peer view reads, never to a file or claim block. The real defects are the non-ASCII-letter, "+", "@" and "(" suffixes, which are rare folder names. Corrected severity: LOW.

### P6
Claim: P6
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
claude-dispatch.mjs:251-262: if (options.timeout) timer = setTimeout(() => { stream.timedOut = true;
  killing = killTree(child, { waitForGroup: true }) ... }) with no child.exitCode / signalCode check;
  only the answer-grace callback (claude-dispatch.mjs:280) has that check.
review-run.mjs:417: "A seat is never time-limited unless run.json flags.timeoutS says so (0 or absent: no limit)".
```
Confirmed by reading the code. The trigger is narrow: a finite timeout (not the review-run default) that runs out within the 30 s after an answer, while the CLI has already exited with its output still open. MEDIUM stands. On Windows the pid passed to taskkill at that point may already belong to another process, so the narrow case can also hit an unrelated process.

### P7
Claim: P7
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
My run of the shipped peerLabelLines: tags of the X, Y, A or B letter followed by a digit => warns: false;
the P letter followed by a digit => warns: true; "H1", "AC-2" and a declared checklist => warns: false.
Shipped audit-prep: a seat-letter tag in inline code => exit 1; in prose => exit 0 with the tag rewritten into
the audit label of that seat's claim.
```
This is the same defect as my own claim about the packet-label warning. I would rate it MEDIUM, not LOW: a tag quoted in prose is renamed into a real audit label with no stop, so the auditor reads a wrong reference without any warning. Corrected severity: MEDIUM.

### P8
Claim: P8
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
My run of the shipped pathStartRe: linux "//root/x" => 0://, linux "///root/x" => no start;
darwin the same. build-brief.mjs:250 and preflight.mjs:1434 both use \/{1,2}(?!\/).
```
This is the same defect as my own claim about three leading slashes. It applies only on Linux and macOS, needs a link into the run folder written with three or more slashes, and was not run end to end on a POSIX host. Corrected severity: LOW.

web: 0 queries, 0 page fetches
