### P1
Claim: P1
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/build-manifest.mjs:255-257

Independently called shipped initBody with in-memory filesystem fixtures,
then checked the same seat texts with shipped validateProblems.

Eleven shapes tested. Results included:
claim-heading       status=completed, valid=false
partial-fields      status=completed, valid=false
quoted-heading      status=completed, valid=false
quoted-no-findings  status=completed, valid=false
wrong-role          status=completed, valid=false
no-findings-prefix  status=completed, valid=false

Empty and header-only files correctly became incomplete.
build-report.mjs:727,734 propagates the manifest status and reviewer count.

MEDIUM confirmed. Requiring a closing heading alone would remain insufficient:
that heading can itself occur inside a fence or precede another truncation.
Existing schema validation should decide completeness.
```

### P2
Claim: P2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: SUPPORTED
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/claude-dispatch.mjs:225-332,508-532

Executed the shipped runner body in memory, adding only an export for access.
Injected child streams and process spawning; no real orphan was started.
Ten event shapes were tested with zero and finite timeouts.

After child exit with output still open:
no-result, error, rate-limit, empty/blank/missing/non-string success text,
wrong subtype and errored text:
  timeout=0:    unresolved throughout observation
  finite:       timedOut=true, stoppedAfterAnswer=false,
                stopIncomplete absent, killRequests=0

Successful-answer control:
  code=0, stoppedAfterAnswer=true, stopIncomplete=true

Unresolved cases were released by explicitly emitting close; all streams
were destroyed afterward.

Without a successful answer, there is no exit-triggered drain deadline.
The finite-timeout branch resolves without a kill, while line 532 still
describes the process as killed. Warning propagation at lines 508-519 requires
stoppedAfterAnswer, so it does not cover these cases.

MEDIUM supported. The physical orphan reproduction was not independently repeated.
```

### P3
Claim: P3
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/path-utils.mjs:18-25
plugins/pair-review/skills/pair-review/scripts/build-brief.mjs:257-277

Independently tested twelve path forms using shipped scrubDir followed by
runDirNamedIn. A protected existing directory under the actual home folder
was used as the synthetic run directory.

percent-username: scrub=0, guard=false
env-username:     scrub=0, guard=false
braced-username:  scrub=0, guard=false
ellipsis:        scrub=0, guard=false
Unicode ellipsis:scrub=0, guard=false
user placeholder:scrub=0, guard=false
relative tail:   scrub=0, guard=false
forward tail:    scrub=0, guard=false

Absolute control was rewritten; profile-variable, tilde and explicit
dot-relative controls were blocked.

USERNAME_ALIAS:
environmentMatchesHome=true
expandedPathExists=true

Corrected severity: HIGH for the resolvable username-variable bypass under
the packet's blinding rubric. Ellipses and placeholders alone do not prove
a directly readable alias.

The suggested blanket suffix match needs care: short suffixes can also name
unrelated target paths. Username-variable handling has concrete independent evidence.
```

### P4
Claim: P4
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/path-utils.mjs:101-105
plugins/pair-review/skills/pair-review/scripts/build-brief.mjs:231-238

Independently tested twelve quoted sibling-name shapes through the shipped
scrubber and guard.

Suffix       replacements   guard
2            0              pass
-evidence    0              pass
.bak         0              pass
Ac           0              pass
+1           0              block
@x           0              block
(2)          0              block
é            0              block
中           0              block

The continuation sets disagree exactly as described. Both exchange.mjs:235
and blind-relabel.mjs:3112 consume the guard result.

Corrected severity: MEDIUM for rejecting legitimate sibling evidence and
stopping the hand-off; this is an operational refusal, not an advisory warning.
Blocking an actual run path glued to CJK prose is appropriately conservative,
although the preceding redaction should have handled it.

The broader hypothesis is not wholly refuted: a quoted space-continued sibling
still produced replacements=1 in the independent matrix.
```

### P5
Claim: P5
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
plugins/pair-review/skills/pair-review/references/task-packet-template.md:31-32
plugins/pair-review/skills/pair-review/scripts/preflight.mjs:1816-1820

Extracted the template's first fenced Markdown block and passed it directly
to shipped peerLabelLines.

TEMPLATE: 56 lines, 2 warning lines

Both hits were the template's own acceptance-criteria guidance paragraphs:
the example claim heading and the paragraph listing prohibited label forms.

Template line 32 still describes preflight as warning about the peer-letter
pattern only, while the helper now recognizes seat and audit patterns too.

LOW confirmed: unnecessary advisory warnings and stale documentation.
```

### P6
Claim: P6
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/review-run.mjs:774-798,851-855

Independently called shipped seatBlockedLine with an earlier clean declaration
and each of twelve subsequent line shapes.

Returned "":
a) Blocked: npm test: EACCES
ii. Blocked: npm test: EACCES
1 - Blocked: npm test: EACCES
: Blocked: npm test: EACCES
— Blocked: npm test: EACCES
Blocked：npm test: EACCES

Returned the actual block:
heading, task box, bullet dot, parenthesized number, table row and numeric-list
controls using the ASCII colon.

The completion gate rejects null or nonempty declarations for a no-findings
seat, but accepts the empty string returned by these missed variants.

Corrected severity: HIGH for the ASCII-label variants that report a blocked
reviewer as clean. Full-width colon support is an additional normalization
question; it is not needed to establish the other misses.
```

### P7
Claim: P7
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```text
plugins/pair-review/skills/pair-review/scripts/native-agent.mjs:125-135
plugins/pair-review/skills/pair-review/scripts/review-run.mjs:241-243,682,1365

Independently tested eleven in-memory transcript shapes using shipped
agentState and agentLastReply.

After an earlier "written" and a genuine new user prompt:
empty final content:     state=done, reply="written"
empty final text:        state=done, reply="written"
whitespace final text:   state=done, reply="written"
empty hand-back message: state=done, reply="written"
missing hand-back text:  state=done, reply="written"

Explicit new replies and explicit block replies were read correctly.
The task-event no-message control returned null.

The assistant-message path never clears the earlier reply on a new prompt.
Consequently the downstream missing-reply warning sees "written" and stays silent.

LOW confirmed under the packet's warning rubric.
```

web: 0 queries, 0 page fetches