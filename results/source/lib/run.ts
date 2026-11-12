import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertReferences, createAgentRunner, type AgentFailures, type AgentTransport, type RoleResult } from "./agents";
import { createBudget, OutputError, safeError, type Clock, type Pacer } from "./budget";
import { getModelConfig, type ModelConfig } from "./model";
import { progressEventSchema, reportSchema, type Evidence, type Hypothesis, type Incident, type ProgressEvent, type Report, type Role, type Task } from "./schemas";
import { createToolContext, getIncident } from "./tools";

type Failure = Report["failures"][number];
type Finding = RoleResult<"Observability">["findings"][number] & { taskId: string; role: Role };
export type InvestigationState = {
  incident: Incident; round: number; plan: RoleResult<"Orchestrator"> | null; tasks: Task[];
  evidence: Record<string, Evidence>; findings: Finding[]; hypotheses: Hypothesis[];
  assumptions: string[]; unknowns: string[]; critic: RoleResult<"Critic"> | null;
  errors: Failure[]; events: ProgressEvent[]; stats: Report["stats"]; stopReason: string | null; report: Report | null;
};

export function validateHypotheses(hypotheses: Hypothesis[]) {
  if (new Set(hypotheses.map((item) => item.id)).size !== hypotheses.length || hypotheses.some((item) => item.causeClass !== "unknown" && !item.support.length)) {
    throw new OutputError("Hypotheses require unique IDs and evidence support for non-unknown explanations.");
  }
}
export function validateReport(value: unknown, state: Pick<InvestigationState, "incident" | "evidence"> & Partial<InvestigationState>): Report {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) throw new OutputError("Final report failed schema validation.");
  const report = parsed.data;
  if (report.incidentId !== state.incident.id) throw new OutputError("Report incident ID does not match the run.");
  assertReferences(report, state.evidence);
  validateHypotheses(report.hypotheses);
  if ([...report.observedFacts, ...report.actions].some((claim) => !claim.evidenceIds.length)) throw new OutputError("Observed facts and actions require retrieved evidence citations.");
  const top = report.hypotheses[0];
  if (report.outcome === "concluded" && (!top || top.causeClass === "unknown" || !top.support.length || top.confidence === "low")) {
    throw new OutputError("Concluded report requires a supported leading hypothesis with adequate confidence.");
  }
  if (report.outcome === "concluded") {
    const primary = [...new Set(top.support)].filter((id) => state.evidence[id].source !== "history");
    const assessed = state.hypotheses?.[0];
    if (primary.length < 2 || (state.hypotheses && (!assessed || top.id !== assessed.id ||
      top.causeClass !== assessed.causeClass || top.component !== assessed.component ||
      top.confidence !== assessed.confidence || top.support.some((id) => !assessed.support.includes(id)) ||
      assessed.contradictions.some((id) => !top.contradictions.includes(id)))) ||
      state.critic?.recommendation === "follow_up") {
      throw new OutputError("A conclusion requires corroborating primary records, the assessed leading hypothesis and resolved critic requests.");
    }
  }
  return report;
}

function fallbackReport(state: InvestigationState): Report {
  return {
    incidentId: state.incident.id, outcome: "inconclusive", summary: state.incident.description,
    hypotheses: structuredClone(state.hypotheses),
    observedFacts: state.findings.filter((item) => item.evidenceIds.length).map(({ statement, evidenceIds }) => ({ statement, evidenceIds })),
    assumptions: state.assumptions, unknowns: state.unknowns, actions: [],
    limitations: ["Reporting unavailable; report assembled deterministically from validated state."],
    failures: state.errors, stopReason: state.stopReason ?? "Investigation stopped.", stats: state.stats,
  };
}

export type InvestigationOptions = {
  config?: ModelConfig; transport?: AgentTransport; signal?: AbortSignal;
  toolFailures?: Parameters<typeof createToolContext>[1]; onEvent?: (event: ProgressEvent) => void;
  agentFailures?: AgentFailures; clock?: Clock; pacer?: Pacer;
  traceDirectory?: string | false; apiTier?: string;
};

export function createRun(incidentId: string, options: InvestigationOptions, mode: "multi-agent" | "single-agent") {
  const config = options.config ?? getModelConfig();
  const budget = createBudget(config, options.signal, options.clock, options.pacer);
  const tools = createToolContext(incidentId, options.toolFailures);
  const state: InvestigationState = {
    incident: getIncident(incidentId), round: 0, plan: null, tasks: [], evidence: {}, findings: [], hypotheses: [],
    assumptions: [], unknowns: [], critic: null, errors: [], events: [], stats: budget.snapshot(), stopReason: null, report: null,
  };
  function emit(event: Parameters<NonNullable<typeof options.onEvent>>[0] | (Partial<ProgressEvent> & Pick<ProgressEvent, "type" | "message">)) {
    const value = progressEventSchema.parse({
      sequence: state.events.length + 1, elapsedMs: budget.elapsed(), role: null, taskId: null, tool: null,
      status: null, round: state.round, evidenceIds: [], ...event,
    });
    state.events.push(value);
    // Observers cannot mutate run state or turn a completed model request into a failure.
    try { options.onEvent?.(structuredClone(value)); } catch { /* observer is external to execution */ }
  }
  let recordedTools = 0;
  function sync() {
    const snapshot = tools.snapshot();
    state.evidence = Object.fromEntries(snapshot.evidence.map((item) => [item.id, item]));
    for (const attempt of snapshot.attempts.slice(recordedTools)) {
      if (attempt.result.error) state.errors.push({ scope: "tool", name: attempt.tool, message: attempt.result.error.message, retryable: attempt.result.error.retryable });
      state.unknowns.push(...attempt.result.warnings);
      if (attempt.result.status === "error") state.unknowns.push(`${attempt.tool}: source data unavailable on attempt ${attempt.attempt}.`);
    }
    recordedTools = snapshot.attempts.length;
    state.unknowns = [...new Set(state.unknowns)];
    state.stats = budget.snapshot();
  }
  function fail(scope: Failure["scope"], name: string, error: unknown) {
    const failure: Failure = { scope, name, message: safeError(error), retryable: false };
    state.errors.push(failure);
    emit({ type: "error", role: scope === "agent" ? name as Role : null, status: "failed", message: `${name}: ${failure.message}` });
    return failure.message;
  }
  const runner = createAgentRunner({ config, budget, tools, emit, transport: options.transport, agentFailures: options.agentFailures });
  function context(task?: Task) {
    sync();
    return {
      incident: state.incident, round: state.round, task, plan: state.plan, tasks: state.tasks,
      evidence: Object.values(state.evidence), findings: state.findings, hypotheses: state.hypotheses,
      assumptions: state.assumptions, unknowns: state.unknowns, critic: state.critic, failures: state.errors,
      queries: tools.snapshot().attempts.map(({ tool, args, result }) => ({ tool, args, status: result.status, evidenceIds: result.evidence.map((item) => item.id), warnings: result.warnings, error: result.error })),
      stopReason: state.stopReason, stats: state.stats,
    };
  }
  async function guarded<R extends Role>(role: R, task?: Task, validate?: (value: RoleResult<R>) => void) {
    try {
      return await runner(role, { context: context(task), taskId: task?.id, requireNewQuery: (role === "Investigator" || !!task) && state.round > 1,
        validate: validate ? (value) => validate(value as RoleResult<R>) : undefined });
    } catch (error) { fail("agent", role, error); return null; }
    finally { sync(); }
  }
  const update = () => { sync(); return { run: state }; };
  function finish(report?: Report | null) {
    sync();
    state.report = report ?? fallbackReport(state);
    const violation = budget.violation() ?? (budget.remaining(true) <= 0 ? "Run deadline reached." : options.signal?.aborted ? "Run cancelled." : null);
    if (violation) {
      state.stopReason = violation;
      state.report.outcome = "inconclusive";
      if (!state.errors.some((error) => error.scope === "run" && error.message === violation)) fail("run", "Investigation", new OutputError(violation));
    }
    if (state.errors.some((error) => error.scope === "run" || (error.scope === "agent" && ["Orchestrator", "Reasoning", "Critic", "Investigator"].includes(error.name)))) {
      state.report.outcome = "inconclusive";
      state.report.limitations.push("A decision-making agent or the run failed; the investigation is incomplete.");
    }
    if (state.critic?.recommendation === "follow_up") {
      state.report.outcome = "inconclusive";
      state.report.limitations.push("Critic questions remain unresolved: " + state.critic.requests.map((request) => request.question).join("; "));
    }
    if (state.stats.usage.availability !== "complete") state.report.limitations.push("Provider usage is incomplete; the total-token cap cannot be fully verified.");
    state.report.limitations = [...new Set([...state.report.limitations, ...state.unknowns, ...state.errors.map((error) => `${error.name}: ${error.message}`)])];
    state.report.failures = structuredClone(state.errors);
    state.report.stopReason = state.stopReason ?? "Investigation stopped.";
    state.report.stats = state.stats;
    state.report = validateReport(state.report, state);
    emit({ type: "complete", role: mode === "single-agent" ? "Investigator" : "Reporting", status: report ? "completed" : "failed", message: `Investigation ${state.report.outcome}: ${state.report.stopReason}` });
    return update();
  }
  async function save() {
    sync();
    state.report!.stats = state.stats;
    const runId = randomUUID();
    let tracePath: string | null = null;
    if (options.traceDirectory !== false) {
      const directory = options.traceDirectory ?? join(process.cwd(), "results", "traces");
      await mkdir(directory, { recursive: true });
      tracePath = join(directory, `${incidentId}-${runId}.json`);
      await writeFile(tracePath, JSON.stringify({
        runId, createdAt: new Date().toISOString(), mode, provider: "gemini-developer-api",
        configuration: { model: config.model, thinkingLevel: config.thinkingLevel, limits: config.limits, sampling: "provider defaults", tier: options.apiTier ?? "free requested; active tier/quotas unverified", inputReservation: "UTF-8 prompt/schema bytes divided by three; estimate, not provider tokenization" },
        state, toolHistory: tools.snapshot().attempts, failureSchedule: { toolFailures: options.toolFailures ?? [], agentFailures: options.agentFailures ?? [] },
      }, null, 2) + "\n");
    }
    return { runId, report: state.report!, state, tracePath, toolHistory: tools.snapshot().attempts };
  }
  return { config, budget, tools, state, emit, sync, fail, guarded, update, finish, save };
}
