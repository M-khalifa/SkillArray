### P1
Claim: P1
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
node, shipped seatBlockedLine, text "## No findings / Blocked: none / ## Checks performed / <prefix>Blocked: reader denied",
compared with the LOOSE_BLOCKED_RE line removed in since.diff (old regex applied to the same line):
"1. 2. "   new: ""               old regex reads line: true
"1) 2) "   new: ""               old regex reads line: true
"(1) (2) " new: ""               old regex reads line: true
"1. "      new: "reader denied"  old regex reads line: true
"a. b. "   new: ""               old regex reads line: false
"1. a. "   new: ""               old regex reads line: false
```
Reproduced, and it is a real AC-9 regression: the old pattern took any run of numeric labels (`\d+[.)]`, `\(\d+\)` repeated inside the `*` group), the new one takes only one label. My own Phase 1 matrix also found the nested `1. a)` shape unread, but I filed it under the known LOW "contradicts itself" deviation. The numeric-repeat shapes are different: the old line handled them, so the deviation does not cover them. Corrected severity: MEDIUM, not HIGH. The input (a strict "Blocked: none" followed by a block behind two stacked list numbers) is unusual, and the known deviation rates the wider class of unread block forms LOW.

### P2
Claim: P2
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
Phase 1 scratch harness: shipped runDirNamedIn(text, <tmp>/reviews/run1, <tmp>/proj)
MISSED   ">docs/../../reviews/run1/phase1/B-findings.md"
caught   "see docs/../../reviews/run1/phase1/B-findings.md"
build-brief.mjs:250  look-behind set (?<=^|[\s"'`(\[<=,;]) has no ">"
```
I reproduced the same miss independently, together with bold, italic, strike and `|` wrappings, in my own Phase 1 claim about the relative-up guard. Same cause, same one-line fix: add the missing characters to the look-behind. Severity: I rated the class MEDIUM, in line with the original finding F8 and because the trigger is uncommon. HIGH is defensible under the packet's "blinding leak" rule.

### P3
Claim: P3
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
node, shipped initBody; seat A healthy, seat B file as below, phase3/findings.json present
"# Seat B findings\n\n## Checks performed\n"                    -> completed []
"# Seat B findings\n\n## Checks performed\n- reading started"   -> completed []
"# Seat B findings\n\n## Checks performed\nBlocked: none\n"      -> completed []
old gate (since.diff): /^##\s+(?:[A-Z]\d+\b|No findings)/im  -- rejects all three (no claim heading, no No findings)
```
Reproduced: a file that holds only the section heading now counts, where the old gate refused it. This is the opposite edge of my own Phase 1 claim about the same gate (which rejects complete seats with a variant heading). Both point to the same fix: reuse the structural check (claim heading or No findings, plus the section). MEDIUM stands. Reaching the manifest needs the run to pass phase1 --wait validation, or the manifest to be built by hand, which the peer's own validator column shows is refused.

### P4
Claim: P4
Action: CONCEDE
Basis: EXECUTED
Evidence strength: REPRODUCED
Evidence:
```
Phase 1 repro, shipped pair-review codex-dispatch.mjs, fake codex that exits at once with no answer
while a detached child holds stdout, --timeout 3:
  relay: codex exec killed after exceeding --timeout 3s
  status=timed-out stopIncomplete=undefined; stderr WARNING lines: (none)
  orphan pid alive after dispatcher returned: true
Same fake, --timeout 0: WARNING ... output stayed open; status=error stopIncomplete=true
```
Same defect as my own Phase 1 claim about the finite-timeout window, with executed evidence for the codex branch; the claude branch is the same code. MEDIUM is right.

web: 0 queries, 0 page fetches
