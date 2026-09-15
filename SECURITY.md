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
