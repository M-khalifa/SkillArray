#!/usr/bin/env node
// Scores a review run's findings.json against a labeled ground-truth defect
// set. Real, tested code — the orchestration needed to actually RUN the
// arms being compared (see docs/design/benchmark-harness.md) is a separate,
// design-only deliverable and is not implemented here.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SEVERITY_WEIGHT = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const KNOWN_SEVERITIES = new Set(Object.keys(SEVERITY_WEIGHT));
const KNOWN_FINAL_STATES = new Set([
  'settled-agree',
  'settled-refuted',
  'unresolved-low-stakes',
  'unresolved-high-stakes',
  'dropped-speculative',
]);

function printUsageAndExit(code) {
  process.stderr.write(
    `Usage: node bench/score.mjs --findings <findings.json> --ground-truth <ground-truth.json> [--cost <usd>] [--json]\n\n` +
      `findings.json: this repo's real review output (see review-protocol.md's findings.json section).\n` +
      `ground-truth.json: { "defects": [ { "id": "...", "description": "...", "severity": "HIGH", "matches": ["substring or regex hint"] } ] }\n` +
      `  A ground-truth defect is counted as found if any finding's evidence, id, or a human-supplied\n` +
      `  explicit mapping (see --mapping below) identifies it. Automatic substring matching on evidence\n` +
      `  text is a weak heuristic; prefer explicit ground-truth-to-finding mapping when available.\n` +
      `--mapping <mapping.json>: optional { "defect_to_finding": { "<defect-id>": "<finding-id or null>" },\n` +
      `  "origin_to_defect": { "<origin-claim-id>": "<defect-id>" } }. defect_to_finding overrides\n` +
      `  substring-based auto-matching for the defects it lists; every referenced finding id must exist.\n` +
      `  origin_to_defect enables the canonicalization-false-merge-rate metric; every referenced origin\n` +
      `  must appear in at least one finding's origins.\n`
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = { findings: null, groundTruth: null, mapping: null, cost: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--findings') args.findings = argv[++i];
    else if (a === '--ground-truth') args.groundTruth = argv[++i];
    else if (a === '--mapping') args.mapping = argv[++i];
    else if (a === '--cost') {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isFinite(parsed) || parsed < 0) {
        process.stderr.write(`bench/score.mjs: --cost must be a finite number >= 0, got "${raw}"\n`);
        process.exit(2);
      }
      args.cost = parsed;
    } else if (a === '--json') args.json = true;
    else if (a === '-h' || a === '--help') printUsageAndExit(0);
    else printUsageAndExit(2);
  }
  if (!args.findings || !args.groundTruth) printUsageAndExit(2);
  return args;
}

// Fail-closed input validation. Throws a descriptive error rather than letting
// malformed input silently produce a wrong or impossible score (e.g. an
// explicit mapping pointing at a finding id that doesn't exist previously
// produced precision > 1 -- see bench/tests/score.test.mjs).
export function validateScoreInputs({ findings, defects, mapping, costUsd }) {
  const errors = [];

  const findingIds = new Set();
  for (const f of findings ?? []) {
    if (typeof f.id !== 'string' || f.id.length === 0) {
      errors.push(`finding has a missing or empty id: ${JSON.stringify(f)}`);
      continue;
    }
    if (findingIds.has(f.id)) errors.push(`duplicate finding id: "${f.id}"`);
    findingIds.add(f.id);
    if (f.severity !== undefined && !KNOWN_SEVERITIES.has(f.severity)) {
      errors.push(`finding "${f.id}" has unknown severity "${f.severity}"`);
    }
    if (f.final_state !== undefined && !KNOWN_FINAL_STATES.has(f.final_state)) {
      errors.push(`finding "${f.id}" has unknown final_state "${f.final_state}"`);
    }
  }

  const defectIds = new Set();
  for (const d of defects ?? []) {
    if (typeof d.id !== 'string' || d.id.length === 0) {
      errors.push(`defect has a missing or empty id: ${JSON.stringify(d)}`);
      continue;
    }
    if (defectIds.has(d.id)) errors.push(`duplicate defect id: "${d.id}"`);
    defectIds.add(d.id);
    if (d.severity !== undefined && !KNOWN_SEVERITIES.has(d.severity)) {
      errors.push(`defect "${d.id}" has unknown severity "${d.severity}"`);
    }
  }

  const defectToFinding = mapping?.defect_to_finding ?? {};
  for (const [defectId, findingId] of Object.entries(defectToFinding)) {
    if (!defectIds.has(defectId)) {
      errors.push(`mapping.defect_to_finding references unknown defect id "${defectId}"`);
    }
    if (findingId !== null && !findingIds.has(findingId)) {
      errors.push(
        `mapping.defect_to_finding["${defectId}"] references finding id "${findingId}", which does not exist in findings`
      );
    }
  }

  const originToDefect = mapping?.origin_to_defect ?? {};
  const knownOrigins = new Set((findings ?? []).flatMap((f) => f.origins ?? []));
  for (const [originId, defectId] of Object.entries(originToDefect)) {
    if (!knownOrigins.has(originId)) {
      errors.push(`mapping.origin_to_defect references origin id "${originId}", which does not appear in any finding's origins`);
    }
    if (!defectIds.has(defectId)) {
      errors.push(`mapping.origin_to_defect["${originId}"] references unknown defect id "${defectId}"`);
    }
  }

  if (costUsd !== null && costUsd !== undefined && !(Number.isFinite(costUsd) && costUsd >= 0)) {
    errors.push(`costUsd must be a finite number >= 0, got ${JSON.stringify(costUsd)}`);
  }

  if (errors.length > 0) {
    throw new Error(`bench/score.mjs: invalid scoring input:\n  - ${errors.join('\n  - ')}`);
  }
}

function findingText(finding) {
  return [finding.id, ...(finding.evidence ?? [])].join(' \n ').toLowerCase();
}

function isSurfaced(finding) {
  // review-protocol.md: a dropped-speculative finding is "retained in
  // findings.json for the artifact, never in the report's own findings
  // list" -- surfaced means "would appear in the human-facing report."
  return finding.final_state !== 'dropped-speculative';
}

// Matches each ground-truth defect against a candidate pool of findings.
// Returns { "<defect-id>": "<finding-id>" | null }. Pure, order-preserving:
// an explicit mapping entry always wins; otherwise the first candidate whose
// text contains one of the defect's substring hints wins.
function matchAgainstPool(defects, pool, explicitMapping) {
  const texts = pool.map((f) => findingText(f));
  const result = {};
  for (const defect of defects) {
    if (Object.hasOwn(explicitMapping, defect.id)) {
      const mappedId = explicitMapping[defect.id];
      // Honor the human's mapping only if it actually points into this pool;
      // otherwise this pass has nothing to match (the other pass may).
      result[defect.id] = mappedId !== null && pool.some((f) => f.id === mappedId) ? mappedId : null;
      continue;
    }
    const hints = (defect.matches ?? []).map((h) => h.toLowerCase());
    let matchedId = null;
    for (let i = 0; i < pool.length && matchedId === null; i++) {
      if (hints.some((h) => h.length > 0 && texts[i].includes(h))) {
        matchedId = pool[i].id;
      }
    }
    result[defect.id] = matchedId;
  }
  return result;
}

// Public helper retained for callers that only want "which finding, if any,
// found this defect" without the surfaced/dropped distinction scoreRun draws.
// Matches against ALL findings (surfaced and dropped) as one pool. Takes the
// same `mapping` shape as scoreRun ({ defect_to_finding: {...} }), not a bare
// mapping object, so both entry points share one contract.
export function matchDefectsToFindings(defects, findings, mapping = {}) {
  return matchAgainstPool(defects, findings, mapping.defect_to_finding ?? {});
}

// Core scoring function. Pure, synchronous, unit-testable without touching disk.
//
// Headline metrics (precision/recall/F1/severity-weighted recall/cost-per-
// confirmed-defect) are computed over the system's SURFACED output only --
// findings whose final_state is not "dropped-speculative" -- because that is
// what review-protocol.md defines as the report a user actually sees. A
// defect matched only by a dropped-speculative finding is a miss: the system
// found it internally and then filtered it out, which is a real failure mode
// (see false_dropped_speculative) and must not read as a confirmed defect.
export function scoreRun({ findings, defects, mapping = {}, costUsd = null }) {
  validateScoreInputs({ findings, defects, mapping, costUsd });

  const surfaced = findings.filter(isSurfaced);
  const dropped = findings.filter((f) => !isSurfaced(f));
  const explicitMapping = mapping.defect_to_finding ?? {};

  // Pass 1: match against surfaced findings only -- this is the headline result.
  const defectToFinding = matchAgainstPool(defects, surfaced, explicitMapping);

  // Pass 2: for defects the surfaced pool didn't find, check whether a dropped
  // finding actually had it (the drop lost a real defect) or nobody did.
  // defectToDroppedFinding only has keys for defects that reached pass 2 (those
  // unmatched by pass 1) -- unlike defectToFinding, which has one key per
  // defect. A caller must not assume both objects share the same key set.
  const stillUnmatched = defects.filter((d) => defectToFinding[d.id] === null);
  const defectToDroppedFinding = matchAgainstPool(stillUnmatched, dropped, explicitMapping);

  const matchedFindingIds = new Set(Object.values(defectToFinding).filter(Boolean));
  const matchedDroppedFindingIds = new Set(Object.values(defectToDroppedFinding).filter(Boolean));

  const truePositives = defects.filter((d) => defectToFinding[d.id] !== null);
  const falseNegatives = defects.filter((d) => defectToFinding[d.id] === null);
  const falsePositives = surfaced.filter((f) => !matchedFindingIds.has(f.id));

  const precision = surfaced.length > 0 ? matchedFindingIds.size / surfaced.length : null;
  const recall = defects.length > 0 ? truePositives.length / defects.length : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  const totalSeverityWeight = defects.reduce((sum, d) => sum + (SEVERITY_WEIGHT[d.severity] ?? 0), 0);
  const foundSeverityWeight = truePositives.reduce((sum, d) => sum + (SEVERITY_WEIGHT[d.severity] ?? 0), 0);
  const severityWeightedRecall = totalSeverityWeight > 0 ? foundSeverityWeight / totalSeverityWeight : null;

  const corroborated = surfaced.filter((f) => f.independently_discovered === true);
  const corroboratedMatched = corroborated.filter((f) => matchedFindingIds.has(f.id));
  const independentlyCorroboratedPrecision =
    corroborated.length > 0 ? corroboratedMatched.length / corroborated.length : null;

  // A dropped finding is "true" (correctly filtered noise) unless a defect was
  // matched to it in pass 2, in which case the drop lost a real defect ("false").
  const trueDroppedSpeculative = dropped.filter((f) => !matchedDroppedFindingIds.has(f.id));
  const falseDroppedSpeculative = dropped.filter((f) => matchedDroppedFindingIds.has(f.id));

  const unresolvedHighCritical = findings.filter(
    (f) =>
      (f.final_state === 'unresolved-high-stakes' || f.final_state === 'unresolved-low-stakes') &&
      (f.severity === 'HIGH' || f.severity === 'CRITICAL')
  );

  const multiOriginFindings = surfaced.filter((f) => (f.origins ?? []).length > 1);
  // A canonicalization false-merge: a multi-origin finding whose origins actually
  // map to DIFFERENT ground-truth defects (or one origin maps to a real defect and
  // another maps to nothing) is evidence the auditor merged unrelated claims.
  // This requires an origin-to-defect mapping, which callers may not always supply;
  // when absent, this metric is reported as null rather than guessed at.
  let canonicalizationFalseMergeRate = null;
  const originToDefect = mapping.origin_to_defect;
  if (originToDefect) {
    const merges = multiOriginFindings.map((f) => {
      const defectIds = new Set((f.origins ?? []).map((o) => originToDefect[o] ?? null));
      return defectIds.size > 1;
    });
    canonicalizationFalseMergeRate =
      multiOriginFindings.length > 0 ? merges.filter(Boolean).length / multiOriginFindings.length : null;
  }

  const confirmedCount = truePositives.length;
  const costPerConfirmedDefect =
    costUsd !== null && confirmedCount > 0 ? costUsd / confirmedCount : null;

  return {
    counts: {
      total_findings: findings.length,
      surfaced_findings: surfaced.length,
      dropped_speculative_findings: dropped.length,
      total_defects: defects.length,
      true_positives: truePositives.length,
      false_negatives: falseNegatives.length,
      false_positives: falsePositives.length,
    },
    precision,
    recall,
    f1,
    severity_weighted_recall: severityWeightedRecall,
    independently_corroborated_finding_precision: independentlyCorroboratedPrecision,
    true_dropped_speculative: trueDroppedSpeculative.length,
    false_dropped_speculative: falseDroppedSpeculative.length,
    unresolved_high_critical_count: unresolvedHighCritical.length,
    unresolved_high_critical_ids: unresolvedHighCritical.map((f) => f.id),
    canonicalization_false_merge_rate: canonicalizationFalseMergeRate,
    cost_usd: costUsd,
    cost_per_confirmed_defect: costPerConfirmedDefect,
    defect_to_finding: defectToFinding,
    defect_to_dropped_finding: defectToDroppedFinding,
    false_positive_finding_ids: falsePositives.map((f) => f.id),
  };
}

// Computes empirical reliability tables (Phase N): P(valid | evidence characteristics),
// derived from one or more already-scored runs where ground truth is known. This is
// NOT model self-confidence -- every input here is externally verified against a
// labeled defect set, never a model's own stated confidence.
//
// Takes scoreRun's result fields (defect_to_finding, defect_to_dropped_finding)
// plus the findings array it was scored from -- scoreRun itself does not
// return findings, so a caller spreads its own findings array in alongside
// scoreRun's output: { ...scoreRun(...), findings }. A finding counts as
// valid if it matched a real defect through EITHER pool -- a
// correctly-dropped-but-real SPECULATIVE claim is still meaningful
// calibration data about its evidence characteristics, not noise to discard.
export function calibrationTable(scoredRuns) {
  const buckets = new Map(); // key: "basis|evidence_strength|verifierConfirmed|independentlyDiscovered" -> {valid, total}
  for (const run of scoredRuns) {
    if (!run.defect_to_finding && !run.defect_to_dropped_finding) continue;
    const validIds = new Set([
      ...Object.values(run.defect_to_finding ?? {}).filter(Boolean),
      ...Object.values(run.defect_to_dropped_finding ?? {}).filter(Boolean),
    ]);
    for (const finding of run.findings) {
      const isValid = validIds.has(finding.id);
      const verifierConfirmed = (finding.verifications ?? []).some((v) => v.verdict === 'CONFIRMED');
      const key = JSON.stringify({
        basis: finding.basis,
        evidence_strength: finding.evidence_strength,
        verifier_confirmed: verifierConfirmed,
        independently_discovered: finding.independently_discovered === true,
      });
      const bucket = buckets.get(key) ?? { valid: 0, total: 0 };
      bucket.total += 1;
      if (isValid) bucket.valid += 1;
      buckets.set(key, bucket);
    }
  }
  const table = [];
  for (const [key, { valid, total }] of buckets) {
    table.push({ ...JSON.parse(key), n: total, p_valid: total > 0 ? valid / total : null });
  }
  return table.sort((a, b) => b.n - a.n);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const findingsDoc = JSON.parse(await readFile(args.findings, 'utf8'));
  const groundTruth = JSON.parse(await readFile(args.groundTruth, 'utf8'));
  const mapping = args.mapping ? JSON.parse(await readFile(args.mapping, 'utf8')) : {};

  const result = scoreRun({
    findings: findingsDoc.findings ?? [],
    defects: groundTruth.defects ?? [],
    mapping,
    costUsd: args.cost,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(
      [
        `Findings: ${result.counts.total_findings} (${result.counts.surfaced_findings} surfaced, ${result.counts.dropped_speculative_findings} dropped-speculative), Defects: ${result.counts.total_defects}`,
        `TP: ${result.counts.true_positives}  FN: ${result.counts.false_negatives}  FP: ${result.counts.false_positives}`,
        `Precision: ${fmt(result.precision)}  Recall: ${fmt(result.recall)}  F1: ${fmt(result.f1)}`,
        `Severity-weighted recall: ${fmt(result.severity_weighted_recall)}`,
        `Independently-corroborated finding precision: ${fmt(result.independently_corroborated_finding_precision)}`,
        `Dropped-speculative: ${result.true_dropped_speculative} correctly filtered, ${result.false_dropped_speculative} lost a real defect`,
        `Unresolved HIGH/CRITICAL: ${result.unresolved_high_critical_count} (${result.unresolved_high_critical_ids.join(', ') || 'none'})`,
        result.cost_usd !== null ? `Cost: $${result.cost_usd.toFixed(2)}  Cost/confirmed defect: ${fmt(result.cost_per_confirmed_defect, '$')}` : null,
      ]
        .filter(Boolean)
        .join('\n') + '\n'
    );
  }
}

function fmt(n, prefix = '') {
  return n === null ? 'n/a' : `${prefix}${(n * (prefix ? 1 : 100)).toFixed(prefix ? 2 : 1)}${prefix ? '' : '%'}`;
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`bench/score.mjs: ${err.message}\n`);
    process.exit(1);
  });
}
