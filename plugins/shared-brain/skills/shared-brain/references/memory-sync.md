# Memory-sync mode

Publishes durable engineering lessons from this project's local memory directory into the
shared store. Read this whole file before running it. Every rule in `SKILL.md` still applies;
this file only adds stricter ones.

This file is the domain-agnostic generalization of open-brain's `memory-sync.md`. The only
substantive change is Rule 6: it now loads its allowlist from a resolved profile
(`profiles/*.yml`) instead of naming a specific product. Every other rule, the transform, the
dedup protocol, and the approval gate are unchanged.

**Source directories are discovered, never hardcoded.** The helper resolves the Claude config
root from `CLAUDE_CONFIG_DIR` or `~/.claude`, then scans every `projects/*/memory/` it finds,
plus a global `memory/` beside the config root if one exists. That works unchanged on Windows,
Linux, and macOS, for any user. Start by seeing what is actually there:

```bash
python scripts/scan_memory.py --list-dirs
```

Expect several projects, not one. A real run on one machine found 243 files across 10
directories, 51 mechanically blocked, 192 still needing human judgment. At the rate one project
actually produced (36 judged → 8 candidates), the whole tree yielded roughly 45 publishable
entries into a store already holding hundreds — a real, measured increase from a single run,
every entry at the weakest confidence grade. This scale is not specific to any one product;
expect a comparable ratio in any memory tree that's been accumulating for a while.

That is not a batching inconvenience. It is the reason this mode is constrained below.

## Three hard limits on a run

**One project per run.** Refuse a multi-project init. `--project` already errors on an
ambiguous substring; the mode must not paper over that by scanning everything. If the user
asks for "all projects", explain the numbers above and ask which project to start with.

**Ten proposals maximum per run.** If a project yields more, propose the ten strongest and say
plainly how many were deferred — never silently truncate, and never quietly widen. Ten is not
a technical limit; it is the largest number of full-text entries a human will actually read
rather than skim, and an unread approval is the same as no approval.

**Triage before drafting.** Do not draft full text for every candidate and ask the user to
reject most of it. Show a one-line summary per candidate first — slug, the claim in a sentence,
and which Rule 6 clause it satisfies — and let the user pick which get drafted. Reading forty
lines is possible; reading forty full entries is not, and the gate depends on real reading.

Note the ledger keys entries as `project/slug`, because the same filename legitimately exists
in several projects and an unqualified key would let one project's sync mask another's.

Contents:

- Three constraints that shape everything else
- Filter — rules 0-7, mechanical gate first, then judgment
- Transform — memory prose into a standalone thought
- Deduplication across re-runs — the outage trap, identity, the per-item protocol
- Approval gate
- Helper

## Three constraints that shape everything else

**One direction. The memory dir is read-only.** Read it, derive from it, publish outward.
Never write, never update a synced marker into it, never touch `MEMORY.md`. This is a
standing user rule with a real reason: local memory is the only channel by which
human-authored knowledge reaches the pipeline, and if an automatic capture pipeline could write
there its own output would become indistinguishable from the human's. Any bookkeeping this
mode needs lives in the skill directory instead.

**It is a filter, not a mirror.** Most files must not publish. The default answer is skip.
A sync that publishes half the directory has failed regardless of how good the text is,
because the store is shared and most of this directory is not shared-store material.

**Transform, never copy.** These are two different genres. A memory file is written for an
agent resuming *this* session: it assumes the project, uses `[[wiki-links]]` that resolve
only inside the memory dir, says "this session" and "still open as of last week", and
leads with narrative. A shared-brain entry is read by an agent with zero context on a
different project. Copying the body across produces text full of dangling references and
stale relative time. Rewriting is the work; the filter is just what precedes it.

## Filter

Apply in order. Any BLOCK is final — later rules cannot rescue a file.

**Every file gets a verdict, and the arithmetic must close.** Before presenting anything,
add up your categories and check the total equals the file count the gate reported. Show that
sum in the classification table.

A file that is never mentioned in your classification looks exactly like a file that was
carefully considered and skipped — the only way to catch a silently-dropped file is to check
that the categories sum to the total file count, every run, not by eye.

Use `--json` and count programmatically rather than by eye. A classification that does not sum
is not a filter result; it is an unknown number of unexamined files.

### Rule 0 — the mechanical gate runs first, and its BLOCK is final

`python scripts/scan_memory.py` hard-BLOCKs three classes before any judgment: `type: user`,
unparseable frontmatter, and anything the secret scanner matches. You cannot override these.

Two things about its output that decide whether this works:

- **`review` is not a recommendation.** It means no automatic rule fired. Most `review` rows
  should still be skipped by rules 3-6.
- **A clean scan is not proof there is no secret.** The scanner knows token formats, emails,
  IPs, and home paths. It cannot know your customers' or your company's names.
  `CUSTOMER_DENYLIST` in the script is empty until someone fills it, so that class is
  unguarded — read for it yourself.

### Rule 1 — BLOCK secrets, credentials, machine-local paths

Block outright if the file is about credential state, contains a token or PAT, or exists
mainly to record absolute paths on this machine. Reason codes: `blocked: secret/credential`,
`blocked: machine-local`.

**Block the file; never redact and publish it.** A file that needs scrubbing to be safe is a
file whose subject is entangled with the secret. Rule 7's re-read is a second net for
incidental leaks in a file that passed, not a licence to sanitize a blocked one.

**One narrow exception, for machine paths only.** A file blocked *solely* because it contains
a local filesystem path — `windows-home-path` or `posix-home-path`, and nothing else — is not
holding a secret. It is holding a username, which Rule 7 already tells you to strip from files
that pass. Blocking outright here can destroy real knowledge: a file whose actual lesson is a
framework or library trap ("two copies of a dependency exist and the wrong one gets bound at
import time") survives losing the absolute path — its only offence was containing
`C:\Users\<name>` incidentally.

The exception is deliberately narrow, and stays narrow:

- It applies **only** when the sole scanner labels are the two home-path patterns. One
  additional label of any kind — email, IPv4, token, internal identifier — and the file blocks
  outright.
- The lesson must not *be about* the path. "The wrong dependency copy gets bound at import
  time" survives losing the absolute path; "the repo lives at this location" does not, and
  blocks.
- Re-run `--scan-text` on the finished draft. The draft must come back clean, not
  clean-except-the-thing-you-decided-to-allow.

Do not generalise this to internal hostnames, test credentials, or anything else that "isn't
really a secret". Every carve-out of that shape starts as this one and ends as a leak; the
line is drawn at paths because Rule 7 already draws it there for passing files.

Note a real gap the scanner cannot close: a file that *describes* a credential problem
without containing a credential passes the pattern scan — a file that names where a token
leaked and whether it was scrubbed, holding no token itself, scores clean but is still an
obvious block under this rule. Judge the subject, not just the bytes.

### Rule 2 — BLOCK `metadata.type: user`

No exceptions, no case-by-case. Reason code: `blocked: user-specific`.

The type field is read from both the root and `metadata:`, and a conflict between them is a
parse error that blocks. Do not read the type yourself from the raw text — the helper's
parse is the one that fails closed.

### Rule 3 — BLOCK preferences and working-style instructions

This is the rule that requires judgment, and the one a naive implementation gets wrong.
Ask: **is this a fact about the systems and code, or an instruction about how to treat this
particular user?**

Instructions about tone, git habits, when to commit, which model to spawn, how to frame
findings, behavioral corrections — all block. Reason code: `blocked: preference`.

**Run the Rule 6 tiebreaker before finalising any `blocked: preference` verdict.** A file that
reads as working-style advice can still name a specific check or contract that constrains real
code, and the tiebreaker admits it. This is not theoretical — a file stating that one build
tool passes on a renamed symbol while a different linter catches the dangling reference,
demonstrated against a real file, is a fact about verifying code wearing the costume of a
tooling habit.

The question to ask on every preference block: *does this name a file, function, gate, or
external-system behaviour a future task would have to satisfy?* If yes, it goes to Rule 6, not
here.

**`metadata.type` does not decide this.** A memory directory's `feedback`-typed files commonly
contain both durable engineering knowledge and pure user preferences, and a type-based filter
would silently leak the preferences into a shared store. Judge by content, every time. Note
also that the type field can be unreliable in the other direction — a credential-status file
might be typed `project`, and a session-resume file typed `project` too. Read before deciding.

### Rule 4 — BLOCK session state and run logs

Resume checklists, "modified files" lists, per-iteration cost and outcome tables, uncommitted
work inventories. These are bookkeeping with a shelf life measured in days. Reason codes:
`blocked: session-state`, `blocked: run-log`.

**Blocking the file is only half of this rule.** A run log can still *contain* a durable
lesson. Do not publish the log; extract the lesson and publish that instead, so a
per-iteration cost table never reaches the store.

**The extraction pass is mandatory, not optional.** Open every file you block under this rule
and read it for an extractable lesson. Report the pass explicitly — "22 run logs read, 11
yielded a candidate" — because a silent file-level block is indistinguishable from a skipped
pass, and the skipped version is what actually happens under time pressure.

Blocking every file in a whole category at file level on the reasoning "every file of this
shape is a session record" is the single largest source of lost yield this filter can produce
— many of them can hold a distinct framework or external-API lesson unrelated to the session
bookkeeping around it. Recovering that yield loosens no rule; it just requires actually opening
the file.

The extracted lesson stays `memory-sync` provenance and keeps every control in this file —
marker, ledger, per-item protocol. Relabeling it `hand-capture` would hide that its evidence
is an old memory rather than current code, and would drop it out of the dedup scheme so a
re-run republishes it. It only becomes a hand capture if you independently rediscover and
verify the claim against today's code or a command you ran — at which point the evidence is
genuinely yours and `verified:` can rise above `reported`.

### Rule 5 — BLOCK the transient and the project-status

Snapshots of current version, what shipped, what is in flight, "still open, not yet done".
True this week, misleading next quarter. Reason code: `blocked: transient/status`.

### Rule 6 — PUBLISH durable engineering knowledge, on a resolved profile's allowlist

**This is the rule that generalizes across projects.** Before applying it, resolve which
profile governs this run (see SKILL.md's "Choosing a profile" section) — `profiles/default.yml`
if no project-specific one exists, or a project profile like `profiles/vsi-engineering.yml`.

Publish only if the lesson matches one of the resolved profile's `allowlist` entries.

Categorically blocked even when phrased as a general engineering fact — regardless of which
profile is active, every profile's `blocklist` includes: model selection, prompting technique,
agent delegation and orchestration, commit and git workflow, communication style, and
agent-reliability observations. A sentence that reads like an engineering finding but is
actually a working-style instruction (e.g. an observation about how a specific model behaves
on a specific task type) does not publish, no matter how it's phrased.

**Tiebreaker, for files that satisfy the allowlist AND the blocklist at once.** The two lists
overlap: a lesson can name a real gate that blocks a build *and* observe how an agent behaved.
Applied naively the file is simultaneously required and forbidden, and the reviewer picks
whichever list they read last. Use the resolved profile's `tiebreaker` field — a profile should
define one, following this shape (run `python scripts/scan_memory.py --check-profile <path>`
before trusting a new or edited profile; nothing else in this skill validates that a profile
actually has this field, so a hand-edited one missing it fails silently rather than loudly
until that check is run):

> Publish if the lesson names a **specific check, contract, or external-system behavior that
> constrains real code** — even when it also observes agent behavior. Block if the observation
> about the agent is the whole content, with no named artifact a future task must satisfy.

The test is whether a reader gets something to *do* or *verify*. Naming specific artifacts
(function names, gate names, endpoint behaviors) survives; a bare observation about agent
behavior with nothing named does not.

Note the direction of the bias here. This tiebreaker admits files, so it is the loosest rule
in this document and the one most likely to drift — over time the temptation is to read
"constrains real code" generously enough to admit anything. If you cannot point at the
named artifact in the text, the tiebreaker does not apply.

**Mixed files block by default.** A file holding one publishable fact and three preferences
does not become publishable by extraction alone — pull the durable claim out only after
independently re-verifying it against current code, and then it is a hand capture with its
own verification, not a sync.

It must also clear the main SKILL.md's bar — a competent engineer would get it wrong on the
first attempt.

Then check for a bug already fixed. A file describing a bug that is now fixed and is not
reachable again publishes only if the *lesson* outlives the fix — a class of mistake, not
one instance. If the lesson is "we fixed this once", skip.

**Then check the corpus against itself.** Before admitting a file that states a closed set or
a hard limit — "exactly these eight values", "only these fields are accepted" — search the
other memory files for a counterexample. Publishing a confident, wrong constraint into a
store with no delete is worse than publishing nothing.

Closed-set claims are the highest-rot shape in a memory dir: true when someone wrote them,
quietly falsified by the next schema change, and stated with more certainty than they earned.
Verify the set against current code, or drop the enumeration and keep the principle.

### Rule 7 — Final scrub on everything that passed

Re-read each surviving file for secrets, tokens, internal hostnames, IPs, and customer or
company names. A file can pass rules 1-6 and still carry an incidental credential in an
example. Also drop the absolute machine paths — `C:\Users\<name>\...` means nothing to another
reader and identifies the machine. Refer to repos by name.

## Transform

For each publishing file:

1. **Line 1 is a new sentence you write** — the general rule, naming the concrete
   technology, phrased as it would appear in a ticket title about the same subject. Do not
   reuse the frontmatter `description`; those are written as index entries, often start with
   a bare name, and read as labels rather than rules.
2. **Strip every `[[wiki-link]]`.** They resolve to nothing outside the memory dir. If the
   link carried necessary meaning, state that meaning in a clause. Otherwise delete it.
3. **Drop relative and narrative dates.** "Found this session", "as of last week", "not yet
   done" — all become either an absolute date or nothing. "Still open" claims are unverifiable
   later; cut them.
4. **Cut the narrative.** "I burned 5 minutes before checking" is session texture. The rule
   and the fix survive; the story does not.
5. **Make it standalone.** Expand project-local shorthand on first use. Name the repo.
6. **Keep it one idea.** A memory file with three distinct lessons becomes three thoughts or
   one narrowed to the strongest. Prefer narrowing — a memory file long enough to hold three
   lessons is usually long enough that its tail truncates anyway.
7. **Re-verify citations before carrying them over.** `file:line` references are the most
   valuable content in these files and the most likely to have rotted — the code moved after
   the memory was written. Open the cited file and confirm the line still says what the
   memory claims. Correct the numbers, or if the code has changed enough that the claim no
   longer holds, skip the file — publishing a stale citation manufactures exactly the rot this
   store cannot delete.
8. **Cap around 1,800 characters.** `_MAX_ITEM_CHARS` is 3000 but recall renders up to ten
   hits inside a 12,000-char budget, so a fat entry crowds out its neighbors and risks its
   own tail.

Provenance line, exactly:

```
Source: memory-sync:<source_id>:<body12> | verified: reported | reviewed-by-human | <YYYY-MM-DD>
```

`<source_id>` is `sha256("<project>/<slug>")[:12]` — the **project-qualified** key, opaque on
purpose because the filename stem can name a customer, a host, or a person and the marker
survives every scrub applied to the body. Qualifying is not cosmetic: the same filename can
exist in many memory dirs (`MEMORY.md` is in all of them), so hashing the bare slug would give
two different lessons one identical marker and make them indistinguishable to dedup. Take the
value from the helper rather than computing it by hand.

`<body12>` is the first 12 hex of the sha256 of the thought's **body** — everything above the
`Source:` line, which is the part that carries the lesson. It is emphatically *not* the hash of
the finished thought: the marker lives inside that thought, so hashing the finished text to
produce a value you then insert into it changes the very thing you hashed. The hash must cover
only text that is already fixed before the marker is written.

`--scan-text` prints `body_sha256` (marker input, computed above the `Source:` line) and
`thought_sha256` (whole finished text, used for the approval binding in SKILL.md and for the
ledger). Two different hashes for two different jobs — do not substitute one for the other.

Order of operations, which matters:

1. Draft the body. Run `--scan-text` on it → `body_sha256`. Take the first 12 hex.
2. Append the `Source:` line using that value.
3. Run `--scan-text` again on the complete thought → `thought_sha256`. That is what the user
   approves and what the ledger records.

Synced entries always emit `verified: reported`, never `read` or `executed`, per the shared
definition in SKILL.md. The lesson was verified in an earlier session and this agent did not
re-run it, so the grounding is an earlier assertion — that is exactly what `reported` means.

This holds even though transform rule 7 requires you to re-open the cited file. Confirming a
line number still resolves is not re-verifying the claim the memory makes about it; you
checked the coordinates, not the conclusion. Where the source records its own verification,
keep it in the body as a quote of a past event ("Verified 2026-08-09 by reading ...") rather
than promoting the provenance field.

## Deduplication across re-runs

The capture tool has no upsert on the backend this skill was designed against (see SKILL.md's
naming note if your backend differs). A second sync of an unchanged memory would create a
near-identical entry that then returns *alongside* the original in every future result set,
permanently, halving the value of both. This is the mode's main hazard, so it gets a two-layer
defence.

### The trap that makes naive dedup dangerous

A search call can return an empty result for a genuine miss **and** for a disabled
integration, a network failure, a malformed response, and an HTTP error. So an empty result
cannot distinguish *"this is new, go ahead"* from *"the store is unreachable"*.

Treat that ambiguity as the central hazard. A sync run during an outage that reads an empty
result as "new" republishes every entry, permanently, with no delete to undo it.

**Call the MCP search tool directly rather than going through any wrapper client, and read the
reply text.** A real miss answers in prose — `No thoughts found matching "..."`. A failure does
not. If you cannot positively confirm a miss, you have no dedup result: **stop the run.** Do
not write.

### Identity: hash the thought, not just the source

Dedup keys on the **thought**, because one memory file can become several thoughts and a
source hash cannot tell them apart:

- `source_id` — `sha256("<project>/<slug>")[:12]`, opaque. The marker used to embed the raw filename, and
  filenames name customers, hosts, and people; that survives every scrub applied to the body.
- `thought_sha256` — full hash of the exact final text. This is the identity that decides
  whether a write happens.
- `source_sha256` — full hash of the source body, kept for "did the source change?" audit
  only. Never the write key. An improved rewrite of an unchanged source is a legitimate new
  thought, and an editorial source tweak that yields identical text is not.

Get both from the helper: `python scripts/scan_memory.py --scan-text <draft-file>`.

**Layer 1, the marker (authoritative).** `memory-sync:<source_id>:<body12>` in the provenance
line — the only field that survives, since captures carry no metadata. `<body12>` is the
body hash defined above, **not** `thought_sha256`: the marker sits inside the finished thought,
so it cannot be derived from that thought's own hash. Two hashes, two jobs — `body12` goes in
the marker and is what you search for; `thought_sha256` binds approval and keys the ledger.

**Layer 2, the ledger (fast path only).** `.synced.json` in the skill directory, never in the
memory dir. It records a *set* of published thoughts per source, so a partial batch is
representable. An unreadable ledger is a hard stop, not an empty one — "nothing published
yet" is how a re-sync duplicates everything.

### Per-item protocol

Run this per thought. Never batch the writes.

1. **Preflight.** Ledger hit on this `thought_sha256`? Skip — already published.
2. **Confirm miss.** Search on the drafted line 1 via the MCP tool. Scan hits for
   `memory-sync:<source_id>:`.
   - Prose miss confirmed, no marker → new. Propose it.
   - Marker with the same `body12` → already published; repair the ledger, skip.
   - Marker with a **different** hash → the source changed after publication. There is no
     update. Default to skipping and reporting a conflict with both hashes and what changed.
     Publish a revision only on explicit request, and say plainly that the store will then
     hold two versions and the old one keeps returning. Prefer a supersession entry (below).
   - **Anything else — error, empty-but-unconfirmed, malformed → stop the batch.** No write.
3. **Write once.** One capture call. Never retry it blindly: it may return a success signal for
   any non-null response without verifying the content landed, and a timeout can fire after
   the server already committed. A blind retry is how you get a permanent duplicate.
4. **Reconcile on the marker, not on a hit.** Search again and confirm a returned entry
   contains *this item's* `memory-sync:<source_id>:<body12>` marker. A hit that merely looks
   similar proves nothing — you searched for a line designed to resemble neighbouring entries,
   so a pre-existing near-duplicate satisfies a did-anything-come-back test and falsely
   confirms a write that never landed. The marker is unique to this item; require it.
5. **Record.** `python scripts/scan_memory.py --record <slug> --source-hash <h> --thought-hash <h> --marker <m>`
   — atomic, and only after step 4 confirms.
6. **On any ambiguity at step 3 or 4** — timeout, unclear response, marker not found after a
   write — **stop the whole batch and report.** Do not proceed to the next item and do not
   retry. Reconcile with the user before resuming; an ambiguous write is exactly the state
   where guessing creates the duplicate that cannot be removed.

### Two limits to state plainly, because they cannot be fixed here

**Semantic search can miss a marker.** Threshold 0.45 on the backend this skill was designed
against, and a reworded line 1 may not match the published one. Confirm your own backend's
threshold if it differs — the number matters, not just its existence, since it's what tells you
how much rewording a marker can survive before a re-run risks a false "new" verdict. That is why
step 2 defaults to *not* writing on anything unclear: a skip is recoverable by asking again, a
duplicate is permanent.

**Concurrent syncs cannot be made safe.** Two machines can both confirm "no marker" and both
write. If the backend offers no idempotency key, conditional create, or lock, a local ledger
cannot coordinate across machines. **Do not run two syncs at once.** If a second machine may
be syncing, do not start.

## Approval gate

Non-negotiable, and stricter than the single-capture gate because bulk is where damage
scales.

1. Show the **full classification table first** — every file, publish or skip, with a reason
   code. The user sees what was excluded, not only what was chosen. A filter is judged by
   its rejections.
2. **Triage: one numbered line per candidate, before any drafting.** Slug, the claim in a
   sentence, and which Rule 6 clause it satisfies. Close with the same fixed question — *"reply
   with draft all, draft all except N, N, or none"* — so the triage step ends in a decision
   rather than a discussion, exactly as the approval step does. This exists because drafting
   first inverts the cost — the agent spends its effort on entries the user was always going to
   reject, and the user faces a wall of full text and skims it. If more than ten candidates
   survive the filter, list them all in triage but propose at most ten, and say how many were
   deferred.
3. Show the **complete final text of every thought the user selected**. Not a summary, not the
   first line, not a count. The exact strings.
4. **Ask the approval question in exactly this form, as the last thing you say:**

   > reply with approve all, approve all except N, N, or reject all

   Those exact words, lowercase, matching SKILL.md. The literal is duplicated in two files, so
   it drifts unless both are kept identical.

   Number every proposal so "except 3, 7" is unambiguous. No auto-approve flag exists in this
   mode, and silence is not approval.

   This wording is fixed on purpose. An open-ended "which should I draft?" or "let me know
   what you think" reads as a conversation opener, and the natural reply is discussion rather
   than a decision — so the batch sits unapproved while both sides think the other has the
   ball. Three named options with a numbered list turns approval into one short reply, which
   is the only version a person reliably gives. Ask it verbatim; do not paraphrase it into
   something friendlier.
5. Support **per-item decisions** — the user accepts some and rejects others. Never
   all-or-nothing.
6. If the full text is too long to review comfortably, **the filter is too loose**. Tighten
   it and re-propose. Never truncate the review to fit; that defeats the gate.
7. **Approval binds to the exact bytes.** Record each proposal's `thought_sha256` alongside
   the approval. If the text changes afterward for any reason — a requested edit, a date
   roll, a provenance fix — that approval no longer covers it; re-show and re-ask.
8. Write approved items **one at a time** through the per-item protocol above, confirming
   each before starting the next. On any ambiguous result, stop the batch and report rather
   than continuing or retrying.
9. Report each outcome individually: published, skipped, conflicted, or stopped-unconfirmed.
   A batch summary that says "12 published" without per-item confirmation is exactly how an
   unconfirmed write gets recorded as done.

## Helper

`scripts/scan_memory.py` handles the mechanical part — enumerate files, parse frontmatter,
compute body sha8, and check the ledger — so each run does not re-derive the parsing. It
deliberately does **not** classify: rules 3 and 6 need judgment about content, and a
keyword-matching classifier would pass preferences into a shared store. Treat its output as
the worksheet you then judge, file by file.

```bash
python scripts/scan_memory.py --list-dirs         # which memory dirs exist, and how big
python scripts/scan_memory.py                     # worksheet across ALL of them
python scripts/scan_memory.py --project <name>    # one project at a time (recommended)
python scripts/scan_memory.py --memory-dir <path> # an explicit directory
python scripts/scan_memory.py --body <slug>       # print one body; use project/slug if ambiguous
python scripts/scan_memory.py --scan-text <file>  # secret-scan a draft, print both hashes
python scripts/scan_memory.py --project X --verdicts <file>  # did every file get judged?
python scripts/scan_memory.py --record <slug> --source-hash <h> --thought-hash <h> --marker <m>
python scripts/scan_memory.py --ledger            # dump the ledger
```

`--verdicts` takes a file of `slug: verdict` lines and diffs it against the slugs the gate
says need judgment, reporting anything missing, duplicated, or unrecognised. Write your
classification to a file and run it **before** presenting the triage. Counting by eye is how
files silently disappear from an audited run.

Requires Python 3.8+ and PyYAML. The script itself only needs 3.7, but current PyYAML
releases declare 3.8, so 3.8 is the honest floor unless you pin an older PyYAML. Without PyYAML
every file becomes a BLOCK row explaining why, rather than falling back to a hand-rolled
parser — a mis-parsed `type` field would bypass a hard block, so the dependency fails closed
instead of guessing.

It is read-only against the memory dir and has no write path to it — the only file it writes
is the ledger, in the skill directory. `--body` is restricted to a real inventoried file, so
a slug cannot traverse out of the memory dir.

`--record` exists so the ledger is never hand-edited: it writes atomically via a temp file
and rename, because a half-written ledger reads as "nothing published" and that is how a
re-sync duplicates the whole directory. Call it only after a write is confirmed present.
