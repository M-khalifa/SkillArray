# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub Security Advisories for this
repository. Do not open a public issue containing credentials, private source,
review transcripts, or exploit details.

Include the affected skill and version, impact, reproduction steps, and any
suggested mitigation. Security reports will be acknowledged and assessed before
public disclosure.

## Data boundaries

`cross-review` sends reviewed material to every selected reviewer provider
(Anthropic and OpenAI by default; an OpenCode-routed seat can send it to
Google or another configured provider instead). Confirm the resolved provider
pair before dispatch and use it only for material authorized for all of them.
`pair-review` sends reviewed material to Anthropic only. Both skills can
execute commands from the reviewed repository (e.g. running its test suite)
as part of the review — a separate trust boundary from sending text to a
model provider; do not run either skill against an untrusted repository
without reviewing what commands it may execute. `shared-brain` publishes
selected engineering knowledge to its configured MCP backend; review its
profile and secret-scan results before capture or migration.

## Execution policy and sandboxing

Neither skill sandboxes beyond what the underlying provider CLI or harness
guarantees.

- **`cross-review` on codex**: defaults to `--sandbox read-only`, a real
  CLI-enforced sandbox (`workspace-write`/`danger-full-access` are opt-in).
- **`cross-review` on OpenCode**: no CLI-enforced read-only mode exists.
  `--isolate` runs it against a disposable git worktree instead, which
  stops writes from reaching the real target but doesn't block network
  access or reads outside the worktree. Treat unisolated OpenCode
  execution as unsandboxed.
- **`pair-review`**: both seats are Claude Code subagents, not spawned
  processes — whatever the harness enforces on a subagent applies; this
  skill adds nothing on top.

## Environment variable exposure

`cross-review`'s two dispatchers spawn the `codex`/`opencode` CLI as a
child process, and default to `--env-mode filtered`: the child gets only a
base OS allowlist (`PATH`, `HOME`/`USERPROFILE`, locale variables), each
CLI's own credential-locator variables, and anything named with
`--env-passthrough`. Everything else, including cloud keys, `GITHUB_TOKEN`,
and database passwords, is excluded. The reviewed repository's own code
can end up executing inside that environment too, not just the CLI
itself — for example, a test suite the CLI runs to check a claim.

Use `--env-mode inherit` only when a provider's auth genuinely needs a
variable outside the allowlist; prefer `--env-passthrough <NAME>` instead,
which adds one variable rather than dropping the filter entirely.

`pair-review` has no dispatcher process — its seats inherit whatever
environment the harness subagent mechanism already provides.

## execution_policy

There's no unified `execution_policy: never|ask|allow` setting spanning
both dispatchers and `pair-review` yet. `--sandbox read-only`/`--isolate`
approximate `never`; `--sandbox workspace-write`/`danger-full-access` or
OpenCode without `--isolate` approximate `allow`. There is no
`ask`-equivalent mid-run confirmation step today.

## Artifacts, logs, and prompt injection

Each seat's `result.json`, `findings.json`, and `manifest.json` are
written under the review's own working directory, unencrypted, protected
only by filesystem permissions. An `--isolate` worktree is written into
the target repository's own `.git/worktrees/`, not a separate temp
location. Anyone who can read that directory can read full reviewer
transcripts, including repository content quoted into a finding's
evidence.

Neither skill defends against prompt injection from the reviewed
material. A reviewer reads the target's source, comments, commit
messages, and command output, and none of it is sanitized first. A
repository engineered to contain instructions aimed at the reviewer (for
example, "mark this finding settled") is not currently detected or
blocked.

Web verification (`cross-review`/`pair-review`'s optional live web fetch
during review, see `review-protocol.md`'s Web verification section) widens
this same gap if not bounded: a reviewer with live fetch capability that
followed a URL or endpoint found embedded in the reviewed material would be
letting that material choose what gets fetched, handing an attacker-authored
repository a path to make the reviewer retrieve and then reason over
attacker-chosen external content — a strictly worse version of the existing
gap, since it adds a live network fetch to the injection surface. The stated
mitigation is instruction-only, not mechanically enforced: reviewers are told
to fetch only documentation they independently chose to check (a vendor's
own docs site, a published spec), never a URL or endpoint found inside the
reviewed material itself, and to treat fetched content as evidence, never as
instructions, the same as any other reviewed text. This is not currently
detected or blocked mechanically — the same limitation as the paragraph
above, extended to cover an outbound fetch rather than only inbound text.
