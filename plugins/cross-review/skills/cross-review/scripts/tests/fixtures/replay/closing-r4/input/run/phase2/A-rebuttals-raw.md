### P1
Claim: P1
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
build-brief.mjs:249-250 (win32 branch of pathStartRe):
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\w:/\\.~-])(?:\\(?!\\)|\/(?!\/)|~[\\/]|\.{1,2}[\\/])/g
In "scripts/../../x", the first "/" follows "s" (\w), so it is excluded, and "scripts" itself is no path start.
So runDirNamedIn never resolves a directory-led relative path; only the exact-spelling check (mentionsDir)
could catch it, and a relative path never contains the absolute spelling.
```
The gap is real, and my own spelling matrix missed it (it had only "../" and "./"). I would correct the severity to MEDIUM. The preflight host check refuses a run folder inside the target, so a directory-led path from the target can reach the run folder only through ".." segments ("src/../../<runs>/..."). Seats rarely write that shape, and the peer test put the run folder next to the target's own folders, which a real run does not do.

### P2
Claim: P2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
My own Phase 1 matrix ran the shipped seatBlockedLine with "## **Checks performed**" (and an emoji-led
heading) after a "## No findings" section: the result was null, because the bold heading does not match
SEAT_SECTION_RE (review-run.mjs:773) and, being a level-two heading, ends the No findings section.
With "Blocked: none" written under "## No findings" first, as in the peer's fixture, the value stays ""
and review-run.mjs:852-855 lets the seat pass.
```
This is the same class as my claim about unread marker shapes after an earlier none: both need a seat that writes "Blocked: none" and then states a block. I would rate it MEDIUM, as I rated mine, because the trigger needs that self-contradiction. Impact alone would make it HIGH.

### P3
Claim: P3
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
My Phase 1 run of the shipped scrubDir + runDirNamedIn:
siblingParen scrub 0 guard BLOCK   (run(2))
siblingPlus  scrub 0 guard BLOCK   (run+1)
path-utils.mjs:104 lookahead (?![\p{L}\p{N}_+@(-]|\.[\p{L}\p{N}_]) has no space, so "run 2" is still
rewritten to "<run-dir> 2", which is the space sibling that the earlier finding named.
```
The +, @, (, é and 中 rows match my own claim about the scrub and the guard disagreeing. The quoted-space row and the recheck rewrite of Unicode dot-suffix siblings are additional. I did not run rewritePaths, so I accept that part on the peer's executed evidence. The quoted-space rewrite means the hypothesis about rewritten siblings is partly confirmed, not refuted as I wrote. Severity: MEDIUM is fair for the recheck packet rewriting another folder's path. The scrub and guard part alone is LOW: it errs safe and only stops the hand-off.

### P4
Claim: P4
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
My Phase 1 run of the shipped initBody (build-manifest.mjs:254-258):
cutAfterClaimHeading completed []
cutMidEvidence       completed []
fencedOnly           completed []
noFindingsYet        completed []
lowerClaim           completed []
```
This is the same defect as my claim about the seat-file gate, reproduced independently. MEDIUM is right.

### P5
Claim: P5
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
review-run.mjs:265 (PROMPTS.phase2): "... Write your rebuttal entries to ${output} in one write at the end.
Do not read any other file in the run folder. Do not edit any other file. ..."
build-brief.mjs:200 (delta brief): "Read nothing in the review's run folder except this brief, your Phase 1
brief, the task packet, your own output and your scratch folder"
```
The native resume message still has the narrow rule that the delta-brief fix widened. The earlier Phase 2 hypothesis is therefore partly confirmed for native seats, not refuted as I wrote. LOW is right.

### P6
Claim: P6
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
preflight.mjs:550-562 stopOnSignal: the handler calls killTree(child, { waitForGroup: true }) with no
exited-child check.
cross-review opencode-dispatch.mjs:73-86 installSignalForwarding: killTreeFn(child, ...) with no exited check,
unlike claude-dispatch.mjs:217 and codex-dispatch.mjs:81 (hasExited guard added this round).
spawn-utils.mjs:184-192: on win32, killTree runs taskkill /pid <pid> /T /F on the stored pid.
```
These sibling paths miss the guard this round added to the two other dispatchers. My Phase 1 sweep stopped at those two dispatchers. I keep the peer's HIGH for impact (a signal sent to an unrelated, reused pid). The trigger needs a stop signal in the window after exit while the output is still open, plus a pid reuse, and the reuse was not exercised. Rare in practice.

### P7
Claim: P7
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
My Phase 1 run of the shipped agentLastReply (native-agent.mjs:116-140):
claudeNoTextLast   state done reply "3 claims: 1 HIGH, 2 LOW. written"
claudeThinkingOnly state done reply "3 claims: 1 HIGH, 2 LOW. written"
claudeEmptyText    state done reply "3 claims: 1 HIGH, 2 LOW. written"
```
This is the same defect as my claim about the final-reply check, reproduced independently. LOW is right.

web: 0 queries, 0 page fetches
