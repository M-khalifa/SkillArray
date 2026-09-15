import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRun, matchDefectsToFindings, calibrationTable, validateScoreInputs } from '../score.mjs';

function finding(overrides = {}) {
  return {
    id: 'F1',
    origins: ['A1'],
    independently_discovered: false,
    severity: 'HIGH',
    basis: 'EXECUTED',
    evidence_strength: 'REPRODUCED',
    peer_responses: [],
    auditor_check: { result: 'NOT_CHECKED', basis: null, evidence: null },
    final_state: 'unresolved-low-stakes',
    evidence: ['some evidence text'],
    ...overrides,
  };
}

test('matchDefectsToFindings: explicit mapping overrides substring auto-matching', () => {
  const defects = [{ id: 'D1', matches: ['nothing that appears anywhere'] }];
  const findings = [finding({ id: 'F1', evidence: ['unrelated text'] })];
  const result = matchDefectsToFindings(defects, findings, { defect_to_finding: { D1: 'F1' } });
  assert.deepEqual(result, { D1: 'F1' });
});

test('matchDefectsToFindings: substring hint matches against finding id and evidence text', () => {
  const defects = [{ id: 'D1', matches: ['off-by-one'] }];
  const findings = [finding({ id: 'F1', evidence: ['confirmed an off-by-one in the cursor'] })];
  const result = matchDefectsToFindings(defects, findings);
  assert.equal(result.D1, 'F1');
});

test('matchDefectsToFindings: a defect with no matching finding maps to null, not a guess', () => {
  const defects = [{ id: 'D1', matches: ['nothing matches this'] }];
  const findings = [finding({ id: 'F1', evidence: ['totally unrelated'] })];
  const result = matchDefectsToFindings(defects, findings);
  assert.equal(result.D1, null);
});

test('scoreRun: perfect match yields precision 1, recall 1, f1 1', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['xyz'] }];
  const findings = [finding({ id: 'F1', evidence: ['found xyz bug'] })];
  const result = scoreRun({ findings, defects });
  assert.equal(result.precision, 1);
  assert.equal(result.recall, 1);
  assert.equal(result.f1, 1);
  assert.equal(result.counts.true_positives, 1);
  assert.equal(result.counts.false_positives, 0);
  assert.equal(result.counts.false_negatives, 0);
});

test('scoreRun: a finding matching no ground-truth defect counts as a false positive, not silently dropped', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['xyz'] }];
  const findings = [
    finding({ id: 'F1', evidence: ['found xyz bug'] }),
    finding({ id: 'F2', evidence: ['a real-looking but unverifiable claim'] }),
  ];
  const result = scoreRun({ findings, defects });
  assert.equal(result.counts.false_positives, 1);
  assert.deepEqual(result.false_positive_finding_ids, ['F2']);
  assert.equal(result.precision, 0.5);
});

test('scoreRun: an undiscovered defect counts as a false negative and lowers recall', () => {
  const defects = [
    { id: 'D1', severity: 'HIGH', matches: ['xyz'] },
    { id: 'D2', severity: 'HIGH', matches: ['never found'] },
  ];
  const findings = [finding({ id: 'F1', evidence: ['found xyz bug'] })];
  const result = scoreRun({ findings, defects });
  assert.equal(result.counts.false_negatives, 1);
  assert.equal(result.recall, 0.5);
});

test('scoreRun: severity-weighted recall weighs a missed CRITICAL defect more than a missed LOW one', () => {
  const defects = [
    { id: 'D1', severity: 'CRITICAL', matches: ['never found critical'] },
    { id: 'D2', severity: 'LOW', matches: ['found low'] },
  ];
  const findings = [finding({ id: 'F1', evidence: ['found low severity issue'] })];
  const result = scoreRun({ findings, defects });
  // total weight = 4 (CRITICAL) + 1 (LOW) = 5; found weight = 1 (LOW only)
  assert.equal(result.severity_weighted_recall, 1 / 5);
  // plain recall would be 0.5 -- confirms this is a genuinely different, harsher metric
  assert.equal(result.recall, 0.5);
});

test('scoreRun: independently-corroborated finding precision only scores findings marked independently_discovered', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['real bug'] }];
  const findings = [
    finding({ id: 'F1', independently_discovered: true, evidence: ['real bug found by both'] }),
    finding({ id: 'F2', independently_discovered: false, evidence: ['single-origin claim'] }),
  ];
  const result = scoreRun({ findings, defects });
  // Only F1 is independently_discovered and only F1 matched a real defect.
  assert.equal(result.independently_corroborated_finding_precision, 1);
});

test('scoreRun: a false corroborated finding (independently_discovered but unmatched) drags corroborated precision down', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['real bug'] }];
  const findings = [
    finding({ id: 'F1', independently_discovered: true, evidence: ['real bug found by both'] }),
    finding({ id: 'F2', independently_discovered: true, evidence: ['both reviewers agreed but were wrong'] }),
  ];
  const result = scoreRun({ findings, defects });
  assert.equal(result.independently_corroborated_finding_precision, 0.5);
});

test('scoreRun: dropped-speculative findings are split into true (correctly dropped) vs false (wrongly dropped a real defect)', () => {
  const defects = [{ id: 'D1', severity: 'LOW', matches: ['actually real'] }];
  const findings = [
    finding({ id: 'F1', final_state: 'dropped-speculative', evidence: ['a genuinely speculative guess'] }),
    finding({ id: 'F2', final_state: 'dropped-speculative', evidence: ['actually real defect wrongly dropped'] }),
  ];
  const result = scoreRun({ findings, defects });
  assert.equal(result.true_dropped_speculative, 1);
  assert.equal(result.false_dropped_speculative, 1);
});

test('scoreRun: unresolved HIGH/CRITICAL findings are counted and named, MEDIUM/LOW unresolved are not', () => {
  const defects = [];
  const findings = [
    finding({ id: 'F1', severity: 'HIGH', final_state: 'unresolved-high-stakes' }),
    finding({ id: 'F2', severity: 'CRITICAL', final_state: 'unresolved-low-stakes' }),
    finding({ id: 'F3', severity: 'MEDIUM', final_state: 'unresolved-low-stakes' }),
  ];
  const result = scoreRun({ findings, defects });
  assert.equal(result.unresolved_high_critical_count, 2);
  assert.deepEqual(result.unresolved_high_critical_ids.sort(), ['F1', 'F2']);
});

test('scoreRun: canonicalization false-merge rate is null without an origin-to-defect mapping, not a guessed 0', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['xyz'] }];
  const findings = [finding({ id: 'F1', origins: ['A1', 'B2'], evidence: ['xyz'] })];
  const result = scoreRun({ findings, defects });
  assert.equal(result.canonicalization_false_merge_rate, null);
});

test('scoreRun: canonicalization false-merge rate flags a multi-origin finding whose origins map to different defects', () => {
  const defects = [
    { id: 'D1', severity: 'HIGH', matches: ['xyz'] },
    { id: 'D2', severity: 'HIGH', matches: ['xyz'] }, // deliberately same hint text; mapping below disambiguates
  ];
  const findings = [finding({ id: 'F1', origins: ['A1', 'B2'], evidence: ['xyz'] })];
  const result = scoreRun({
    findings,
    defects,
    mapping: { origin_to_defect: { A1: 'D1', B2: 'D2' } },
  });
  assert.equal(result.canonicalization_false_merge_rate, 1);
});

test('scoreRun: cost-per-confirmed-defect is null when no cost is supplied, never divides by zero silently as 0', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['xyz'] }];
  const findings = [finding({ id: 'F1', evidence: ['xyz'] })];
  const noCost = scoreRun({ findings, defects });
  assert.equal(noCost.cost_per_confirmed_defect, null);

  const withCost = scoreRun({ findings, defects, costUsd: 4.5 });
  assert.equal(withCost.cost_per_confirmed_defect, 4.5);
});

test('scoreRun: cost-per-confirmed-defect is null (not Infinity) when cost is given but zero defects were confirmed', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['never matches'] }];
  const findings = [finding({ id: 'F1', evidence: ['unrelated'] })];
  const result = scoreRun({ findings, defects, costUsd: 10 });
  assert.equal(result.counts.true_positives, 0);
  assert.equal(result.cost_per_confirmed_defect, null);
});

test('scoreRun: precision and recall are null (not 0) for an empty findings or defects set, since 0/0 is undefined, not zero performance', () => {
  const emptyFindings = scoreRun({ findings: [], defects: [{ id: 'D1', severity: 'HIGH', matches: ['x'] }] });
  assert.equal(emptyFindings.precision, null);
  assert.equal(emptyFindings.recall, 0);

  const emptyDefects = scoreRun({ findings: [finding()], defects: [] });
  assert.equal(emptyDefects.recall, null);
});

test('calibrationTable: buckets findings by evidence characteristics and computes P(valid) per bucket from real ground truth', () => {
  const runA = {
    findings: [
      finding({ id: 'F1', basis: 'EXECUTED', evidence_strength: 'REPRODUCED', independently_discovered: true }),
      finding({ id: 'F2', basis: 'EXECUTED', evidence_strength: 'REPRODUCED', independently_discovered: true }),
      finding({ id: 'F3', basis: 'INFERENCE', evidence_strength: 'SUPPORTED', independently_discovered: false }),
    ],
    defect_to_finding: { D1: 'F1', D2: 'F2' }, // F3 unmatched -- was a false positive
    defect_to_dropped_finding: {},
  };
  const table = calibrationTable([runA]);
  const executedBucket = table.find((b) => b.basis === 'EXECUTED' && b.evidence_strength === 'REPRODUCED');
  const inferenceBucket = table.find((b) => b.basis === 'INFERENCE');
  assert.equal(executedBucket.n, 2);
  assert.equal(executedBucket.p_valid, 1);
  assert.equal(inferenceBucket.n, 1);
  assert.equal(inferenceBucket.p_valid, 0);
});

test('calibrationTable: a run with no defect_to_finding/defect_to_dropped_finding mapping (ground truth unknown) contributes nothing, never a fabricated P(valid)', () => {
  const runWithoutGroundTruth = {
    findings: [finding({ id: 'F1' })],
    defect_to_finding: null,
    defect_to_dropped_finding: null,
  };
  const table = calibrationTable([runWithoutGroundTruth]);
  assert.deepEqual(table, []);
});

test('calibrationTable: accepts scoreRun\'s own output shape directly, and counts a validly-matched dropped-speculative finding as valid calibration data', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['real but dropped'] }];
  const findings = [
    finding({ id: 'F1', final_state: 'dropped-speculative', basis: 'STATIC_TRACE', evidence_strength: 'SUPPORTED', evidence: ['real but dropped defect'] }),
  ];
  const scored = scoreRun({ findings, defects });
  // calibrationTable needs the findings array alongside scoreRun's own result
  // fields (defect_to_finding/defect_to_dropped_finding); a real caller has
  // both on hand from the same scoring call.
  const table = calibrationTable([{ ...scored, findings }]);
  const bucket = table.find((b) => b.basis === 'STATIC_TRACE');
  assert.ok(bucket, 'expected a bucket for the dropped-but-matched finding');
  assert.equal(bucket.n, 1);
  assert.equal(bucket.p_valid, 1);
});

// -- Headline metrics must reflect the system's SURFACED output, not internal
// claim existence. review-protocol.md: dropped-speculative findings are
// "retained in findings.json for the artifact, never in the report's own
// findings list." A defect matched only by a dropped-speculative finding is a
// miss in the headline numbers, tracked separately as false_dropped_speculative.

test('scoreRun: a defect matched ONLY by a dropped-speculative finding is a false negative in headline recall, not a true positive', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['off-by-one'] }];
  const findings = [
    finding({ id: 'F1', final_state: 'dropped-speculative', evidence: ['off-by-one bug found but dropped as speculative'] }),
  ];
  const result = scoreRun({ findings, defects, costUsd: 10 });
  assert.equal(result.counts.true_positives, 0);
  assert.equal(result.counts.false_negatives, 1);
  assert.equal(result.recall, 0);
  assert.equal(result.severity_weighted_recall, 0);
  assert.equal(result.cost_per_confirmed_defect, null, 'a dropped-only match must not improve cost-per-confirmed-defect');
  assert.equal(result.false_dropped_speculative, 1, 'the drop lost a real defect');
  assert.equal(result.true_dropped_speculative, 0);
  assert.deepEqual(result.defect_to_finding, { D1: null });
  assert.deepEqual(result.defect_to_dropped_finding, { D1: 'F1' });
});

test('scoreRun: an unmatched dropped-speculative finding is correctly-filtered noise, not a headline false positive', () => {
  const defects = [];
  const findings = [
    finding({ id: 'F1', final_state: 'dropped-speculative', evidence: ['a genuinely speculative guess matching nothing'] }),
  ];
  const result = scoreRun({ findings, defects });
  assert.equal(result.counts.false_positives, 0, 'dropped findings are excluded from the surfaced false-positive pool entirely');
  assert.equal(result.true_dropped_speculative, 1);
  assert.equal(result.false_dropped_speculative, 0);
});

test('scoreRun: a defect matched by a SURFACED finding counts as a true positive even if a dropped finding also happens to match its hint text', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['xyz'] }];
  const findings = [
    finding({ id: 'F1', final_state: 'dropped-speculative', evidence: ['xyz mentioned here too'] }),
    finding({ id: 'F2', final_state: 'unresolved-low-stakes', evidence: ['xyz confirmed'] }),
  ];
  const result = scoreRun({ findings, defects });
  assert.equal(result.counts.true_positives, 1);
  assert.equal(result.defect_to_finding.D1, 'F2', 'surfaced pool is matched first, independent of array order');
  assert.equal(result.true_dropped_speculative, 1, 'the dropped finding matched nobody once the defect was already satisfied by the surfaced one');
  assert.equal(result.recall, 1);
});

test('scoreRun: precision denominator is the SURFACED finding count, excluding dropped-speculative findings entirely', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['xyz'] }];
  const findings = [
    finding({ id: 'F1', final_state: 'unresolved-low-stakes', evidence: ['xyz confirmed'] }),
    finding({ id: 'F2', final_state: 'dropped-speculative', evidence: ['unrelated speculative noise'] }),
  ];
  const result = scoreRun({ findings, defects });
  assert.equal(result.counts.surfaced_findings, 1);
  assert.equal(result.counts.dropped_speculative_findings, 1);
  assert.equal(result.precision, 1, 'F2 is excluded from the denominator, not counted as an unmatched surfaced finding');
});

test('scoreRun: an explicit mapping pointing a defect at a DROPPED finding still yields a false negative plus false_dropped_speculative, not a silent re-match', () => {
  const defects = [{ id: 'D1', severity: 'CRITICAL', matches: ['never auto-matches'] }];
  const findings = [
    finding({ id: 'F1', final_state: 'dropped-speculative', evidence: ['the real defect, but dropped'] }),
  ];
  const result = scoreRun({
    findings,
    defects,
    mapping: { defect_to_finding: { D1: 'F1' } },
  });
  assert.equal(result.counts.true_positives, 0);
  assert.equal(result.counts.false_negatives, 1);
  assert.equal(result.recall, 0);
  assert.equal(result.false_dropped_speculative, 1);
  assert.deepEqual(result.defect_to_dropped_finding, { D1: 'F1' });
});

test('scoreRun: precision is null (not 0) when every finding is dropped-speculative, since there is no surfaced denominator', () => {
  const defects = [{ id: 'D1', severity: 'LOW', matches: ['xyz'] }];
  const findings = [finding({ id: 'F1', final_state: 'dropped-speculative', evidence: ['xyz'] })];
  const result = scoreRun({ findings, defects });
  assert.equal(result.counts.surfaced_findings, 0);
  assert.equal(result.precision, null);
});

test('scoreRun: an explicit mapping.defect_to_finding entry of null means "human asserts not found" and is a false negative, even when a dropped finding\'s text would otherwise substring-match it', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['this hint would otherwise match'] }];
  const findings = [
    finding({ id: 'F1', final_state: 'dropped-speculative', evidence: ['this hint would otherwise match'] }),
  ];
  const result = scoreRun({
    findings,
    defects,
    mapping: { defect_to_finding: { D1: null } },
  });
  assert.equal(result.counts.false_negatives, 1);
  assert.equal(result.defect_to_finding.D1, null);
  assert.equal(
    result.defect_to_dropped_finding.D1,
    null,
    'an explicit null must short-circuit pass 2\'s substring matching too, not just pass 1'
  );
  assert.equal(result.true_dropped_speculative, 1, 'the dropped finding is untouched by the explicit null, so it is correctly-filtered noise');
});

// -- Fail-closed input validation. An explicit mapping referencing a finding id
// that does not exist previously produced an impossible score (precision > 1);
// see the "previously produced precision 2.0" test below for the exact repro.

test('validateScoreInputs: rejects an explicit mapping pointing at a finding id that does not exist', () => {
  const defects = [{ id: 'D1', severity: 'HIGH' }];
  const findings = [finding({ id: 'F1' })];
  assert.throws(
    () => validateScoreInputs({ findings, defects, mapping: { defect_to_finding: { D1: 'F999' } }, costUsd: null }),
    /references finding id "F999", which does not exist/
  );
});

test('scoreRun: throws (fail-closed) rather than silently scoring, on a mapping referencing a nonexistent finding', () => {
  const defects = [{ id: 'D1', severity: 'HIGH', matches: ['xyz'] }];
  const findings = [finding({ id: 'F1', evidence: ['unrelated to xyz'] })];
  assert.throws(() => scoreRun({ findings, defects, mapping: { defect_to_finding: { D1: 'F999' } } }));
});

test('regression: two defects explicitly mapped to two different nonexistent finding ids previously produced precision 2.0 -- an impossible score -- now throws instead', () => {
  const defects = [
    { id: 'D1', severity: 'HIGH' },
    { id: 'D2', severity: 'HIGH' },
  ];
  const findings = [finding({ id: 'F1' })];
  const mapping = { defect_to_finding: { D1: 'F998', D2: 'F999' } };
  // Before the fix: matchedFindingIds = {F998, F999} (size 2), surfaced findings.length = 1
  // -> precision = 2 / 1 = 2.0, an impossible value. Now: fails closed.
  assert.throws(() => scoreRun({ findings, defects, mapping }), /F998|F999/);
});

test('validateScoreInputs: rejects a mapping.defect_to_finding key that references an unknown defect id', () => {
  const defects = [{ id: 'D1', severity: 'HIGH' }];
  const findings = [finding({ id: 'F1' })];
  assert.throws(
    () => validateScoreInputs({ findings, defects, mapping: { defect_to_finding: { D_TYPO: 'F1' } }, costUsd: null }),
    /references unknown defect id "D_TYPO"/
  );
});

test('validateScoreInputs: rejects duplicate finding ids', () => {
  const defects = [];
  const findings = [finding({ id: 'F1' }), finding({ id: 'F1' })];
  assert.throws(() => validateScoreInputs({ findings, defects, mapping: {}, costUsd: null }), /duplicate finding id: "F1"/);
});

test('validateScoreInputs: rejects duplicate defect ids', () => {
  const defects = [{ id: 'D1', severity: 'HIGH' }, { id: 'D1', severity: 'LOW' }];
  const findings = [];
  assert.throws(() => validateScoreInputs({ findings, defects, mapping: {}, costUsd: null }), /duplicate defect id: "D1"/);
});

test('validateScoreInputs: rejects an unknown severity on a defect', () => {
  const defects = [{ id: 'D1', severity: 'SEVERE' }];
  const findings = [];
  assert.throws(() => validateScoreInputs({ findings, defects, mapping: {}, costUsd: null }), /unknown severity "SEVERE"/);
});

test('validateScoreInputs: rejects an unknown severity on a finding', () => {
  const defects = [];
  const findings = [finding({ id: 'F1', severity: 'SEVERE' })];
  assert.throws(() => validateScoreInputs({ findings, defects, mapping: {}, costUsd: null }), /unknown severity "SEVERE"/);
});

test('validateScoreInputs: rejects an unknown final_state on a finding', () => {
  const defects = [];
  const findings = [finding({ id: 'F1', final_state: 'made-up-state' })];
  assert.throws(() => validateScoreInputs({ findings, defects, mapping: {}, costUsd: null }), /unknown final_state "made-up-state"/);
});

test('validateScoreInputs: rejects a non-finite or negative cost', () => {
  const defects = [];
  const findings = [];
  assert.throws(() => validateScoreInputs({ findings, defects, mapping: {}, costUsd: NaN }));
  assert.throws(() => validateScoreInputs({ findings, defects, mapping: {}, costUsd: Infinity }));
  assert.throws(() => validateScoreInputs({ findings, defects, mapping: {}, costUsd: -5 }));
});

test('validateScoreInputs: rejects mapping.origin_to_defect referencing an origin id that appears in no finding', () => {
  const defects = [{ id: 'D1', severity: 'HIGH' }];
  const findings = [finding({ id: 'F1', origins: ['A1'] })];
  assert.throws(
    () => validateScoreInputs({ findings, defects, mapping: { origin_to_defect: { A99: 'D1' } }, costUsd: null }),
    /references origin id "A99", which does not appear/
  );
});

test('validateScoreInputs: rejects mapping.origin_to_defect referencing an unknown defect id', () => {
  const defects = [];
  const findings = [finding({ id: 'F1', origins: ['A1'] })];
  assert.throws(
    () => validateScoreInputs({ findings, defects, mapping: { origin_to_defect: { A1: 'D_UNKNOWN' } }, costUsd: null }),
    /references unknown defect id "D_UNKNOWN"/
  );
});

test('scoreRun: a valid-but-adversarial input never produces a NaN or Infinity metric', () => {
  const defects = [
    { id: 'D1', severity: 'CRITICAL', matches: ['nothing matches'] },
    { id: 'D2', severity: 'HIGH', matches: ['also nothing'] },
  ];
  const findings = [
    finding({ id: 'F1', final_state: 'dropped-speculative', evidence: ['irrelevant'] }),
    finding({ id: 'F2', origins: ['A1', 'B2'], evidence: ['irrelevant too'] }),
  ];
  const result = scoreRun({ findings, defects, costUsd: 0 });
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `${key} must be finite, got ${value}`);
    }
  }
});
