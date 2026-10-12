# Task packet template

Copy this into `<run-dir>/task-packet.md` and fill every slot; delete a slot only when it truly does not apply. The packet is
the one thing both seats read, so what it leaves out costs a claim later. Keep real names of seats, models and vendors out of it
(the blinding scan stops a packet that names them in a way a seat could copy).

```markdown
# Task packet: <what is reviewed, in a few words>

Profile: <Code | Architecture | Document, or a combination: see review-profiles.md>. Target: <path or repository, branch, HEAD>.
Read-only review: do not edit, create or delete any file in the target; do not commit.

## Scope
- In scope: <files, folders, tickets, the diff against <base>>
- Out of scope: <what the seats must not spend claims on>

## Acceptance criteria (tag each one so claims can cite it)
- [AC-1] <criterion and where it comes from: ticket id, section>
- [AC-2] ...
A seat marks a claim with the tag in its heading, for example `## A3 [AC-2] ...`; the scorecard then groups findings by tag.
Each seat also writes one line per tag it checked under `## Checks performed`, starting with the tag and ending with MET, PARTIAL or NOT MET (for example `- AC-2: ran the fixture, no issue. MET`). For a hypothesis `[H1]`, the line ends with CONFIRMED, REFUTED or PARTLY CONFIRMED; the report prints that outcome. The report lists a tag no seat names as NOT VERIFIED.
When criteria come from several tickets and a tag does not carry its ticket number, add one line `Tickets: 6041 = AC-OWN-C, AC-OWN-D; 6045 = AC-OWN-E`; the report then groups those tags under their ticket, and a seat line per ticket that ends with GO or NO GO (`- 6041: GO`) is shown per ticket.

## Known deviations from the criteria
<each one, or "none": an undisclosed deviation is a finding the seats will spend a claim on>

## Start here (large targets)
<the files and functions that matter most, in order, with line ranges when known; a start, not a limit>

## Evidence both seats may cite
<pre-flight summary: HEAD, branch, snapshotHash, commits behind upstream, changed-file count, and the path of the compact
pre-flight JSON and test logs. Run each expensive command once as pre-flight Tier 2 and say so here.
With `--exec-in`, add one line per repository: Evidence per repo: <path> <snapshotHash from tier2Repos> <stale? from --check-stale>.>

## Author-reported evidence (optional; not reproducible, never cite it as EXECUTED)
<results the author ran that the seats cannot repeat, such as captures from a live array, a manual test or a ticket thread:
what was run, where it is summarised (a file path), and what it showed. Seats may use it as context and must label it
author-reported, not verified.>

## Hypotheses to test (optional)
Items of your own bug checklist (`review-config.mjs checklists --name NAME`) go here, one hypothesis each.
- [H1] <...>

## Checks
<the target's own test, lint and build commands, and which of them a seat may run. A write-heavy suite runs in a disposable folder.>

## Severity note
<the default rubric, or what is worse than usual here, and who or what reads a wrong result>
Under the default rubric a wrong result from the code under review is HIGH, also when nothing is deployed yet; only a rubric this packet states changes that.

## Output
Findings in the required schema in your own findings file. A `## Checks performed` section for checks that found nothing.
Web verification is <on | off (repo-only review)>. Close with one line: `web: <n> queries, <n> page fetches`.
```

## Writing the packet on Windows

- A path such as `C:\Users\name\repo` in a Python or JavaScript string literal is read as escapes (`\U` is a syntax error in Python).
  Write it with forward slashes (`C:/Users/name/repo`), as a raw string, or from a file, not typed into a normal string.
- A `.cmd` or `.ps1` tool (for example the Azure CLI `az`) started from a script needs a shell: Python `shell=True`,
  Node `shell: true`, or call it through `powershell -NoProfile -Command`.
- Write the packet as UTF-8 without a byte-order mark; PowerShell 5.1's `Set-Content -Encoding utf8` adds one.
