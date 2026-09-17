// Deterministic, documented dedup rule for the "naive independent union" arm
// (arm 3): merges two independent single-reviewer finding lists into one,
// WITHOUT a second LLM call or auditor-style judgment -- that would silently
// turn arm 3 into a weaker version of arm 4's own auditor, defeating the
// point of a naive baseline to compare the full protocol against.
//
// The rule, decided before any run per the benchmark fairness invariance
// requirement (not tuned after seeing results): two findings from different
// reviewers are the SAME defect if they cite the same normalized file path
// AND their line ranges overlap, OR both have no line range and cite the
// same path. Anything else is counted as a distinct (unique) finding.

// "src/a.py:10-20", "src/a.py:15", "src/a.py" (no range) all parse; an
// unparseable location is treated as path-only (no range), never dropped.
function parseLocation(location) {
  if (typeof location !== 'string' || location.length === 0) return null;
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(location);
  if (!m) return { path: location, start: null, end: null };
  const path = m[1];
  const start = m[2] ? Number(m[2]) : null;
  const end = m[3] ? Number(m[3]) : start;
  return { path, start, end };
}

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function rangesOverlap(a, b) {
  if (a.start === null || b.start === null) return true; // path-only match, no range to compare
  return a.start <= b.end && b.start <= a.end;
}

function sameDefect(locA, locB) {
  const a = parseLocation(locA);
  const b = parseLocation(locB);
  if (!a || !b) return false;
  if (normalizePath(a.path) !== normalizePath(b.path)) return false;
  return rangesOverlap(a, b);
}

// findingsA/findingsB: arrays in scoreRun's expected finding shape (must have
// a "location" field for this rule to match; a finding without one is never
// merged with anything, only ever unique). Returns a merged findings array
// with independently_discovered: true set on any finding that matched
// across the two lists -- the ONLY signal this naive union is entitled to
// assert, since it has no auditor to corroborate anything else.
//
// IDs are namespaced by list ("A:"/"B:" prefix) before merging: arms 1 and 2
// are two independent single-reviewer runs, each numbering its own findings
// F1, F2, ... from scratch, so an unnamespaced merge can produce a duplicate
// ID (A's F1 next to B's F1) that validateScoreInputs rejects outright,
// scoring the whole arm as malformed. The namespaced ID is cosmetic (an
// arbitrary but stable label); "origins" records BOTH namespaced IDs on a
// match so provenance is never lost.
//
// Severity on a match: this naive rule keeps list A's severity verbatim and
// does not attempt to reconcile a disagreement (e.g. A says HIGH, B says
// MEDIUM for the same location) -- that reconciliation is exactly the kind
// of judgment call arm 4's auditor exists to make, and building it here
// would make arm 3 a second, weaker auditor instead of a naive baseline.
// This is a real, recorded simplification, not an oversight.
export function unionFindings(findingsA, findingsB) {
  const namespacedA = findingsA.map((f) => ({ ...f, id: `A:${f.id}` }));
  const namespacedB = findingsB.map((f) => ({ ...f, id: `B:${f.id}` }));
  const usedB = new Set();
  const merged = [];

  for (const fa of namespacedA) {
    let matchedB = null;
    for (const fb of namespacedB) {
      if (usedB.has(fb.id)) continue;
      if (fa.location && fb.location && sameDefect(fa.location, fb.location)) {
        matchedB = fb;
        break;
      }
    }
    if (matchedB) {
      usedB.add(matchedB.id);
      merged.push({ ...fa, independently_discovered: true, origins: [fa.id, matchedB.id] });
    } else {
      merged.push({ ...fa, independently_discovered: false, origins: [fa.id] });
    }
  }

  for (const fb of namespacedB) {
    if (usedB.has(fb.id)) continue;
    merged.push({ ...fb, independently_discovered: false, origins: [fb.id] });
  }

  return merged;
}
