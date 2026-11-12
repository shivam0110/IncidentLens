import { AIMessage, HumanMessage, SystemMessage, ToolMessage, isAIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { investigate, validatePlan, validateReport, type InvestigationState } from "../lib/investigation";
import { assertReferences, geminiTransport, type AgentRequest, type AgentTransport, type RoleResult } from "../lib/agents";
import { createBudget, OutputError } from "../lib/budget";
import { getModelConfig, ProviderError } from "../lib/model";
import { reportSchema, type Evidence, type Report, type Task, type ToolEnvelope } from "../lib/schemas";

const config = () => getModelConfig({ GEMINI_API_KEY: "test-secret", GEMINI_MODEL: "gemini-3.5-flash-lite", INCIDENTLENS_MODEL_INTERVAL_MS: "0", INCIDENTLENS_RETRY_DELAY_MS: "0", INCIDENTLENS_MAX_RUN_TOKENS: "32000", INCIDENTLENS_REPORT_RESERVE_TOKENS: "4096", INCIDENTLENS_REPORT_RESERVE_MODEL_ATTEMPTS: "2" });
function raw(content = "done") {
  return new AIMessage({ content, response_metadata: { geminiUsage: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17 } } });
}
const task = (id: string, role: Task["role"], dependsOn: string[] = []): Task => ({ id, role, dependsOn, question: `Investigate ${id}`, status: "pending" });
const context = (request: AgentRequest) => JSON.parse(request.messages[1].content as string) as Omit<InvestigationState, "evidence"> & { evidence: Evidence[]; task?: Task };
const plan = (tasks: Task[]): RoleResult<"Orchestrator"> => ({ tasks, questions: tasks.map((item) => item.question), rationale: "Test timing and competing explanations." });
const followup = "Check info logs before 10:00 UTC to challenge whether failures preceded the release.";
function mock(options: {
  dependent?: boolean; followUp?: boolean; empty?: boolean;
  intercept?: (request: AgentRequest) => Promise<void> | void;
  change?: (request: AgentRequest, value: unknown) => unknown;
} = {}) {
  const requests: AgentRequest[] = [];
  const transport: AgentTransport = async (request) => {
    requests.push(request);
    await options.intercept?.(request);
    const ctx = context(request);
    if (request.phase === "gather") {
      if (request.messages.some((message) => message instanceof ToolMessage)) return { raw: raw() };
      const args = { service: ctx.incident.service, start: ctx.incident.start, end: ctx.incident.end };
      const name = request.role === "Observability" ? "query_logs" : "query_changes";
      const selected = ctx.round > 1 ? { ...args, severity: "info", end: `${ctx.incident.start.slice(0, 10)}T09:59:59Z` } : args;
      const call = new AIMessage({ content: "", tool_calls: [{ name, id: `${request.role}-${ctx.round}`, args: options.empty ? { ...args, service: "absent" } : selected }], additional_kwargs: { nativeMetadata: "original" }, response_metadata: raw().response_metadata });
      return { raw: call };
    }
    let value: unknown;
    switch (request.role) {
      case "Orchestrator":
        value = ctx.round === 1 ? plan([task("observe", "Observability"), task("dependencies", "Dependency", options.dependent ? ["observe"] : [])])
          : plan([{ ...task("before-release", "Observability"), question: followup }]);
        break;
      case "Observability": case "Dependency": {
        const envelope = JSON.parse((request.messages.findLast((message) => message instanceof ToolMessage) as ToolMessage).content as string) as ToolEnvelope;
        value = { findings: envelope.evidence.length ? [{ statement: `Observed ${envelope.evidence[0].source} record`, evidenceIds: [envelope.evidence[0].id], contradictions: [] }] : [], gaps: envelope.evidence.length ? [] : ["Query returned no matching records."] };
        break;
      }
      case "Reasoning": value = {
        hypotheses: ctx.evidence.length ? [{ id: "h1", causeClass: "software_regression", component: ctx.incident.service,
          explanation: "Release is a candidate explanation.", support: Object.values(ctx.evidence).slice(0, 2).map((item) => item.id), contradictions: [], confidence: "medium",
          rationale: "Some temporal support, causality uncertain.", assumptions: ["The record is relevant."], unknowns: [] }] : [],
        assumptions: [], unknowns: [],
      }; break;
      case "Critic": value = options.followUp && ctx.round === 1 ? {
        recommendation: "follow_up", rationale: "Need a before-period comparison.", requests: [{ id: "before-release", role: "Observability", question: followup, rationale: "Disconfirm timing.", hypothesisIds: ["h1"] }],
      } : { recommendation: "stop", rationale: "No further useful query remains.", requests: [] }; break;
      case "Reporting": value = {
        incidentId: ctx.incident.id, outcome: ctx.hypotheses.length ? "concluded" : "inconclusive", summary: "Investigation summary.",
        hypotheses: ctx.hypotheses, observedFacts: ctx.findings.map(({ statement, evidenceIds }) => ({ statement, evidenceIds })),
        assumptions: ctx.assumptions, unknowns: ctx.unknowns, actions: [], limitations: [], failures: [], stopReason: ctx.stopReason, stats: ctx.stats,
      }; break;
    }
    value = options.change?.(request, value) ?? value;
    return { raw: raw(JSON.stringify(value)), parsed: value };
  };
  return { transport, requests };
}

describe("six-role investigation behavior", () => {
  it("keeps grounding-judge schemas separate from Reporting's host-owned fields", async () => {
    const schema = z.strictObject({ verdicts: z.array(z.string()) });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const body = await (input as Request).clone().json();
      const native = body.generationConfig.responseJsonSchema ?? body.generationConfig.responseSchema;
      expect(Object.keys(native.properties)).toEqual(["verdicts"]);
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: '{"verdicts":["supported"]}' }] }, finishReason: "STOP" }] }),
        { headers: { "Content-Type": "application/json" } });
    });
    try {
      const result = await geminiTransport(config())({ role: "Reporting", phase: "result", tools: [], schema,
        signal: new AbortController().signal, messages: [new SystemMessage("Judge evidence."), new HumanMessage("Synthetic claim and citation.")] });
      expect(result.parsed).toEqual({ verdicts: ["supported"] });
    } finally { fetch.mockRestore(); }
  });

  it("repairs a malformed tool call using field errors and the exact tool schema", async () => {
    const model = mock();
    let rejected = false;
    const transport: AgentTransport = async (request) => {
      if (request.role === "Observability" && request.phase === "gather" && !rejected) {
        rejected = true;
        const incident = context(request).incident;
        return { raw: new AIMessage({ content: "", response_metadata: raw().response_metadata,
          tool_calls: [{ id: "invalid", name: "query_logs", args: { service: incident.service, start: incident.start, query: "errors" } }] }) };
      }
      if (request.role === "Observability" && request.phase === "gather" && !request.messages.some(message => message instanceof ToolMessage)) {
        const repair = request.messages.at(-1)!.content as string;
        expect(repair).toContain("query_logs arguments rejected");
        expect(repair).toContain("end");
        expect(repair).toContain('"search"');
        expect(repair).toContain("Unrecognized key");
      }
      return model.transport(request);
    };
    const result = await investigate("inc-001", { config: config(), transport, traceDirectory: false });
    expect(result.report.failures).toEqual([]);
    expect(result.toolHistory.some(attempt => attempt.tool === "query_logs")).toBe(true);
  });

  it("keeps host-owned report fields out of the native model schema and restores authoritative values", async () => {
    const report = { outcome: "inconclusive", summary: "No sufficient evidence.", observedFacts: [],
      assumptions: [], unknowns: ["Cause undetermined."], actions: [], limitations: [] };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const body = await (input as Request).clone().json();
      const schema = body.generationConfig.responseJsonSchema ?? body.generationConfig.responseSchema;
      for (const key of ["incidentId", "stats", "failures", "stopReason", "hypotheses"]) expect(schema.properties).not.toHaveProperty(key);
      expect(schema.properties.outcome).toMatchObject({ const: "inconclusive" });
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(report) }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }), { headers: { "Content-Type": "application/json" } });
    });
    const ctx = { incident: { id: "inc-001" }, stats: { modelAttempts: 7 }, failures: [], stopReason: "No useful new evidence.", hypotheses: [], evidence: [] };
    try {
      const result = await geminiTransport(config())({ role: "Reporting", phase: "result", tools: [], schema: reportSchema,
        signal: new AbortController().signal, messages: [new SystemMessage("Report."), new HumanMessage(JSON.stringify(ctx))] });
      expect(result.parsed).toEqual({ ...report, hypotheses: ctx.hypotheses, incidentId: ctx.incident.id, stats: ctx.stats, failures: [], stopReason: ctx.stopReason });
    } finally { fetch.mockRestore(); }
  });

  it("runs independent specialists concurrently, joins evidence and findings, and preserves native messages", async () => {
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const model = mock({ intercept: async (request) => {
      if (request.phase !== "gather" || request.messages.some((message) => message instanceof ToolMessage)) return;
      started.push(request.role);
      await new Promise<void>((resolve) => { releases.push(resolve); if (releases.length === 2) releases.forEach((release) => release()); });
    } });
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false });
    expect(started.sort()).toEqual(["Dependency", "Observability"]);
    expect(result.report.failures).toEqual([]);
    expect(result.state.findings.map((finding) => finding.role).sort()).toEqual(["Dependency", "Observability"]);
    const reasoning = context(model.requests.find((request) => request.role === "Reasoning")!);
    expect(Object.values(reasoning.evidence).some((item) => item.source === "logs")).toBe(true);
    expect(Object.values(reasoning.evidence).some((item) => item.source === "changes")).toBe(true);
    expect(result.state.evidence).toHaveProperty(result.state.findings[0].evidenceIds[0]);
    for (const role of ["Observability", "Dependency"]) {
      const turn = model.requests.find((request) => request.role === role && request.messages.some((message) => message instanceof ToolMessage))!;
      expect(turn.messages.some((message) => isAIMessage(message) && message.additional_kwargs.nativeMetadata === "original")).toBe(true);
      const reply = turn.messages.find((message) => message instanceof ToolMessage) as ToolMessage;
      const original = turn.messages.find((message) => isAIMessage(message) && message.tool_calls?.length) as AIMessage;
      expect(reply.tool_call_id).toBe(original.tool_calls![0].id);
    }
    expect(result.state.events.at(-1)?.type).toBe("complete");
    expect(result.report.stats).toMatchObject({ toolAttempts: 2, modelAttempts: 10, usage: { total: 170, thinking: 20, availability: "complete" } });
    expect(result.state.round).toBe(1);
  });

  it("waits for dependencies and supplies their completed findings to dependants", async () => {
    const model = mock({ dependent: true, intercept: (request) => {
      if (request.role === "Dependency") {
        expect(context(request).tasks.find((item) => item.id === "observe")?.status).toBe("completed");
        expect(context(request).findings.some((item) => item.taskId === "observe")).toBe(true);
      }
    } });
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false });
    expect(result.state.tasks.every((item) => item.status === "completed")).toBe(true);
    expect(result.report.failures).toEqual([]);
  });

  it("routes a critic request through planning to a new relevant query and retains prior evidence", async () => {
    const model = mock({ followUp: true });
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false });
    expect(result.report.failures).toEqual([]);
    expect(result.state.round).toBe(2);
    expect(result.state.tasks.find((item) => item.id === "before-release")).toMatchObject({ status: "completed", role: "Observability", question: followup });
    const second = model.requests.find((request) => request.phase === "result" && request.role === "Observability" && context(request).round === 2)!;
    const tool = second.messages.find((message) => message instanceof ToolMessage) as ToolMessage;
    const returned = JSON.parse(tool.content as string) as ToolEnvelope;
    expect(returned.evidence.length).toBeGreaterThan(0);
    expect(returned.evidence.every((item) => item.source === "logs" && item.raw.severity === "info" && Date.parse(item.timestamp) < Date.parse("2026-10-01T10:00:00Z"))).toBe(true);
    expect(result.state.events.filter((event) => event.type === "tool" && event.status === "completed")).toHaveLength(3);
    expect(result.state.findings).toHaveLength(3);
    expect(result.report.stats.toolAttempts).toBe(3);
  });

  it("keeps insufficient evidence inconclusive and does not loop to fill the round limit", async () => {
    const model = mock({ empty: true });
    const result = await investigate("inc-010", { config: config(), transport: model.transport, traceDirectory: false });
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.state.evidence).toEqual({});
    expect(result.state.round).toBe(1);
    expect(result.report.failures).toEqual([]);
  });

  it("bounds invalid-report repair and rejects invented citations before falling back", async () => {
    const model = mock({ change: (request, value) => request.role === "Reporting" ? { ...(value as Report), observedFacts: [{ statement: "Fabricated", evidenceIds: ["invented"] }] } : value });
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false });
    expect(model.requests.filter((request) => request.role === "Reporting")).toHaveLength(2);
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.failures.some((failure) => failure.name === "Reporting")).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain("invented");
    expect(() => validateReport(result.report, result.state)).not.toThrow();
  });

  it("rejects malformed/cyclic plans without deadlocking or starting specialist work", async () => {
    const model = mock({ change: (request, value) => request.role === "Orchestrator" ? plan([task("a", "Dependency", ["b"]), task("b", "Observability", ["a"])]) : value });
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false });
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.stats.toolAttempts).toBe(0);
    expect(model.requests.some((request) => request.phase === "gather")).toBe(false);
    expect(result.report.failures.some((failure) => failure.name === "Orchestrator")).toBe(true);
  });

  it("persists an inspectable local trace without credentials or evaluation labels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "incidentlens-"));
    try {
      const model = mock();
      const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: directory });
      const saved = await readFile(result.tracePath!, "utf8");
      expect(saved).not.toContain("test-secret");
      for (const hidden of ["acceptableCauses", "relevantEvidenceIds", "expectedInconclusive", "agentFailures", "toolFailures"]) {
        expect(JSON.stringify(model.requests.map((request) => request.messages))).not.toContain(hidden);
      }
      const trace = JSON.parse(saved);
      expect(trace.toolHistory).toHaveLength(2);
      expect(trace.toolHistory[0].args).toHaveProperty("start");
      expect(trace.state.report).toEqual(result.report);
      expect(trace.state.events.map((event: { sequence: number }) => event.sequence)).toEqual(result.state.events.map((_, index) => index + 1));
      expect(reportSchema.safeParse(trace.state.report).success).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("plan and report boundaries", () => {
  it("rejects duplicate, missing, failed and self dependencies; accepts completed prior tasks", () => {
    for (const tasks of [[task("a", "Dependency", ["a"])], [task("a", "Dependency", ["missing"])], [task("a", "Dependency"), task("a", "Observability")]]) {
      expect(() => validatePlan(plan(tasks), [])).toThrow(OutputError);
    }
    expect(() => validatePlan(plan([task("a", "Dependency", ["old"])]), [{ ...task("old", "Observability"), status: "failed" }])).toThrow();
    expect(() => validatePlan(plan([task("a", "Dependency", ["old"])]), [{ ...task("old", "Observability"), status: "completed" }])).not.toThrow();
  });

  it("checks nested support, contradictions, actions, observed facts, and incident IDs", async () => {
    const model = mock();
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false });
    for (const field of ["support", "contradictions", "evidenceIds"]) {
      expect(() => assertReferences({ nested: [{ [field]: ["missing"] }] }, result.state.evidence)).toThrow();
    }
    expect(() => validateReport({ ...result.report, incidentId: "other" }, result.state)).toThrow();
    expect(() => validateReport({ ...result.report, hypotheses: [] }, result.state)).toThrow();
    expect(() => validateReport({ ...result.report, observedFacts: [{ statement: "Unsupported fact", evidenceIds: [] }] }, result.state)).toThrow();
    expect(() => validateReport({ ...result.report, summary: null }, result.state)).toThrow();
  });
});

describe("shared basic budgets", () => {
  it("atomically reserves concurrent model attempts and leaves reporting capacity", async () => {
    const setting = config();
    setting.limits.maxModelAttempts = 3;
    const budget = createBudget(setting);
    let release!: () => void;
    const pending = budget.model(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { raw: raw() }; }, 20);
    await expect(budget.model(async () => ({ raw: raw() }), 20)).rejects.toThrow(/reporting capacity/);
    release();
    await pending;
    await budget.model(async () => ({ raw: raw() }), 20, true);
    expect(budget.snapshot()).toMatchObject({ modelAttempts: 2, usage: { total: 34 } });
  });

  it("counts failed reported usage and rejects token/tool excess before starting another call", async () => {
    const setting = config();
    setting.limits.maxToolAttempts = 1;
    const budget = createBudget(setting);
    await budget.tool(async () => 1);
    await expect(budget.tool(async () => 2)).rejects.toThrow(/Tool attempt/);
    const usage = { input: 30000, output: 2000, total: 32000, visibleOutput: 2000, thinking: null, cacheRead: null, toolUsePrompt: null, availability: "complete" as const };
    await expect(budget.model(async () => { throw new ProviderError({ statusCode: 503 }, usage); }, 10)).rejects.toThrow();
    await expect(budget.model(async () => ({ raw: raw() }), 10, true)).rejects.toThrow(/token limit/);
    expect(budget.snapshot()).toMatchObject({ toolAttempts: 1, modelAttempts: 1, usage: { total: 32000 } });
  });

  it("terminates an already-cancelled run with an honest inconclusive report and no requests", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = mock();
    const result = await investigate("inc-001", { config: config(), signal: controller.signal, transport: model.transport, traceDirectory: false });
    expect(result.report.outcome).toBe("inconclusive");
    expect(model.requests).toHaveLength(0);
    expect(result.report.stats.usage.total).toBeNull();
    expect(result.report.failures.length).toBeGreaterThan(0);
  });

  it("counts a transient tool retry and records both attempts", async () => {
    const model = mock();
    const result = await investigate("inc-008", { config: config(), transport: model.transport, traceDirectory: false, toolFailures: [{ tool: "query_logs", mode: "first_timeout" }] });
    expect(result.report.stats.toolAttempts).toBe(3);
    expect(result.report.failures.some((failure) => failure.scope === "tool" && /timed out/.test(failure.message))).toBe(true);
    expect(result.state.events.filter((event) => event.tool === "query_logs" && event.status === "running")).toHaveLength(2);
  });
});

describe("reliable graph termination", () => {
  it("recovers an injected agent failure while preserving partial/source failures and critic follow-up", async () => {
    const model = mock({ followUp: true });
    const transport: AgentTransport = async (request) => {
      const response = await model.transport(request);
      if (request.role === "Observability" && request.phase === "gather" && response.raw.tool_calls?.length) {
        const call = response.raw.tool_calls[0];
        const { service, start, end } = call.args;
        response.raw.tool_calls.push({ name: "query_metrics", id: `${call.id}-metrics`, args: { service, start, end } });
      }
      return response;
    };
    const result = await investigate("inc-009", { config: config(), transport, traceDirectory: false,
      agentFailures: [{ role: "Reasoning", attempt: 1 }], toolFailures: [
        { tool: "query_metrics", mode: "persistent_error" }, { tool: "query_logs", mode: "truncate", maxRecords: 2 },
      ],
    });
    expect(result.state.round).toBe(2);
    expect(result.state.tasks.find((item) => item.id === "before-release")?.status).toBe("completed");
    expect(result.report.failures.some((failure) => failure.name === "query_metrics")).toBe(true);
    expect(result.report.failures.some((failure) => failure.scope === "agent")).toBe(false);
    expect(result.report.limitations.join(" ")).toMatch(/truncated/);
    const reasoning = JSON.parse(model.requests.find((request) => request.role === "Reasoning")!.messages[1].content as string);
    expect(reasoning.failures.some((failure: { name: string }) => failure.name === "query_metrics")).toBe(true);
    expect(JSON.stringify(model.requests.map((request) => request.messages))).not.toMatch(/agentFailures|toolFailures|acceptableCauses|relevantEvidenceIds/);
    expect(result.report.stats.usage.availability).toBe("partial");
    expect(result.state.events.some((event) => /Injected transient/.test(event.message))).toBe(true);
  });

  it("marks exhausted specialist work failed, skips its dependants and retains other evidence", async () => {
    const model = mock({ dependent: true });
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false,
      agentFailures: [{ role: "Observability", attempt: 1 }, { role: "Observability", attempt: 2 }, { role: "Observability", attempt: 3 }],
    });
    expect(result.state.tasks.map((item) => item.status)).toEqual(["failed", "skipped"]);
    expect(result.report.failures.some((failure) => failure.name === "Observability")).toBe(true);
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.limitations.join(" ")).toMatch(/skipped|dependencies/);
  });

  it("falls back deterministically after reporting retries fail, retaining validated facts/hypotheses", async () => {
    const model = mock({ intercept: (request) => { if (request.role === "Reporting") throw new ProviderError({ statusCode: 503 }); } });
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false });
    expect(model.requests.filter((request) => request.role === "Reporting")).toHaveLength(3);
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.hypotheses).toEqual(result.state.hypotheses);
    expect(result.report.observedFacts).toHaveLength(2);
    expect(result.report.stopReason).toMatch(/Reporting unavailable.*503/);
    expect(result.report.failures.some((failure) => failure.name === "Reporting")).toBe(true);
    expect(() => validateReport(result.report, result.state)).not.toThrow();
  });

  it("retains facts on recursion failure and records the actual recursion stop reason", async () => {
    const setting = config();
    setting.limits.recursionLimit = 3;
    const model = mock();
    const result = await investigate("inc-001", { config: setting, transport: model.transport, traceDirectory: false });
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.stopReason).toMatch(/recursion limit/);
    expect(result.report.observedFacts).toHaveLength(2);
    expect(result.state.events.at(-1)?.type).toBe("complete");
    expect(model.requests.some((request) => request.role === "Reporting")).toBe(false);
  });

  it("stops no-progress feedback when a reworded follow-up repeats a previous query", async () => {
    const base = mock({ followUp: true });
    const transport: AgentTransport = async (request) => {
      const response = await base.transport(request);
      if (request.phase === "gather" && context(request).round > 1 && response.raw.tool_calls?.length) {
        response.raw.tool_calls[0].args = { service: context(request).incident.service, start: context(request).incident.start, end: context(request).incident.end };
      }
      return response;
    };
    const result = await investigate("inc-001", { config: config(), transport, traceDirectory: false });
    expect(result.report.stopReason).toMatch(/No progress/);
    expect(result.state.round).toBe(2);
    expect(result.report.stats.toolAttempts).toBe(2);
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.failures.some((failure) => /repeated a previous query/.test(failure.message))).toBe(true);
  });

  it("keeps unresolved critic requests inconclusive at the round limit", async () => {
    const setting = config();
    setting.limits.maxRounds = 1;
    const model = mock({ followUp: true, change: (request, value) => request.role === "Reporting" ? { ...(value as Report), outcome: "inconclusive" } : value });
    const result = await investigate("inc-001", { config: setting, transport: model.transport, traceDirectory: false });
    expect(result.state.round).toBe(1);
    expect(result.report.stopReason).toMatch(/round limit/);
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.limitations.join(" ")).toMatch(/Critic questions remain unresolved/);
  });

  it("reports one primary record as inconclusive without failing or changing the assessment", async () => {
    const model = mock({ change: (request, value) => {
      if (request.role === "Reasoning") {
        const result = value as RoleResult<"Reasoning">;
        result.hypotheses[0].support = result.hypotheses[0].support.slice(0, 1);
        result.hypotheses[0].confidence = "high";
      }
      return value;
    } });
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false });
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.failures).toEqual([]);
    expect(result.report.hypotheses).toEqual(result.state.hypotheses);
  });

  it("does not let Reporting promote an unknown/low-confidence assessment or omit contradictions", async () => {
    const model = mock();
    const result = await investigate("inc-001", { config: config(), transport: model.transport, traceDirectory: false });
    const report = structuredClone(result.report);
    report.hypotheses[0].confidence = "high";
    expect(() => validateReport(report, result.state)).toThrow(/assessed leading hypothesis/);
    const withContradiction = structuredClone(result.state);
    withContradiction.hypotheses[0].contradictions = [report.hypotheses[0].support[0]];
    expect(() => validateReport(result.report, withContradiction)).toThrow(/assessed leading hypothesis/);
  });

  it("preserves honest fallback state when the reported-token cap leaves no Reporting capacity", async () => {
    const base = mock();
    const transport: AgentTransport = async (request) => {
      const response = await base.transport(request);
      if (request.role === "Reasoning") response.raw.response_metadata.geminiUsage = { promptTokenCount: 31900, candidatesTokenCount: 100, totalTokenCount: 32000 };
      return response;
    };
    const result = await investigate("inc-001", { config: config(), transport, traceDirectory: false });
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.stopReason).toMatch(/token limit/);
    expect(base.requests.some((request) => request.role === "Reporting")).toBe(false);
    expect(result.report.observedFacts).toHaveLength(2);
    expect(result.report.stats.usage.total).toBeGreaterThanOrEqual(32000);
  });
});

describe("cancellation with retained evidence", () => {
  it("stops scheduling after cancellation in flight and preserves the completed specialist facts", async () => {
    const controller = new AbortController();
    let signal!: AbortSignal;
    const model = mock({ intercept: (request) => {
      if (request.role === "Reasoning") {
        signal = request.signal;
        controller.abort();
        return new Promise(() => {});
      }
    } });
    const result = await investigate("inc-001", { config: config(), transport: model.transport, signal: controller.signal, traceDirectory: false });
    expect(signal.aborted).toBe(true);
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.stopReason).toMatch(/cancelled/);
    expect(result.report.observedFacts).toHaveLength(2);
    expect(model.requests.some((request) => ["Critic", "Reporting"].includes(request.role))).toBe(false);
    expect(result.state.events.at(-1)?.type).toBe("complete");
    const completed = JSON.stringify(result);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(JSON.stringify(result)).toBe(completed);
  });
});

describe("final reporting limits", () => {
  it("cannot hide a reported-token overshoot on the final model call", async () => {
    const base = mock();
    const transport: AgentTransport = async (request) => {
      const result = await base.transport(request);
      if (request.role === "Reporting") result.raw.response_metadata.geminiUsage = { promptTokenCount: 32000, candidatesTokenCount: 1, totalTokenCount: 32001 };
      return result;
    };
    const result = await investigate("inc-001", { config: config(), transport, traceDirectory: false });
    expect(result.report.outcome).toBe("inconclusive");
    expect(result.report.stopReason).toMatch(/Reported token limit exceeded/);
    expect(result.report.stats.usage.total).toBeGreaterThan(32000);
    expect(result.report.observedFacts).toHaveLength(2);
    expect(base.requests.filter((request) => request.role === "Reporting")).toHaveLength(1);
  });
});
