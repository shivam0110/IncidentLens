import { scenarioSchema } from "./schemas";
import { OutputError } from "./budget";
import { createRun, validateReport, type InvestigationOptions } from "./run";

export async function investigateBaseline(incidentId: string, options: InvestigationOptions = {}) {
  // Role-specific schedules collapse to the only agent's admitted-request ordinals.
  // Deduplicate collisions; no configured failure is silently dropped.
  const agentFailures = [...new Set(scenarioSchema.shape.agentFailures.parse(options.agentFailures ?? []).map((rule) => rule.attempt))]
    .map((attempt) => ({ role: "Investigator" as const, attempt }));
  const run = createRun(incidentId, { ...options, agentFailures }, "single-agent");
  const { state, budget, tools, config } = run;
  let report = null;
  try {
    while (state.round < config.limits.maxRounds && budget.canGather()) {
      state.round++;
      run.emit({ type: "round", role: "Investigator", status: "running", message: `Evidence round ${state.round}.` });
      const prior = tools.snapshot().attempts.length;
      report = await run.guarded("Investigator", undefined, (value) => {
        run.sync();
        validateReport(value, { incident: state.incident, evidence: state.evidence });
      });
      if (!report) { state.stopReason = budget.gatheringStop() ?? "General investigator failed."; break; }
      state.hypotheses = report.hypotheses;
      state.findings = report.observedFacts.map((fact) => ({ ...fact, contradictions: [], taskId: `round-${state.round}`, role: "Investigator" }));
      state.assumptions = report.assumptions;
      state.unknowns.push(...report.unknowns);
      if (report.outcome === "concluded") { state.stopReason = "General investigator selected a supported conclusion."; break; }
      if (!tools.snapshot().attempts.slice(prior).some((attempt) => attempt.result.status !== "error")) {
        state.stopReason = "No progress: no successful new query."; break;
      }
    }
    state.stopReason ??= budget.gatheringStop() ?? "Evidence round limit reached.";
    run.finish(report);
  } catch (error) {
    state.stopReason = run.fail("run", "Investigation", error instanceof Error ? error : new OutputError("Investigation failed."));
    run.finish();
  } finally { budget.dispose(); }
  return run.save();
}
