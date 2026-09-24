---
name: pair-review
description: >-
  Review code, designs, or documents with two distinct Claude models.
  Supports collaborative, adversarial, and independent passes, first-run
  model setup, saved preferences, and changing models anytime.
  Use for pair review, two Claude reviewers, or /pair-review.
license: MIT
compatibility: >-
  Requires Node.js 22+ and a harness that can run two isolated Claude
  reviewers with explicit model selection and resume or relay their findings.
  Claude Code is the primary target. Model access depends on the user's account.
metadata:
  version: 1.6.1
---

# Pair Review

Two distinct Claude models independently review the same target, then exchange
findings. The orchestrator coordinates and verifies; it never fills either seat.

## Start here: model setup

Read [references/configuration.md](references/configuration.md) before dispatch.
Run the bundled configuration helper's (`scripts/review-config.mjs`) `show`
command. If no saved configuration
exists, ask the user to choose both models and optional effort levels before
the first review. Do not silently install a default pair.

`/pair-review setup` runs the same setup anytime; `/pair-review config` shows
current choices. A request such as "change pair-review's second model to Sonnet"
also updates setup. These commands configure only; they do not launch a review.

## Invocation

```text
/pair-review setup
/pair-review config
/pair-review reset
/pair-review [collaborate|adversarial|none] [modelA[:effort]] [modelB[:effort]] -- <task>
```

The delimiter separates optional model selectors from task text. Natural-language
requests work too; do not infer a model selection from a model name mentioned
inside the review target. Existing positional invocations remain supported when
unambiguous; otherwise ask which part is the task.

To request the opt-in Falsification pass (see references/review-protocol.md),
include the phrase **"deep verify disputed high-severity findings"** in the
task text — the canonical phrase the orchestrator recognizes as an explicit
request; falsification never runs without it.

- Saved mode defaults to `collaborate` at setup. `adversarial` attacks each
  other's findings; `none` skips peer exchange — the fresh auditor still
  compares and canonicalizes the two independent findings sets, without
  rebuttal data.
- Explicit run choices override saved values without saving them. Missing
  selectors use saved choices. A model change clears that seat's saved effort
  to `default`, unless the user also supplies an effort.
- For an ID containing a colon, use an explicit named seat and separate effort
  in natural language rather than interpreting the ID as `model:effort`.
- Both resolved models must be distinct, including when different aliases map
  to the same actual model. Never silently substitute.

## Review workflow

1. Resolve configuration and validate availability using
   [references/model-capabilities.md](references/model-capabilities.md).
   Snapshot the selected settings for this run; do not reread preferences
   between review rounds.
2. Read the target and [references/review-protocol.md](references/review-protocol.md).
   Run [scripts/preflight.mjs](scripts/preflight.mjs) against the target
   directory per that doc's Pre-flight evidence paragraph and include its
   output in the task packet; write its output and logs to a folder next to
   the run directory, never inside it (the auditor receives the packet). Give both seats the same task packet: scope,
   current source snapshot, actual test commands, constraints, and expected
   output. Pick a lens from
   [references/review-profiles.md](references/review-profiles.md) (Code,
   Architecture, or Document — inferred from the target, not asked of the user
   unless genuinely ambiguous) and give both seats the same choice.
3. Create a unique run directory under the harness scratchpad or OS temporary
   directory. Assign `<run-dir>/phase1/A-findings.md` and
   `<run-dir>/phase1/B-findings.md`; keep artifacts outside the reviewed
   source. Include a run ID in both agent names.
4. Start both isolated reviewers concurrently using this harness's supported
   model/effort mechanism. Pass the protocol and task explicitly; do not
   assume subagents inherit this conversation. Build each brief with
   `node "<skill-dir>/scripts/build-brief.mjs" --mode phase1 --packet
   <task-packet> --seat A|B --out <brief file> --output-path
   <run-dir>/phase1/<seat>-findings.md`: it copies review-protocol.md's
   seat rules, Model identity, findings schema, and web reviewer rules
   verbatim, and tells the seat to write its findings to its own file and
   reply only with counts; the orchestrator never retypes a seat's findings
   from a reply. Tell each seat to read its brief from the file. In Phase 1, neither seat may
   read the peer's file. Review only; no source edits or commits. Each seat
   is a harness subagent, not a spawned process, so no script here can
   enforce a wall-clock bound the way `cross-review`'s dispatchers do; if
   this harness offers a per-agent timeout or budget control, apply a
   provisional 30-minute bound per seat (unless the user specifies otherwise)
   and treat an exceeded bound as an incomplete review for that seat, the
   same as any other failed pass — never as a completed one. Spawn both seats
   as a general-purpose agent (`Tools: *`), not a restricted-toolset subagent
   type — this is what gives each seat WebFetch/WebSearch for
   review-protocol.md's Web verification rules; naming a more restricted spawn
   type for either seat silently loses that capability with no error to catch
   it. Both briefs carry review-protocol.md's "Web verification: reviewer
   rules" subsection (build-brief adds it unless the task says "repo-only
   review") — pair-review is Claude-and-Claude, so this capability
   is symmetric between seats by construction, unlike cross-review's
   Codex/OpenCode asymmetry.
5. Wait for both independent passes to complete, AND
   `scripts/blind-relabel.mjs validate --phase1-dir <run-dir>/phase1
   --target-dir <target-dir>` exits zero (with `--target-dir` it also rejects a
   claim ID a seat wrote inside an Evidence fence), then copy both files to `<run-dir>/phase1/original/` (the manifest
   hashes these untouched copies; step 6 appends to the working files). A
   nonzero `validate` exit means at least one claim block is missing a
   recognized `Severity:`, `Basis:`, `Evidence strength:`, or non-empty
   `Evidence:` line — return the affected seat's file to that seat's OWN
   context for reformatting (restate the required field lines verbatim,
   change nothing else), same procedure as a `scan` redaction round, never a
   hand edit. A reviewer following the schema loosely (dropping the
   `Evidence:` label and going straight to prose) is common enough in
   practice to gate here, before it surfaces only much later as a `translate
   --phase1-dir` refusal. A reviewer may return after
   its initial pass; resume it for the exchange. This avoids agents waiting
   indefinitely for a peer that has not been released by the orchestrator.
   Missing files may be recovered verbatim from a valid final response.
   **Never resume by forking** (e.g. an `Agent` tool call with
   `subagent_type: "fork"`, or any equivalent that inherits the orchestrator's
   own conversation): by the exchange step that conversation already
   contains the peer's real findings and identity, so a fork handed to either
   seat is a blinding breach by construction, not a resume. Resume the exact
   Phase 1 agent/session ID only: in Claude Code, send a message to that
   agent ID or name with the SendMessage tool, never a new Agent spawn. If a
   seat can no longer be resumed, that seat's exchange is incomplete; a new
   agent is not the same reviewer.

   Both seats are Claude subagents with file-writing tools, so no sandbox
   stops a source edit. After each phase (Phase 1, the exchange, and the
   auditor), run `scripts/preflight.mjs --cd <target-dir> --check-stale
   <snapshotHash>` with the hash from step 2. `stale: true` means something
   changed the target during the review: stop, find the changed files, and
   report the run as incomplete; never continue on a changed target.

   A pass can complete and still be too shallow to exchange (few claims, and
   its own `Checks performed` says most checks were not run). Before the
   exchange, you may resume that SAME seat once with a coverage brief naming
   the unchecked scope; the peer's findings are not shown, so it is still the
   independent pass. Record it in the manifest as `coverage_rounds: 1`.

   A redaction made before the exchange (no peer has seen the file yet) is
   still part of the independent pass: re-run `validate`, then replace the
   `phase1/original/` copy. A redaction after the exchange leaves
   `original/` alone, and the manifest notes it.
6. Unless mode is `none`, use `scripts/blind-relabel.mjs relabel` to relabel
   each seat's findings per the protocol's Three label layers before sending to
   the other reviewer (seat A's claims become `P1..Pn` in seat B's brief, seat
   B's claims become a separate `P1..Pn` in seat A's brief), then
   `scripts/blind-relabel.mjs scan` the relabeled text for vendor/model tokens
   AND (`--phase1-dir <run-dir>/phase1 --forbid-seats A` on the peer-view built from
   seat A's file, `--forbid-seats B` on the one built from seat B's file) the
   source seat's own real claim IDs surviving anywhere, fenced Evidence
   included — `relabel` deliberately never rewrites fence content, so a
   reviewer's own cross-reference to an earlier claim by real letter (e.g.
   "my A4") inside its Evidence block survives relabel undetected by the
   vendor/model-token scan alone; omitting `--forbid-seats` here reopens that
   leak. A self-identification hit or a `--forbid-seats` hit is a hard stop,
   return it to that seat for redaction (one redaction round, then stop and
   report). Even with both seats on Claude, this keeps a reviewer from
   tailoring its rebuttal to which specific model it believes wrote a claim.
   Use file-ready messages when
   supported; otherwise relay via the orchestrator. Build each seat's
   exchange brief with `build-brief.mjs --mode delta --peer-view <the
   scanned peer-view for that seat> --out <brief file> --output-path
   <run-dir>/phase2/<seat>-rebuttals-raw.md`; it carries the peer-view
   verbatim plus review-protocol.md's Rebuttal instruction, and the seat
   writes its `### P<n>` entries to that file.
   Append them with `scripts/blind-relabel.mjs append-rebuttals --in
   <raw file> --onto <the PEER's findings file> --rebutter <seat> --peer-view
   <the peer-view that seat saw> --target-dir <target-dir>`, which checks coverage, translates `P` back
   to real IDs, and writes the heading below. Done by hand instead, append rebuttals
   (translated back to real `A`/`B` IDs) without overwriting original claims,
   under a section heading of the exact literal form `## Rebuttals (from
   <seat>) of <peer> claims` (e.g. `## Rebuttals (from A) of B claims`
   appended to `B-findings.md`) — `blind-relabel.mjs relabel` matches this
   heading by exact regex during the `X`/`Y` relabel in step 7b below; any
   other wording is invisible to the tool. Wait for both exchanges before
   synthesis. Once both rebuttal sections are appended, run
   `scripts/blind-relabel.mjs validate --phase1-dir <run-dir>/phase1` again (step 5's
   gate already ran it before any rebuttal existed) — this second run is a
   mechanical check on the rebuttal heading's exact form (both seat letters,
   `A`/`B`, never a claim ID or any other shape) and rejects a seat naming
   itself as its own rebutter. A malformed heading produces the identical "no
   rebuttal heading found" signal `relabel`'s second pass gives for a seat
   with zero rebuttals (step 7b's own expected zero-rebuttal case), so
   without this run the two are silently indistinguishable. `validate`
   deliberately does not enforce WHICH file a rebuttal heading is appended
   to — placement is standardized in prose (this step's own example above
   and review-protocol.md: onto the PEER's file), but `relabel` itself is
   placement-agnostic (it relabels a seat's letter wherever the heading
   appears), so `validate` only rejects the universally-invalid case: a seat
   naming itself as its own rebutter. A nonzero exit here uses the same
   redaction-round procedure as a `scan` hit.
7. Do not synthesize in this conversation. Follow this exact order:

   a. Run `scripts/blind-relabel.mjs flip --out
      <run-dir>/phase3-private/seat-to-audit-label.json` for
      `seat_to_audit_label` FIRST, and keep it and every relabel temp file in
      `phase3-private/`, never where the auditor can read.
      This order is required: an `X`/`Y`-labeled claim cannot exist before
      the coin flip has decided which real letter maps to which anonymous
      one, so falsification (which operates on `X`/`Y`-labeled claims) can
      only run after this relabel, never before it.
   b. Create a new, empty folder OUTSIDE the run directory for the auditor
      and build it with one command:

      ```text
      node "<skill-dir>/scripts/blind-relabel.mjs" audit-prep --phase1-dir "<run-dir>/phase1" --mapping "<run-dir>/phase3-private/seat-to-audit-label.json" --out-dir "<audit-input-dir>" --target-dir "<target-dir>" --tokens "<seat-a-model>,<seat-b-model>" --phase2-dir "<run-dir>/phase2"
      ```

      It relabels both seats' complete findings-plus-rebuttals to `X`/`Y`
      (two passes per file, one per letter, since each file carries both
      real letters), scans each result for vendor/model tokens, both real
      seat letters (fenced Evidence included), and leftover peer `P` labels,
      and only if everything is clean writes `X-findings.md` and
      `Y-findings.md` into `<audit-input-dir>`. A hit is a hard stop, one
      redaction round, then stop and report — same as step 6's scan. Copy
      the task packet and review-protocol.md into `<audit-input-dir>`. If the
      command cannot run, the manual equivalent is:

      ```text
      node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/A-findings.md" --out "<run-dir>/phase3-private/tmp-A.md" --from A --to <label-A> --phase1-dir "<run-dir>/phase1"
      node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase3-private/tmp-A.md" --out "<audit-input-dir>/<label-A>-findings.md" --from B --to <label-B> --phase1-dir "<run-dir>/phase1"
      node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase1/B-findings.md" --out "<run-dir>/phase3-private/tmp-B.md" --from B --to <label-B> --phase1-dir "<run-dir>/phase1"
      node "<skill-dir>/scripts/blind-relabel.mjs" relabel --in "<run-dir>/phase3-private/tmp-B.md" --out "<audit-input-dir>/<label-B>-findings.md" --from A --to <label-A> --phase1-dir "<run-dir>/phase1"
      ```

      followed by `scan --phase1-dir <run-dir>/phase1 --forbid-seats A,B
      --phase2-dir <run-dir>/phase2` on each result.
   c. If falsification was explicitly requested, apply the protocol's
      Falsification pass now, using the just-relabeled `X`/`Y` files:
      - Select every claim with `Severity` HIGH or CRITICAL AND a rebuttal
        `Action` of `DISPUTE`, from the real (pre-relabel) rebuttals. Never
        use the auditor's `Peer response` field for selection; it does not
        exist yet at this point.
      - Map each selected real claim ID to its `X`/`Y` label via
        `seat_to_audit_label`, then extract that claim's block and rebuttal
        from the already-relabeled `X`/`Y` files.
      - Spawn one fresh verifier subagent per qualifying claim with only
        that extracted block, read-only target access, and
        review-protocol.md. It returns a fixed-schema block:
        `Claim: <its own X|Y id>`,
        `Verdict: CONFIRMED | REFUTED | INCONCLUSIVE`, `Basis:`, `Evidence:`.
      - Run `scripts/blind-relabel.mjs scan` on each returned verdict before
        saving it, same as any other X/Y-labeled content. A
        self-identification or identity hit is a hard stop.
      - Save each verdict as `verification-<X|Y-id>.md`, named by the
        anonymous ID. Never save it under the real ID.
      - Supply these files to the auditor (step d) and pass
        `--verification-dir` when translating (step g). `translate` parses
        each file's own `Claim:`/`Verdict:` lines and refuses if either
        disagrees with the filename or with the auditor's asserted verdict.
        The verifier's file is authoritative for its ENTIRE record (claim,
        verdict, basis, evidence); the auditor's own transcription of it is
        never trusted. The auditor's `verifications` entries must carry only
        `{claim, verdict}` — `translate` populates `basis`/`evidence`
        directly from each file's own `Basis:`/`Evidence:` lines.
      - When falsification was not requested, skip this entire step, but
        still report how many claims would have qualified.
   d. Spawn a genuinely new subagent — **never** a fork of this
      conversation (e.g. an `Agent` tool call with `subagent_type: "fork"`,
      or any equivalent that inherits context): this conversation already
      contains both un-relabeled findings files, the coin-flip mapping, and
      seat identity, so a fork would hand the auditor exactly the leak the
      fresh-context auditor exists to prevent. Give it only `<audit-input-dir>`
      (the task packet, the relabeled findings, any verification files from
      step c, review-protocol.md), read-only access to the exact Phase 1
      target snapshot, and one output path inside `<audit-input-dir>` for
      its JSON; never point it at the run directory. Build its prompt with
      `build-brief.mjs --mode auditor --packet <audit-input-dir>/task-packet.md
      --audit-dir <audit-input-dir> --target-dir <target-dir> --run-dir
      <run-dir> --out <brief file> --output-path
      <audit-input-dir>/findings.audit.json`; it copies review-protocol.md's
      Auditor instructions and refuses a staged folder inside the run
      directory, or a task packet that mentions the run directory.
      No seat identity or model names. The target snapshot is the isolated
      worktree path if `--isolate` was used, the target directory otherwise;
      the auditor must never modify it.
   e. The auditor applies the protocol's evidence and evidence-strength
      rules and returns adjudication-added fields (Peer response,
      Verification, Final state) per claim. `Verification` is a REQUIRED
      structured `auditor_check: {result, basis, evidence}` object per
      finding in the JSON output:
      - `result` MUST be one of `CONFIRMED`/`REFUTED`/`INCONCLUSIVE`/`NOT_CHECKED`.
      - `evidence` MUST be a non-empty string, and `basis` MUST be one of
        `EXECUTED`/`STATIC_TRACE`/`SOURCE_CITATION`/`INFERENCE` (the same
        enum a verifier's own `Basis:` line uses) — UNLESS `result` is
        `NOT_CHECKED`, in which case both MUST be `null`.
      - `translate` refuses any finding missing `auditor_check`.
      - `translate` refuses `settled-refuted` when `result` is `CONFIRMED`,
        and refuses `settled-agree` when `result` is `REFUTED`.
      - `translate` refuses `settled-agree` UNLESS at least one of
        `independently_discovered`, a `conceded` peer response, or a
        `CONFIRMED` verification exists. `result: CONFIRMED` alone is NOT
        sufficient provenance here — unlike `settled-refuted`'s `REFUTED`
        route.
      - `translate` also refuses `settled-agree` when any peer response is
        `disputed-with-counter-fact`, UNLESS a `verifications[]` entry for
        that finding is `CONFIRMED`.
      - `translate` refuses `dropped-speculative` UNLESS the finding is
        genuinely SPECULATIVE, not independently discovered by both seats,
        unattacked by any peer response, `result` is not `CONFIRMED` or
        `REFUTED`, and it has no `verifications` entry.
      - `translate` refuses any finding whose `verifications[]` has a
        `CONFIRMED` verdict alongside `settled-refuted`, or a `REFUTED`
        verdict alongside `settled-agree`, for any origin.
   f. The auditor groups surviving claims into canonical findings per the
      protocol's Canonical findings section — only merging claims describing
      the SAME underlying defect; when in doubt, keep them separate. IDs are
      sequential integers only (`F1`, `F2`, `F3`, ...), never sub-lettered
      (`F8a`/`F8b`) — an origin claim describing two independent sub-defects
      is one over-broad claim, not two findings; put both under the one `F`
      instead. The auditor
      writes these as JSON per the `findings.json` schema, still under `X`/`Y`
      IDs. State this explicitly in the auditor's own task prompt: the
      returned JSON MUST be a top-level object with a `findings` array, e.g.
      `{"findings": [...]}`, never a bare array of finding objects —
      `translate` refuses a bare array outright (any other top-level keys,
      including `protocol`, are ignored on input and overwritten on output,
      so the auditor does not need to supply one). The auditor writes it to
      its output path; copy that file to `<run-dir>/phase3/findings.audit.json`.
      In `summary`/`recommended_fix`/`title` it never writes a claim ID
      (translate refuses one).
      Never record `settled-agree` on a finding with a
      `disputed-with-counter-fact` peer response unless a `CONFIRMED`
      `verifications[]` entry exists for it — its own `auditor_check.result:
      CONFIRMED` alone does not qualify.
   g. Run `scripts/blind-relabel.mjs translate --in findings.audit.json --out
      findings.json --mapping <run-dir>/phase3-private/seat-to-audit-label.json --phase1-dir <run-dir>/phase1
      [--verification-dir <phase3 dir>]` (the verification flag only when
      the Falsification pass ran) to produce the real-ID `findings.json`.
      This is the only supported way to produce it. Never hand-transcribe
      the auditor's `X`/`Y` output into real IDs. A nonzero exit means
      `findings.json` was not written; do not report synthesis complete
      until it exits 0.
   h. Build `joint-findings.md` (collaborate mode) or a scorecard
      (adversarial/independent mode) from the translated `findings.json`,
      one row per finding. Read its `independently_discovered` field; never
      re-derive it by hand.
   i. Write the manifest body with honest requested-versus-observed model
      and effort information, the `seat_to_audit_label` mapping, and the
      auditor model-family limitation (both seats and the auditor are
      Claude; this bounds but does not eliminate self-preference risk).
      Then run `scripts/build-manifest.mjs --in <that body> --out
      manifest.json` with `--task-packet`/`--phase1` (the `phase1/original/`
      copies)/`--phase2`/`--verification`/`--findings` pointing at whichever
      artifact files this run produced, plus `falsification.breakdown` from
      `audit-prep`'s output,
      to stamp a deterministic `run_id` and content hashes — see
      `review-protocol.md`'s Manifest and final output section. Never
      author `run_id` or `hashes` by hand.

A failed or unavailable seat means an incomplete review. Report what completed
and the failure; never label a single pass as a completed pair review.
