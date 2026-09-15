# Model and effort validation

Do not ship a fixed model catalog as an entitlement list. Model names, supported
effort levels, aliases, and access vary by account, provider, and harness version.
Resolve availability at setup and revalidate before each review.

## Claude-harness seat

Inspect the current harness's model-selection interface and tool schema.
A model available to the main chat is not necessarily selectable for a subagent.
Use the supported per-agent model field; never use a prompt instruction as a
substitute for selecting the runtime model.

Explicit effort requires a supported runtime setting. Claude Code documents
effort in custom subagent definitions; this does not mean every Agent tool
invocation accepts an effort argument. Use a supported definition or runtime
mechanism without modifying unrelated agent definitions. If unavailable, explain
the limitation and ask the user to choose default effort or another supported
runtime. Do not drop the requested effort.

Check model-forcing environment settings and organization restrictions.
Verify the actual agent model through runtime metadata when available; do not
trust an alias alone. Pair-review must not resolve both seats to the same model.
If exact identity is unobservable, record it as unverified rather than inventing
a pinned ID.

Source: [Claude Code subagent configuration](https://code.claude.com/docs/en/sub-agents).
Runtime behavior takes precedence over examples; inspect the installed version.

Fable is a selectable Claude-harness candidate when the installed model picker
exposes it. Do not claim it is available merely because it appears in setup.

## Codex seat

Verify CLI help and model availability in the installed CLI. Read only relevant
nonsecret model/provider configuration if needed; do not dump authentication files.
When Codex is selected, the provider must be OpenAI, not merely a model name
resembling GPT. Current curated choices are `gpt-6-astra`, `gpt-5.6-sol`,
`gpt-5.6-terra`, and `gpt-5.6-luna`. The installed CLI and account entitlement
remain authoritative.

The bundled dispatcher forwards:
- `--model MODEL` to Codex's `--model MODEL`.
- `--effort LEVEL` to `-c model_reasoning_effort=LEVEL`.
- Both options on fresh and exact-session resumed runs.

The dispatcher validates safe token syntax, not the changing list of model
capabilities. Validate support before dispatch; if a choice is unsupported,
stop the review rather than retrying without the requested option. The runtime
may reject, ignore, or normalize unsupported settings; this behavior has not
been verified here. A successful exit does not establish that the requested
effort took effect. Use `default` only in the preferences helper; omit
`--effort` at dispatch for that setting.

Sources: [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
and [configuration reference](https://developers.openai.com/codex/config-reference).
Run local CLI help before dispatch; no release-specific model default is assumed.

## OpenCode seats

OpenCode is an explicit bridge for configured providers such as Google, xAI,
Mistral, Moonshot, DeepSeek, or OpenRouter, plus vendors OpenCode itself bundles
(e.g. a provider literally named `opencode`, confirmed via `opencode models`).
Run `opencode models` during setup and use only the provider/model IDs it
advertises. Do not assume a configured credential, or silently substitute
OpenCode when the user selected another runtime.

**No CLI-level read-only sandbox flag exists for OpenCode, verified.** `opencode
run --help` (v1.18.25) has no `--sandbox`/`--read-only` flag; the closest option
is `--auto` (auto-approve permissions), which is the opposite of a restriction,
not a safety mechanism, and is never passed by this skill. OpenCode's permission
model is per-agent/config-based, not a dispatch-time flag this skill's
dispatcher can force directly. `opencode-dispatch.mjs`'s `--isolate` instead
redirects the run into a disposable `git worktree` copy of the target: real
prevention, since edits land there rather than in the reviewed source. This is
what `review-protocol.md`'s read-only guarantee actually rests on for an
OpenCode seat; the dispatcher itself refuses to run at all (hard stop, `status:
"error"`) if `--isolate` was requested and isolation cannot be set up (target
not a git repo, or worktree setup fails), rather than silently falling back to
running unisolated. `touchedFiles` remains a secondary, detection-after-the-fact
check on top of that, not the primary guarantee. Treat any non-empty
`touchedFiles` from an OpenCode seat as a real incident requiring investigation,
not a benign log line. `git worktree add` still writes bookkeeping under the
target's own `.git/worktrees/`: housekeeping, not a source write, and never
visible in the target's `git status`; Phase 3 cleanup removes it.

`--isolate` requires `--cd` to be a git repository ROOT; a subdirectory is
refused outright rather than silently isolating a wrong, partially-copied
worktree (untracked files under the subdirectory would land at the wrong
depth relative to a full-repo worktree, and files outside it would never be
copied or fingerprinted at all).

Reusing a worktree across phases (same `--cd`, same run directory) is gated on
a fingerprint of the target snapshot (repo toplevel, `HEAD` sha, a sha256 of
the binary `git diff HEAD`, and per-file content hashes for untracked files),
stored in the sibling marker as JSON and recomputed on every call. A mismatch
— a different target repo entirely, or the same target having drifted since
the worktree was built — is refused (`ok:false`, a `status:"error"` dispatch)
rather than silently served stale or silently rebuilt; either would let an
isolated seat review content the orchestrator does not believe it is
reviewing. An untracked directory that is itself a git repository cannot be
copied file-by-file into the worktree; it is skipped and named in the
dispatcher's `isolationNote` field rather than causing setup to fail. This is
correct for what it does (nothing is silently mis-copied), but it is also a real
blind spot: the fingerprint hashes nothing ABOUT that nested repo either, so an
edit to a tracked file inside it, or a commit inside it, between phases is
invisible to drift detection — same class of gap as the gitignored-file blind
spot above, not something this dispatcher currently detects or refuses.

The fingerprint is also computed BEFORE the worktree copy runs, not after: a
write to the target between the fingerprint read and the copy completing is not
detected by anything in this dispatcher (a TOCTOU gap). Treat both the source and
the worktree as read-only for the duration of a dispatch to avoid depending on
this window being short in practice.

The untracked-file scan uses `git ls-files --others --exclude-standard`, so a
gitignored file is excluded from both the fingerprint and the worktree copy: an
edit to a gitignored file between phases is invisible to drift detection and is
never reflected in the isolated worktree. This matches the reviewed target's own
`git status`, which also treats gitignored files as not part of the tree, but is
worth stating explicitly since it is a real blind spot, not an oversight.

A worktree path that already contains something when no marker is present is
never assumed safe to overwrite: a plain directory of unrelated content is
refused outright, and a directory that is itself a git worktree is refused
unless its own `.git` gitdir pointer resolves back under the CURRENT target's
git directory (the legitimate case: a marker lost to a crash or manual
deletion, not a different repository's worktree left at the same path).

An OpenCode seat's declared `provider` must prefix its `model` ID (case-insensitively,
e.g. `google` with `google/gemini-3-pro`); a mismatch is rejected outright rather than
silently accepted, since `provider` is otherwise a free-standing label dispatch never
uses to route. This still does not close every gap: an aggregator provider (e.g.
`openrouter/anthropic/claude-...`) can satisfy the prefix check while still routing to
another seat's vendor underneath — using an aggregator for cross-vendor validation is
the user's responsibility, not something this check can detect.

## Reporting

Separate requested, passed, and observed settings. A successful process exit or
an echoed request is not proof of the server's exact model or effort. Record
unknown resolved fields as `null` with a verification note. Never claim a
particular default effort without runtime evidence.

Choose effort deliberately. Do not raise effort, select a more expensive model,
or rewrite global configuration automatically because the target seems difficult.
The user's saved or explicit choice controls the run.
