import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { investigateBaseline } from "../lib/baseline";
import { investigate } from "../lib/investigation";
import { createPacer } from "../lib/budget";
import { getModelConfig, ProviderError } from "../lib/model";
import type { AgentRequest, AgentTransport } from "../lib/agents";
import { toolSchemas } from "../lib/tools";
import { labelSchema, type Evidence, type Report, type ToolEnvelope } from "../lib/schemas";
import { accuracy, citationScore, groundingScore, judgeClaims, mergeUsage, selectClaims } from "../evaluation/scoring";
import { createManifest, runEvaluation, summarize, validateInputs, type EvaluationOptions } from "../evaluation/run";

const config = () => getModelConfig({ GEMINI_API_KEY: "secret-never-persist", GEMINI_MODEL: "gemini-3.5-flash-lite", INCIDENTLENS_MODEL_INTERVAL_MS: "0", INCIDENTLENS_RETRY_DELAY_MS: "0" });
const raw = () => new AIMessage({ content: "done", response_metadata: { geminiUsage: {
  promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17, cachedContentTokenCount: 3,
} } });
function model(options: { revise?: boolean; missingUsage?: boolean; tools?: string[] } = {}) {
  const requests: AgentRequest[] = [];
  const transport: AgentTransport = async (request) => {
    requests.push(request);
    const ctx = JSON.parse(request.messages[1].content as string);
    const messages = request.messages.filter((message) => message instanceof ToolMessage);
    const evidence: Evidence[] = [...(ctx.evidence ?? []), ...messages.flatMap((message) => (JSON.parse(message.content as string) as ToolEnvelope).evidence)];
    const response = raw();
    if (options.missingUsage) response.response_metadata = {};
    if (request.phase === "gather") {
      // Two actual gathering turns, with original ToolMessages available for the next decision.
      const names = options.tools ?? ["query_logs", "query_changes"];
      const name = names[messages.length];
      if (name) {
        response.tool_calls = [{ id: `${ctx.round}-${name}`, name, args: {
          service: ctx.incident.service, start: ctx.incident.start, end: ctx.incident.end,
          ...(ctx.round > 1 ? { kind: name === "query_changes" ? "configuration" : undefined, severity: name === "query_logs" ? "info" : undefined } : {}),
        } }];
        // Omit undefined properties just as native JSON does.
        response.tool_calls[0].args = JSON.parse(JSON.stringify(response.tool_calls[0].args));
      }
      return { raw: response };
    }
    const ids = [...new Set(evidence.map((record) => record.id))].slice(0, 2);
    const report: Report = {
      incidentId: ctx.incident.id, outcome: ids.length === 2 && (!options.revise || ctx.round > 1) ? "concluded" : "inconclusive",
      summary: "A candidate cause was investigated.", hypotheses: ids.length ? [{ id: "h1", causeClass: "software_regression", component: ctx.incident.service,
        explanation: "A deployment regression caused errors.", support: ids, contradictions: [], confidence: "medium", rationale: "Timing is suggestive.", assumptions: [], unknowns: [] }] : [],
      observedFacts: ids.map((id) => ({ statement: "A source record was retrieved.", evidenceIds: [id] })),
      actions: [], assumptions: [], unknowns: [], limitations: [], failures: [], stopReason: "Assessment complete.", stats: ctx.stats,
    };
    return { raw: response, parsed: report };
  };
  return { requests, transport };
}
const label = (overrides: Partial<z.infer<typeof labelSchema>> = {}) => labelSchema.parse({ incidentId: "inc-001",
  acceptableCauses: [{ causeClass: "software_regression", component: "checkout-api" }], relevantEvidenceIds: [], expectedInconclusive: false, ...overrides });
const directories: string[] = [];
async function temporary() { const path = await mkdtemp(join(tmpdir(), "incidentlens-evaluation-test-")); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const judge: AgentTransport = async (request) => ({ raw: raw(), parsed: {
  verdicts: JSON.parse(request.messages[1].content as string).map((claim: { id: string }) => ({ id: claim.id, verdict: "supported", reason: "Test verdict." })),
} });
async function evaluationOptions(cases = ["inc-001"]): Promise<EvaluationOptions> {
  const runner = (id: string, options: Parameters<typeof investigateBaseline>[1]) => investigateBaseline(id, { ...options, transport: model().transport });
  return { config: config(), cases, outputDirectory: await temporary(), tier: "free", quotaPolicy: "Offline test only; no provider execution.",
    runners: { "multi-agent": runner, "single-agent": runner }, judgeTransport: judge };
}


describe("single general investigator", () => {
  it("reuses the five native tools, settings and limits, performs repeated calls, and has no specialists or critic", async () => {
    const mock = model();
    const result = await investigateBaseline("inc-001", { config: config(), transport: mock.transport, traceDirectory: false });
    expect(result.report.outcome).toBe("concluded");
    expect(result.report.stats).toMatchObject({ modelAttempts: 4, toolAttempts: 2, usage: { total: 68, thinking: 8, cacheRead: 12 } });
    expect(new Set(mock.requests.map((request) => request.role))).toEqual(new Set(["Investigator"]));
    expect(mock.requests.filter((request) => request.phase === "gather").every((request) => request.tools.join() === Object.keys(toolSchemas).join())).toBe(true);
    expect(mock.requests[1].messages.some((message) => message instanceof ToolMessage)).toBe(true);
    expect(result.state.events.at(-1)?.role).toBe("Investigator");
    expect(result.toolHistory.map((attempt) => attempt.tool)).toEqual(["query_logs", "query_changes"]);
  });

  it("revises its own inconclusive report in another round using new queries", async () => {
    const mock = model({ revise: true });
    const result = await investigateBaseline("inc-001", { config: config(), transport: mock.transport, traceDirectory: false });
    expect(result.state.round).toBe(2);
    expect(result.report.outcome).toBe("concluded");
    expect(result.report.stats.toolAttempts).toBe(4);
    expect(result.state.hypotheses[0].component).toBe("checkout-api");
  });

  it("resets source and mapped agent failures per run, counts retries and preserves unknown usage", async () => {
    const run = () => investigateBaseline("inc-008", { config: config(), transport: model().transport, traceDirectory: false,
      toolFailures: [{ tool: "query_logs", mode: "first_timeout" }], agentFailures: [{ role: "Reasoning", attempt: 1 }] });
    const first = await run(), second = await run();
    expect(first.report.stats).toMatchObject({ modelAttempts: 5, toolAttempts: 3, usage: { total: 68, availability: "partial" } });
    expect(first.report.stats.modelAttempts).toBe(second.report.stats.modelAttempts);
    expect(first.toolHistory[0].result.error?.code).toBe("timeout");
    expect(second.toolHistory[0].result.error?.code).toBe("timeout");
    expect(first.state.events.some((event) => /Injected transient/.test(event.message))).toBe(true);
  });

  it("uses identical admission limits in both modes and retains inconclusive fallback on exhausted calls", async () => {
    const setting = config(); setting.limits.maxModelAttempts = 2;
    const baseline = model(), multi = model();
    const outputs = await Promise.all([
      investigateBaseline("inc-001", { config: setting, transport: baseline.transport, traceDirectory: false }),
      investigate("inc-001", { config: setting, transport: multi.transport, traceDirectory: false }),
    ]);
    expect(outputs.every((result) => result.report.outcome === "inconclusive" && result.report.stats.modelAttempts <= setting.limits.maxModelAttempts)).toBe(true);
    expect(baseline.requests).toHaveLength(0); expect(multi.requests.every((request) => request.phase === "result" && request.role === "Reporting")).toBe(true);
  });

  it("keeps labels and failure schedules outside model context and records the mapped trace configuration", async () => {
    const mock = model(); const directory = await temporary();
    const result = await investigateBaseline("inc-001", { config: config(), transport: mock.transport, traceDirectory: directory,
      agentFailures: [{ role: "Reasoning", attempt: 1 }] });
    const text = JSON.stringify(mock.requests.map((request) => request.messages));
    expect(text).not.toMatch(/acceptableCauses|relevantEvidenceIds|expectedInconclusive|toolFailures|agentFailures/);
    const trace = await readFile(result.tracePath!, "utf8");
    expect(trace).not.toContain(config().apiKey);
    expect(JSON.parse(trace).failureSchedule.agentFailures).toEqual([{ role: "Investigator", attempt: 1 }]);
  });
});


describe("generic accuracy and grounding", () => {
  it("scores cause-class/component pairs, concluded coverage and correct inconclusive separately", async () => {
    const { report } = await investigateBaseline("inc-001", { config: config(), transport: model().transport, traceDirectory: false });
    expect(accuracy(report, label())).toMatchObject({ correctCause: true, topPairMatch: true });
    expect(accuracy({ ...report, summary: "Entirely different wording" }, label()).correctCause).toBe(true);
    expect(accuracy({ ...report, outcome: "inconclusive" }, label())).toMatchObject({ topPairMatch: true, correctCause: false, concluded: false });
    expect(accuracy(report, label({ acceptableCauses: [{ causeClass: "configuration", component: "checkout-api" }] })).correctCause).toBe(false);
    expect(accuracy(report, label({ acceptableCauses: [{ causeClass: "software_regression", component: "other" }] })).correctCause).toBe(false);
    const insufficient = label({ acceptableCauses: [], expectedInconclusive: true });
    expect(accuracy({ ...report, outcome: "inconclusive" }, insufficient).correctInconclusive).toBe(true);
    expect(accuracy(null, insufficient)).toMatchObject({ correctCause: false, correctInconclusive: false, available: false });
  });

  it("checks retrieved citations separately and cannot support a missing/unresolved citation", async () => {
    const result = await investigateBaseline("inc-001", { config: config(), transport: model().transport, traceDirectory: false });
    const report = { ...result.report, hypotheses: [], actions: [], observedFacts: [
      { statement: "Valid claim.", evidenceIds: [result.report.observedFacts[0].evidenceIds[0]] },
      { statement: "Unresolved.", evidenceIds: ["not-retrieved"] }, { statement: "Missing.", evidenceIds: [] },
    ] };
    expect(citationScore(report, result.state.evidence)).toEqual({ valid: 1, denominator: 3, rate: 1 / 3 });
    const transport = vi.fn(judge);
    const batch = await judgeClaims(selectClaims(report), result.state.evidence, { config: config(), pacer: createPacer(0), transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(batch.verdicts.map((verdict) => verdict.verdict).sort()).toEqual(["supported", "unsupported", "unsupported"]);
    expect(groundingScore(selectClaims(report), batch.verdicts)).toMatchObject({ denominator: 3, supported: 1, rate: 1 / 3 });
    expect(JSON.stringify(transport.mock.calls)).not.toMatch(/acceptableCauses|relevantEvidenceIds|expectedInconclusive/);
  });

  it("counts every selected sentence, failures and empty/missing claims without improving support rates", async () => {
    const result = await investigateBaseline("inc-001", { config: config(), transport: model().transport, traceDirectory: false });
    const claims = selectClaims({ ...result.report, hypotheses: [], observedFacts: [{ statement: "First fact. Second fact.", evidenceIds: result.report.observedFacts[0].evidenceIds }] });
    expect(claims).toHaveLength(2);
    const batch = await judgeClaims(claims, result.state.evidence, { config: config(), pacer: createPacer(0), transport: async () => { throw new ProviderError({ statusCode: 503 }); } });
    expect(batch.verdicts.every((verdict) => verdict.verdict === "judge_failed")).toBe(true);
    expect(groundingScore(claims, batch.verdicts)).toMatchObject({ denominator: 2, rate: 0, judgeFailed: 2 });
    expect(groundingScore(claims, [ { id: claims[0].id, verdict: "contradicted", reason: "Conflicts" } ])).toMatchObject({ contradicted: 1, judgeFailed: 1, denominator: 2 });
    expect(groundingScore([], [])).toMatchObject({ denominator: 1, rate: 0 });
    expect(batch.stats).toMatchObject({ modelAttempts: 1, usage: { total: null, availability: "unavailable" } });
  });

  it("rejects incomplete/duplicate judge outputs and separates judge tokens from investigator tokens", async () => {
    const result = await investigateBaseline("inc-001", { config: config(), transport: model().transport, traceDirectory: false });
    const claims = selectClaims(result.report);
    const before = structuredClone(result.report.stats);
    const failed = await judgeClaims(claims, result.state.evidence, { config: config(), pacer: createPacer(0), transport: async () => ({ raw: raw(), parsed: { verdicts: [] } }) });
    expect(failed.error).toMatch(/missing claim/);
    const successful = await judgeClaims(claims, result.state.evidence, { config: config(), pacer: createPacer(0), transport: judge });
    expect(successful.stats?.usage.total).toBe(17);
    expect(result.report.stats).toEqual(before);
    expect(mergeUsage([before.usage, mergeUsage([])])).toMatchObject({ total: 68, availability: "partial" });
    expect(mergeUsage([]).total).toBeNull();
  });
});


describe("reproducible evaluation and safe resume", () => {
  it("validates ten inputs without requesting models, producing scores, or requiring a real key", async () => {
    expect((await validateInputs(undefined, true))).toHaveLength(10);
    await expect(validateInputs(["inc-001", "inc-001"])).rejects.toThrow(/unique/);
    await expect(validateInputs(["unknown"])).rejects.toThrow(/Unknown/);
  });

  it("shares configuration, pacer and failure profiles between modes with isolated state and judge accounting", async () => {
    const options = await evaluationOptions(["inc-008", "inc-009"]);
    const baseRunner = options.runners!["multi-agent"];
    const seen: Parameters<typeof investigate>[1][] = [];
    const runner = vi.fn(async (id: string, input: Parameters<typeof investigate>[1]) => { seen.push(input); return baseRunner(id, input ?? {}); });
    options.runners = { "multi-agent": runner, "single-agent": runner };
    const output = await runEvaluation(options);
    expect(runner).toHaveBeenCalledTimes(4);
    expect(seen.every((input) => input?.config === options.config && input.pacer === seen[0]?.pacer)).toBe(true);
    expect(seen[0]?.toolFailures).toEqual(seen[1]?.toolFailures);
    expect(seen[2]?.agentFailures).toEqual(seen[3]?.agentFailures);
    expect(output.rows[0].report?.stats.toolAttempts).toBe(output.rows[1].report?.stats.toolAttempts);
    const aggregate = output.aggregate as ReturnType<typeof summarize>;
    expect(aggregate["single-agent"].investigator.usage.total).toBeGreaterThan(aggregate["single-agent"].judge.usage.total!);
    const saved = await readFile(join(options.outputDirectory!, "evaluation.json"), "utf8");
    expect(saved).not.toContain(config().apiKey);
    expect(JSON.parse(saved).manifest.failureProfiles).toHaveLength(10);
    expect(await readFile(join(options.outputDirectory!, "evaluation.md"), "utf8")).toContain("Automated judgment is imperfect");
  });

  it("resumes completed cases and judge batches without repeating any model work", async () => {
    const options = await evaluationOptions();
    const first = await runEvaluation(options);
    const runner = vi.fn(options.runners!["multi-agent"]), judgeTransport = vi.fn(judge);
    const second = await runEvaluation({ ...options, resume: true, runners: { "multi-agent": runner, "single-agent": runner }, judgeTransport });
    expect(runner).not.toHaveBeenCalled(); expect(judgeTransport).not.toHaveBeenCalled();
    expect(second.rows).toEqual(first.rows);
    expect(second.aggregate).toEqual(first.aggregate);
  });

  it("rejects stale models/settings/failures and missing raw artifacts instead of duplicating work", async () => {
    const options = await evaluationOptions(); await runEvaluation(options);
    const profiles = await validateInputs(options.cases);
    const original = await createManifest(options, profiles);
    expect((await createManifest({ ...options, config: { ...config(), thinkingLevel: "high" } }, profiles)).fingerprint).not.toBe(original.fingerprint);
    expect((await createManifest(options, profiles.map((profile) => ({ ...profile, toolFailures: [{ tool: "query_logs", mode: "first_timeout" }] })))).fingerprint).not.toBe(original.fingerprint);
    await expect(runEvaluation({ ...options, resume: true, config: { ...config(), model: "gemini-other-model" } })).rejects.toThrow(/stale/);
    await expect(runEvaluation(options)).rejects.toThrow(/already exists/);
    await rm(join(options.outputDirectory!, "runs/inc-001.single-agent.json"));
    await expect(runEvaluation({ ...options, resume: true })).rejects.toThrow();
  });

  it("retains failed/missing cases in denominators and records unavailable usage", async () => {
    const options = await evaluationOptions(["inc-001", "inc-010"]);
    const unavailable = vi.fn(async () => { throw new ProviderError({ statusCode: 503 }); });
    options.runners!["multi-agent"] = unavailable;
    const result = await runEvaluation(options);
    const aggregate = (result.aggregate as ReturnType<typeof summarize>)["multi-agent"];
    expect(aggregate.rootCause).toEqual({ correct: 0, denominator: 1 });
    expect(aggregate.correctInconclusive).toEqual({ correct: 0, denominator: 1 });
    expect(aggregate.grounding).toMatchObject({ macroRate: 0, denominator: 2 });
    expect(aggregate.investigator).toMatchObject({ missingRuns: 2, usage: { total: null, availability: "unavailable" } });
    const runner = vi.fn(options.runners!["single-agent"]);
    await runEvaluation({ ...options, resume: true, runners: { "multi-agent": runner, "single-agent": runner } });
    expect(runner).not.toHaveBeenCalled();
  });

  it("recovers a completed orphan artifact and does not retry an interrupted unknown request", async () => {
    const options = await evaluationOptions(); await runEvaluation(options);
    const path = join(options.outputDirectory!, "evaluation.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8"));
    checkpoint.rows[0].status = "running"; checkpoint.rows[0].artifact = null; checkpoint.rows[0].report = null;
    checkpoint.rows[1].status = "running"; checkpoint.rows[1].artifact = null; checkpoint.rows[1].report = null;
    checkpoint.rows[1].judge = { status: "pending", batches: [], inFlight: [] };
    await rm(join(options.outputDirectory!, "runs/inc-001.single-agent.json"));
    await writeFile(path, JSON.stringify(checkpoint));
    const runner = vi.fn(options.runners!["single-agent"]);
    const resumed = await runEvaluation({ ...options, resume: true, runners: { "multi-agent": runner, "single-agent": runner } });
    expect(runner).not.toHaveBeenCalled();
    expect(resumed.rows[0].status).toBe("completed");
    expect(resumed.rows[1].status).toBe("interrupted");
    expect(resumed.rows[1].report).toBeNull();
  });

  it("keeps interrupted judge claims in denominators and retries only with the explicit option", async () => {
    const options = await evaluationOptions(); await runEvaluation(options);
    const path = join(options.outputDirectory!, "evaluation.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8"));
    const ids = checkpoint.rows[0].judge.batches.flatMap((batch: { verdicts: { id: string }[] }) => batch.verdicts.map((verdict) => verdict.id));
    checkpoint.rows[0].judge = { status: "running", batches: [], inFlight: ids };
    await writeFile(path, JSON.stringify(checkpoint));
    const transport = vi.fn(judge);
    const resumed = await runEvaluation({ ...options, resume: true, judgeTransport: transport });
    expect(transport).not.toHaveBeenCalled();
    expect(resumed.rows[0].judge.batches[0].stats).toBeNull();
    expect((resumed.aggregate as ReturnType<typeof summarize>)["multi-agent"].grounding.macroRate).toBe(0);
    await runEvaluation({ ...options, resume: true, retryIncomplete: true, judgeTransport: transport });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

it("does not award correct-inconclusive credit for an execution failure", async () => {
  const result = await investigateBaseline("inc-010", { config: config(), transport: async () => { throw new ProviderError({ statusCode: 401 }); }, traceDirectory: false });
  expect(accuracy(result.report, label({ incidentId: "inc-010", acceptableCauses: [], expectedInconclusive: true })))
    .toMatchObject({ correctInconclusive: false, executionComplete: false, available: true });
});

it("preserves decimal values while selecting factual sentences", async () => {
  const result = await investigateBaseline("inc-001", { config: config(), transport: model().transport, traceDirectory: false });
  expect(selectClaims({ ...result.report, hypotheses: [], observedFacts: [{ statement: "Latency was 5.2 ms. Errors reached 0.4%.", evidenceIds: ["id"] }] })
    .map((claim) => claim.statement)).toEqual(["Latency was 5.2 ms.", "Errors reached 0.4%."]);
});

it("stops queued cases on quota exhaustion and resumes only the unattempted slots", async () => {
  const options = await evaluationOptions(["inc-001", "inc-002"]);
  const original = options.runners!["single-agent"];
  const runs = vi.fn(async (id: string, input: Parameters<typeof investigate>[1]) => {
    const result = await original(id, input ?? {});
    input!.pacer!.stop("Project/day quota exhausted.");
    return result;
  });
  const first = await runEvaluation({ ...options, runners: { "multi-agent": runs, "single-agent": runs } });
  expect(runs).toHaveBeenCalledTimes(1);
  expect(first.rows.map((row) => row.status)).toEqual(["quota_blocked", "quota_blocked", "quota_blocked", "quota_blocked"]);
  expect(first.rows[0].judge.status).toBe("quota_blocked");
  const resume = vi.fn(original);
  const second = await runEvaluation({ ...options, resume: true, runners: { "multi-agent": resume, "single-agent": resume } });
  expect(resume).toHaveBeenCalledTimes(3);
  expect(second.rows.filter((row) => row.report)).toHaveLength(4);
  expect(second.rows[0].judge.status).toBe("completed");
});

it("expands a selected-case run to the full selection while reusing its completed artifacts", async () => {
  const options = await evaluationOptions();
  const first = await runEvaluation(options);
  const runner = vi.fn(options.runners!["single-agent"]);
  const second = await runEvaluation({ ...options, cases: ["inc-001", "inc-002"], resume: true, runners: { "multi-agent": runner, "single-agent": runner } });
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(runner.mock.calls.every(([id]) => id === "inc-002")).toBe(true);
  expect(second.rows.slice(0, 2)).toEqual(first.rows);
  await expect(runEvaluation({ ...options, resume: true })).rejects.toThrow(/drop previously/);
});
