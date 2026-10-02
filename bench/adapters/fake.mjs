// Deterministic mock adapter for run-comparison.mjs's own tests. No network,
// no spawned process, no provider credentials -- exercises the orchestrator's
// case-loading/trial-iteration/artifact-writing/scoring logic without ever
// calling a real CLI. See bench/adapters/live.mjs for the real adapter.
//
// makeFakeAdapter's script maps an arm name to either a fixed ArmResult, an
// Error to throw, or a function (packet, trialIndex) => ArmResult -- the
// function form lets a test vary behavior per trial (e.g. "fail on trial 2").

function normalizeResult(entry, packet, trialIndex) {
  if (entry instanceof Error) throw entry;
  if (typeof entry === 'function') return entry(packet, trialIndex);
  return entry;
}

// Builds a runArm(...) function bound to a fixed script. Any arm not present
// in the script throws -- a test must declare every arm shape it exercises,
// never silently fall through to a default that could mask a missing case.
export function makeFakeAdapter(script) {
  return async function runArm({ arm, caseDir, packet, runDir, config, trialIndex }) {
    if (!(arm in script)) {
      throw new Error(`makeFakeAdapter: no script entry for arm "${arm}" -- add one, even if it's just {status: "completed", findings: []}`);
    }
    return normalizeResult(script[arm], packet, trialIndex);
  };
}

// The uniform shape every adapter (fake or live) must return. Not enforced
// by a class/schema here -- validated structurally by run-comparison.mjs's
// own runArm() wrapper, which is the single place that must reject a
// malformed adapter result rather than let it propagate silently into
// scoreRun() and produce a confusing downstream error.
export const ARM_RESULT_STATUSES = ['completed', 'failed', 'timed_out', 'malformed'];
