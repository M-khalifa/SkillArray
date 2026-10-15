## Checks performed

- AC-1: Executed criterion, ticket, hypothesis, status, packet and removal probes covering bullets, tables, bold text, CRLF, case, identifier boundaries and incidental mentions. Defects in B2–B5, B8 and B11. NOT MET.
- AC-2: Compared one report object across text, markdown, HTML, JSON and chat; checked action groups, criterion summaries, code-fence widths and ANSI absence. Defects in B3, B5–B7 and B13. NOT MET.
- AC-3: All 52 files listed by the repository parity check are byte-identical. Shared claim-grouping instructions contradict themselves, as documented in B14. NOT MET.
- AC-4: Awaited subprocess termination for normal and closed-stdout failure probes. Normal argument and missing-descriptor exits were correct; closed stdout hid both failures, as documented in B1. NOT MET.
- AC-5: Consulted supplied pre-flight log: 855 passing tests in one package; 946 passing and two timing-sensitive failures in the other. Full regression execution was forbidden; compatibility remains incompletely verified, without an independently established regression. PARTIAL.
- AC-6: Inspected brief assembly and the ten-line output cap. The shared brief includes contradictory grouping instructions, as documented in B14. NOT MET.
- AC-7: Executed Windows drive-case, UNC-case, slash-style, sibling-directory, CRLF and in-memory BOM probes. Defects in B9 and B10. NOT MET.
- H1: Closed stdout changed failure exits to zero; report-file writes also follow stdout output. B1 records executed exit evidence and the additional static write-order trace. CONFIRMED.
- H2: Aggregated separate-cache usage with a short model alias produced zero fresh input and an unknown cache-write figure without a warning. B12. CONFIRMED.
- H3: Module-level warning deduplication exists, but an inaccessible repository emitted a warning rather than silently swallowing the error. Same-process reuse was not exercised; no complete operational defect established. PARTLY CONFIRMED.
- H4: Compound negations and question-plus-denial notes were misgrouped. Plain “not fixed, needs decision” and “fix deferred” parsed correctly; multilingual variants were not exercised. B5. PARTLY CONFIRMED.
- H5: Diagnostic verdict words and underscore look-alikes overrode terminal verdicts. Longer criterion tags remained distinct; incidental tag mentions still inflated coverage. B2 and B3. CONFIRMED.
- H6: Ticket-number prefixes with a hash worked. Evidence-first table rows, lowercase verdicts, lowercase prefixes and dash delimiters failed; a repeated later rejection was ignored because only the first matching line is read. B2 and B4. CONFIRMED.
- H7: Drive-case and UNC-case variants were missed; a sibling directory containing parentheses was incorrectly rewritten. Trailing separators are normalized by the CLI’s path resolution. B9. PARTLY CONFIRMED.
- H8: Range mappings retained removed criteria. Duplicate bullets, indented asterisk bullets, bracketed individual tags and emptied ticket lines passed. B8. PARTLY CONFIRMED.
- H9: The detail reader copies diagnostic text verbatim and caps it at 600 characters. No secret-bearing production failure output was examined, so a disclosure defect was not established. PARTLY CONFIRMED.
- H10: The conflicting rules occur both between documents and inside the shared protocol itself. B14. CONFIRMED.
- H11: Probed lowercase audited severity, an unresolved low-stakes state and null identifiers. Severity counts agreed across formats; the blocker divergence has the separate cause documented in B6. REFUTED.
- Selected existing parser/report tests: 9 passed, 0 failed. Syntax checks passed for six reviewed scripts.
- The preferred text-search utility was unavailable; searches used available read-only tooling. No installer or full suite was run.
- Reviewed HEAD 30fd93a and working-tree additions. No files created, edited or deleted; no commits, reviewers, servers or watchers started. Every spawned command ended before reporting.

web: 0 queries, 0 page fetches
