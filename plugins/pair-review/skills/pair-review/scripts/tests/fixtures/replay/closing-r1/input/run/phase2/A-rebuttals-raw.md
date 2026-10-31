### P1
Claim: P1
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
node --input-type=module -e "... seatBlockedLine('## No findings\n\n    Blocked: none\n') ... seatBlockedLine('## No findings\n\n\tBlocked: none\n')"
"" ""
review-run.mjs:769  const m = /^(?:- )?Blocked: (\S.*)$/.exec(l.text.trim());   -- trim() removes the indentation of an indented code block
```
Reproduced: an indented `Blocked: none` is read as none. Corrected severity: LOW. The text the reader accepts still says "none", so the seat itself declared no block; this is a shape the brief forbids being accepted, not a declared block being lost (unlike a block line followed by a none line). It does not by itself turn a blocked seat into a clean one.

### P2
Claim: P2
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
review-run.mjs:411-413
  // A seat is never time-limited unless run.json flags.timeoutS says so (0 or absent: no limit) ...
  return ['--timeout', String(desc.flags.timeoutS ?? 0)];
```
Agreed, and this makes the same defect I reported for the Codex runner worse: on the review-run route the default is no limit, so a CLI process that hangs after its final answer is never stopped, and --wait keeps exiting 3. I reproduced the runner side with a fake CLI that printed its answer and turn.completed and then slept: it was held until --timeout and recorded as timed-out. HIGH holds for the sequencer route.

### P3
Claim: P3
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
preflight.mjs:431-433
  const item = expandPathVars(decodeFileUrls(word));
  if (!PACKET_PATH_START_RE.test(item) || (quoted && /\s--?[A-Za-z]/.test(item))) return false;
path-utils.mjs:31-33  decodeFileUrls: .replace(/(?:%[0-9A-Fa-f]{2})+/g, ... decodeURIComponent ...) over the whole text, not only after file://
```
A backticked path with a folder named like " -final" matches the option test before stat() and is read word by word; a literal "%20" in a backticked path is decoded on every item. LOW is right: advisory warnings only.

### P4
Claim: P4
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
preflight.mjs:1504  PACKET_URL_PORT_RE  ...:(\d{2,5})\b
preflight.mjs:1506  PACKET_BARE_PORT_RE ...:(\d{2,5})\b
```
Ports 1 to 9 are never extracted. LOW is right (advisory reach probe only, and such ports are rare in packets).

### P5
Claim: P5
Action: CONCEDE
Basis: STATIC_TRACE
Evidence strength: DETERMINISTIC
Evidence:
```
cross-review SKILL.md:20-23  "seat B runs through Codex CLI or OpenCode's configured provider bridge, never as a Claude
  reviewer — no other layout has a defined dispatch path, and `review-config.mjs` enforces this."
cross-review review-config.mjs:189  transport: seat.runtime === nativeRuntime ? (transport ?? 'native') : 'cli',
  with nativeRuntime = NATIVE_RUNTIME_OF_HOST[host]; on the codex host a codex seat B gets transport 'native'.
```
The entry page says seat B is always a CLI or bridge seat, while the config script makes a seat B whose runtime matches the host native by default. MEDIUM holds as a doc that leads to a wrong step.

web: 0 queries, 0 page fetches
