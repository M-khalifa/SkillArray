# Fixture Review Target (no seat vocabulary)

A checked-in stand-in target for scan tests that need `--target-dir` to point
at something that names vendor tokens (claude, anthropic, codex, openai, gpt-,
opencode, fable, opus) but never uses seat vocabulary anywhere in its own
docs, so a scan against it proves the seat-vocabulary exemption stays false
for an ordinary (non-review-protocol) target even when vendor tokens are
legitimately target-derived. This provider catalog lists gpt-5.6-sol as a
supported model, so a scan citing that exact model ID via --tokens is also
target-derived. This gives the reviewer a chance to see ordinary ambiguous
prose land in a real target's own docs without unlocking seat vocabulary.
