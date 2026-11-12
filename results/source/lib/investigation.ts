import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { type RoleResult } from "./agents";
import { OutputError, safeError } from "./budget";
import { createRun, validateHypotheses, validateReport, type InvestigationOptions, type InvestigationState } from "./run";
import type { Task } from "./schemas";
export { validateReport, type InvestigationState } from "./run";

const GraphState = Annotation.Root({ run: Annotation<InvestigationState>() });

export function validatePlan(plan: RoleResult<"Orchestrator">, prior: Task[], requests: RoleResult<"Critic">["requests"] = []) {
  const ids = new Set(plan.tasks.map((task) => task.id));
  if (ids.size !== plan.tasks.length || plan.tasks.length > 4 || plan.tasks.some((task) => prior.some((old) => old.id === task.id) || task.status !== "pending")) {
    throw new OutputError("Plan requires unique new pending task IDs and at most four tasks.");
  }
  const completed = new Set(prior.filter((task) => task.status === "completed").map((task) => task.id));
  const resolved = new Set(completed);
  let remaining = [...plan.tasks];
  while (remaining.length) {
    const ready = remaining.filter((task) => task.dependsOn.every((id) => resolved.has(id)));
    if (!ready.length) throw new OutputError("Plan has a cyclic, unknown or unsuccessful dependency.");
    ready.forEach((task) => resolved.add(task.id));
    remaining = remaining.filter((task) => !resolved.has(task.id));
  }
  if (plan.tasks.length && requests.some((request) => !plan.tasks.some((task) =>
    task.id === request.id && task.role === request.role && task.question.includes(request.question)))) {
    throw new OutputError("Follow-up plan must schedule each critic request with its exact id, role and question.");
  }
}

export async function investigate(incidentId: string, options: InvestigationOptions = {}) {
  const run = createRun(incidentId, options, "multi-agent");
  const { config, budget, tools, state, emit, guarded, update, finish, fail } = run;
  let roundEvidenceCount = 0, roundToolCount = 0;
  const graph = new StateGraph(GraphState)
    .addNode("Orchestrator", async () => {
      if (!budget.canGather()) { state.stopReason = budget.gatheringStop(); return update(); }
      if (state.round >= config.limits.maxRounds) { state.stopReason = "Evidence round limit reached."; return update(); }
      state.round++;
      roundEvidenceCount = Object.keys(state.evidence).length;
      roundToolCount = tools.snapshot().attempts.length;
      emit({ type: "round", status: "running", message: `Evidence round ${state.round}.` });
      state.plan = await guarded("Orchestrator", undefined, (plan) => validatePlan(plan, state.tasks, state.critic?.requests));
      if (!state.plan) state.stopReason = budget.gatheringStop() ?? "Investigation planning failed.";
      else if (!state.plan.tasks.length) state.stopReason = `No useful new evidence: ${state.plan.rationale}`;
      else {
        state.tasks.push(...state.plan.tasks.map((task) => structuredClone(task)));
        for (const task of state.plan.tasks) emit({ type: "task", role: task.role, taskId: task.id, status: "pending", message: task.question });
      }
      return update();
    })
    .addNode("Specialists", async () => {
      const pending = new Set(state.plan!.tasks.map((task) => task.id));
      while (pending.size) {
        const ready = state.tasks.filter((task) => pending.has(task.id) && task.dependsOn.every((id) => state.tasks.some((old) => old.id === id && old.status === "completed")));
        if (!ready.length || !budget.canGather()) {
          for (const task of state.tasks.filter((item) => pending.has(item.id))) {
            task.status = "skipped";
            emit({ type: "task", role: task.role, taskId: task.id, status: "skipped", message: "Dependency failed or gathering budget exhausted." });
          }
          state.unknowns.push("Some specialist work was skipped because dependencies failed or budgets expired.");
          break;
        }
        // Each task has an isolated result. Join the entire frontier before merging or running dependants.
        const results = await Promise.all(ready.map(async (task) => {
          task.status = "running";
          emit({ type: "task", role: task.role, taskId: task.id, status: "running", message: task.question });
          const result = await guarded(task.role, task);
          return { task, result };
        }));
        for (const { task, result } of results) {
          task.status = result ? "completed" : "failed";
          pending.delete(task.id);
          if (result) {
            state.findings.push(...result.findings.map((finding) => ({ ...finding, taskId: task.id, role: task.role })));
            state.unknowns.push(...result.gaps);
          }
          emit({ type: "task", role: task.role, taskId: task.id, status: task.status, message: `${task.id} ${task.status}.` });
        }
      }
      return update();
    })
    .addNode("Reasoning", async () => {
      const result = await guarded("Reasoning", undefined, (value) => validateHypotheses(value.hypotheses));
      if (!result) state.stopReason = budget.gatheringStop() ?? "Reasoning failed; available evidence retained.";
      else { state.hypotheses = result.hypotheses; state.assumptions = result.assumptions; state.unknowns.push(...result.unknowns); }
      if (!state.stopReason && state.round > 1 && Object.keys(state.evidence).length === roundEvidenceCount &&
        !tools.snapshot().attempts.slice(roundToolCount).some((attempt) => attempt.result.status !== "error")) {
        state.stopReason = "No progress: follow-up produced neither new evidence nor a successful new query.";
      }
      return update();
    })
    .addNode("Critic", async () => {
      state.critic = await guarded("Critic", undefined, (critic) => {
        const ids = new Set(critic.requests.map((item) => item.id));
        if (ids.size !== critic.requests.length || critic.requests.length > 4 ||
          (critic.recommendation === "follow_up") !== (critic.requests.length > 0) || critic.requests.some((request) =>
            state.tasks.some((task) => task.id === request.id || task.question === request.question) ||
            request.hypothesisIds.some((id) => !state.hypotheses.some((item) => item.id === id)))) {
          throw new OutputError("Critic requests must be specific, new, consistent and reference existing hypotheses.");
        }
      });
      if (!state.critic) state.stopReason = budget.gatheringStop() ?? "Critic failed; uncertainty retained.";
      else if (state.critic.recommendation === "stop") state.stopReason = state.critic.rationale;
      else if (state.round >= config.limits.maxRounds) state.stopReason = "Evidence round limit reached with critic questions unresolved.";
      else if (!budget.canGather()) state.stopReason = budget.gatheringStop();
      return update();
    })
    .addNode("Reporting", async () => {
      state.stopReason ??= "Investigation stopped.";
      const report = await guarded("Reporting", undefined, (value) => { validateReport(value, state); });
      if (!report) state.stopReason = `${state.stopReason} Reporting unavailable: ${state.errors.findLast((error) => error.name === "Reporting")?.message ?? "request could not run"}`;
      return finish(report);
    })
    .addEdge(START, "Orchestrator")
    .addConditionalEdges("Orchestrator", () => state.stopReason ? "Reporting" : "Specialists", ["Reporting", "Specialists"])
    .addEdge("Specialists", "Reasoning")
    .addConditionalEdges("Reasoning", () => state.stopReason ? "Reporting" : "Critic", ["Reporting", "Critic"])
    .addConditionalEdges("Critic", () => state.stopReason ? "Reporting" : "Orchestrator", ["Reporting", "Orchestrator"])
    .addEdge("Reporting", END).compile();
  try {
    await graph.invoke({ run: state }, { recursionLimit: config.limits.recursionLimit, signal: budget.signal });
  } catch (error) {
    const reason = budget.signal.aborted ? budget.gatheringStop() : (error as { name?: string })?.name === "GraphRecursionError" ? "Graph recursion limit reached." : safeError(error);
    state.stopReason = fail("run", "Investigation", new OutputError(reason ?? "Investigation stopped."));
    finish();
  } finally { budget.dispose(); }
  return run.save();
}
