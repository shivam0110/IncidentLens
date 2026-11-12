import { AIMessage } from "@langchain/core/messages";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createAgentRunner } from "../lib/agents";
import { createBudget, createPacer, OutputError, type Clock } from "../lib/budget";
import { getModelConfig, ProviderError, providerFailure } from "../lib/model";
import { createToolContext } from "../lib/tools";

const config = () => getModelConfig({ GEMINI_API_KEY: "test-secret", GEMINI_MODEL: "gemini-3.5-flash-lite", INCIDENTLENS_MODEL_INTERVAL_MS: "0", INCIDENTLENS_RETRY_DELAY_MS: "0", INCIDENTLENS_MAX_RUN_TOKENS: "32000", INCIDENTLENS_REPORT_RESERVE_TOKENS: "4096", INCIDENTLENS_REPORT_RESERVE_MODEL_ATTEMPTS: "2" });
const raw = () => new AIMessage({ content: "done", response_metadata: { geminiUsage: {
  promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 6, totalTokenCount: 20, cachedContentTokenCount: 3,
} } });
const reasoning = { hypotheses: [], assumptions: [], unknowns: ["Evidence is insufficient."] };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
class ManualClock implements Clock {
  time = 0;
  timers = new Set<{ at: number; controller: AbortController }>();
  now = () => this.time;
  timer(ms: number) {
    const timer = { at: this.time + ms, controller: new AbortController() };
    this.timers.add(timer);
    return { signal: timer.controller.signal, dispose: () => { this.timers.delete(timer); } };
  }
  advance(ms: number) {
    this.time += ms;
    for (const timer of this.timers) if (timer.at <= this.time) {
      this.timers.delete(timer);
      timer.controller.abort();
    }
  }
}
function runner(options: { clock?: Clock; failures?: Parameters<typeof createAgentRunner>[0]["agentFailures"]; transport: Parameters<typeof createAgentRunner>[0]["transport"] }) {
  const settings = config();
  const budget = createBudget(settings, undefined, options.clock);
  return { budget, run: createAgentRunner({ config: settings, budget, tools: createToolContext("inc-001"), emit: () => {}, transport: options.transport, agentFailures: options.failures }) };
}

describe("bounded recovery and accounting", () => {
  it("keeps a CLI process alive until a real quota pacing wait completes", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { createPacer } from './lib/budget.ts';
      const pacer = createPacer(50), signal = new AbortController().signal;
      await pacer.wait(signal, () => 1000);
      await pacer.wait(signal, () => 1000);
      console.log('pacing completed');
    `], { cwd: process.cwd(), timeout: 5000 });
    expect(stdout.trim()).toBe("pacing completed");
  });

  it("aborts a timed-out request, retries once, and keeps missing usage incomplete", async () => {
    const clock = new ManualClock();
    const signals: AbortSignal[] = [];
    const { budget, run } = runner({ clock, transport: async ({ signal }) => {
      signals.push(signal);
      if (signals.length === 1) return new Promise(() => {});
      return { raw: raw(), parsed: reasoning };
    } });
    const result = run("Reasoning", { context: {} });
    await flush();
    clock.advance(20000);
    expect(await result).toEqual(reasoning);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(budget.snapshot()).toMatchObject({ modelAttempts: 2, elapsedMs: 20000, usage: { total: 20, output: 10, thinking: 6, cacheRead: 3, availability: "partial" } });
    budget.dispose();
  });

  it("recovers a transient failure followed by invalid output within three total attempts", async () => {
    let attempts = 0;
    const { budget, run } = runner({ transport: async () => {
      if (++attempts === 1) throw new ProviderError({ statusCode: 503 });
      return { raw: raw(), parsed: attempts === 2 ? {} : reasoning };
    } });
    expect(await run("Reasoning", { context: {} })).toEqual(reasoning);
    expect(attempts).toBe(3);
    expect(budget.snapshot()).toMatchObject({ modelAttempts: 3, usage: { availability: "partial" } });
    budget.dispose();
  });

  it("repairs invalid output once and exhausts a persistent invalid-output failure", async () => {
    for (const persistent of [false, true]) {
      let attempts = 0;
      const { budget, run } = runner({ transport: async () => ({ raw: raw(), parsed: ++attempts === 1 || persistent ? {} : reasoning }) });
      if (persistent) await expect(run("Reasoning", { context: {} })).rejects.toThrow(OutputError);
      else expect(await run("Reasoning", { context: {} })).toEqual(reasoning);
      expect(budget.snapshot().modelAttempts).toBe(2);
      budget.dispose();
    }
  });

  it("applies generic failure schedules deterministically and counts injected attempts", async () => {
    for (let runIndex = 0; runIndex < 2; runIndex++) {
      let calls = 0;
      const { budget, run } = runner({ failures: [{ role: "Reasoning", attempt: 1 }], transport: async () => { calls++; return { raw: raw(), parsed: reasoning }; } });
      expect(await run("Reasoning", { context: {} })).toEqual(reasoning);
      expect(calls).toBe(1);
      expect(budget.snapshot()).toMatchObject({ modelAttempts: 2, usage: { total: 20, availability: "partial" } });
      budget.dispose();
    }
  });

  it.each([400, 401, 403, 404])("does not retry permanent HTTP %s", async (statusCode) => {
    let calls = 0;
    const { budget, run } = runner({ transport: async () => { calls++; throw new ProviderError({ statusCode, message: "test-secret" }); } });
    await expect(run("Reasoning", { context: {} })).rejects.not.toThrow(/test-secret/);
    expect(calls).toBe(1);
    expect(budget.snapshot().modelAttempts).toBe(1);
    budget.dispose();
  });

  it.each(["PromptBlockedError", "NoCandidatesError", "MalformedOutputError"])("does not retry or bypass %s", async (name) => {
    let calls = 0;
    const { budget, run } = runner({ transport: async () => { calls++; throw new ProviderError({ name }); } });
    await expect(run("Reasoning", { context: {} })).rejects.toThrow(/empty|blocked|invalid/);
    expect(calls).toBe(1);
    expect(budget.snapshot().usage.total).toBeNull();
    budget.dispose();
  });

  it("admits concurrent model reservations atomically and preserves reporting tokens", async () => {
    const setting = config();
    setting.limits.maxRunTokens = 7000;
    const budget = createBudget(setting);
    let release!: () => void;
    const first = budget.model(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { raw: raw() }; }, 800);
    await expect(budget.model(async () => ({ raw: raw() }), 800)).rejects.toThrow(/Token budget/);
    release();
    await first;
    await budget.model(async () => ({ raw: raw() }), 800, true);
    expect(budget.snapshot().modelAttempts).toBe(2);
    budget.dispose();
  });

  it("bounds concurrent tools and propagates cancellation to a tool in flight", async () => {
    const setting = config();
    setting.limits.maxToolAttempts = 1;
    const controller = new AbortController();
    const budget = createBudget(setting, controller.signal);
    let signal!: AbortSignal;
    const first = budget.tool(async (abort) => { signal = abort; return new Promise(() => {}); });
    const stopped = expect(first).rejects.toThrow(/cancelled/);
    await expect(budget.tool(async () => 2)).rejects.toThrow(/Tool attempt/);
    controller.abort();
    await stopped;
    expect(signal.aborted).toBe(true);
    expect(budget.snapshot().toolAttempts).toBe(1);
    budget.dispose();
  });

  it("uses monotonic admission checks for gathering/reporting deadlines and preserves the reserve", async () => {
    const clock = new ManualClock();
    const budget = createBudget(config(), undefined, clock);
    // Move the monotonic clock without firing timers: admission must still enforce the boundary.
    clock.time = 95000;
    await expect(budget.model(async () => ({ raw: raw() }), 10)).rejects.toThrow(/reporting time/);
    await budget.model(async () => ({ raw: raw() }), 10, true);
    clock.time = 120000;
    await expect(budget.model(async () => ({ raw: raw() }), 10, true)).rejects.toThrow(/deadline/);
    expect(budget.snapshot()).toMatchObject({ modelAttempts: 1, elapsedMs: 120000 });
    budget.dispose();
  });

  it("does not let a late timed-out response rewrite returned usage", async () => {
    const clock = new ManualClock();
    const budget = createBudget(config(), undefined, clock);
    let release!: (result: { raw: AIMessage }) => void;
    const pending = budget.model(() => new Promise((resolve) => { release = resolve; }), 10);
    const timeout = expect(pending).rejects.toThrow(/timed out/);
    await flush();
    clock.advance(20000);
    await timeout;
    release({ raw: raw() });
    await flush();
    expect(budget.snapshot().usage).toMatchObject({ total: null, availability: "unavailable" });
    budget.dispose();
  });

  it("aborts reporting at the overall deadline and stops further requests", async () => {
    const clock = new ManualClock();
    const budget = createBudget(config(), undefined, clock);
    let signal!: AbortSignal;
    clock.time = 110000;
    const pending = expect(budget.model(async (abort) => { signal = abort; return new Promise(() => {}); }, 10, true)).rejects.toThrow(/deadline/);
    await flush();
    clock.advance(10000);
    await pending;
    expect(signal.aborted).toBe(true);
    await expect(budget.tool(async () => 1)).rejects.toThrow(/deadline/);
    expect(budget.snapshot()).toMatchObject({ modelAttempts: 1, toolAttempts: 0, usage: { total: null } });
    budget.dispose();
  });

  it("retains usage and stops if the provider reports output above the requested cap", async () => {
    const budget = createBudget(config());
    const message = raw();
    message.response_metadata.geminiUsage = { promptTokenCount: 10, candidatesTokenCount: 2049, totalTokenCount: 2059 };
    await expect(budget.model(async () => ({ raw: message }), 10)).rejects.toThrow(/per-call output/);
    await expect(budget.model(async () => ({ raw: raw() }), 10, true)).rejects.toThrow(/per-call output/);
    expect(budget.snapshot()).toMatchObject({ modelAttempts: 1, usage: { total: 2059, output: 2049 } });
    budget.dispose();
  });
});

describe("quota pacing", () => {
  it("spaces starts across budgets without waiting for independent requests to finish", async () => {
    const clock = new ManualClock();
    const pacer = createPacer(100, clock);
    const firstBudget = createBudget(config(), undefined, clock, pacer);
    const secondBudget = createBudget(config(), undefined, clock, pacer);
    const starts: number[] = [];
    const releases: (() => void)[] = [];
    const invoke = (budget: typeof firstBudget) => budget.model(async () => {
      starts.push(clock.now());
      await new Promise<void>((resolve) => releases.push(resolve));
      return { raw: raw() };
    }, 10);
    const first = invoke(firstBudget), second = invoke(secondBudget);
    await flush();
    expect(starts).toEqual([0]);
    clock.advance(100);
    await flush();
    expect(starts).toEqual([0, 100]);
    releases.forEach((release) => release());
    await Promise.all([first, second]);
    firstBudget.dispose(); secondBudget.dispose();
  });

  it("honors temporary 429 retry hints and includes the wait in latency", async () => {
    const clock = new ManualClock();
    let calls = 0;
    const { budget, run } = runner({ clock, transport: async () => {
      if (++calls === 1) throw new ProviderError({ statusCode: 429, data: { error: { details: [
        { violations: [{ quotaId: "GenerateRequestsPerMinute", quotaValue: "15" }] }, { retryDelay: "2s" },
      ] } } });
      return { raw: raw(), parsed: reasoning };
    } });
    const pending = run("Reasoning", { context: {} });
    await flush();
    clock.advance(1999);
    await flush();
    expect(calls).toBe(1);
    clock.advance(1);
    expect(await pending).toEqual(reasoning);
    expect(budget.snapshot()).toMatchObject({ modelAttempts: 2, elapsedMs: 2000 });
    budget.dispose();
  });

  it("stops explicitly on day/project exhaustion and never sends a reporting retry", async () => {
    const budget = createBudget(config());
    const error = new ProviderError({ statusCode: 429, data: { error: { details: [
      { violations: [{ quotaId: "GenerateRequestsPerDayPerProject", quotaValue: "20" }] }, { retryDelay: "3600s" },
    ] } } });
    expect(error).toMatchObject({ quotaExhausted: true, retryable: false, retryAfterMs: 3600000 });
    await expect(budget.model(async () => { throw error; }, 10)).rejects.toThrow(/Quota exhausted/);
    await expect(budget.model(async () => ({ raw: raw() }), 10, true)).rejects.toThrow(/quota exhausted/);
    expect(budget.snapshot().modelAttempts).toBe(1);
    budget.dispose();
  });

  it("refuses retry hints exceeding the gathering deadline without another attempt", async () => {
    const { budget, run } = runner({ clock: new ManualClock(), transport: async () => {
      throw new ProviderError({ statusCode: 429, data: { error: { details: [{ retryDelay: "96s" }] } } });
    } });
    await expect(run("Reasoning", { context: {} })).rejects.toThrow(/cannot fit/);
    expect(budget.snapshot().modelAttempts).toBe(1);
    budget.dispose();
  });

  it("cancels a queued model request before it can consume an attempt", async () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    const pacer = createPacer(100, clock);
    const budget = createBudget(config(), controller.signal, clock, pacer);
    await budget.model(async () => ({ raw: raw() }), 10);
    const pending = expect(budget.model(async () => ({ raw: raw() }), 10)).rejects.toThrow(/cancelled/);
    await flush();
    controller.abort();
    await pending;
    expect(budget.snapshot().modelAttempts).toBe(1);
    budget.dispose();
  });

  it("wakes queued callers immediately when shared quota is exhausted", async () => {
    const clock = new ManualClock();
    const pacer = createPacer(1000, clock);
    const budget = createBudget(config(), undefined, clock, pacer);
    await budget.model(async () => ({ raw: raw() }), 10);
    const pending = expect(budget.model(async () => ({ raw: raw() }), 10)).rejects.toThrow(/quota exhausted/);
    await flush();
    pacer.stop("Project quota exhausted; pause.");
    await pending;
    expect(budget.snapshot()).toMatchObject({ modelAttempts: 1, elapsedMs: 0 });
    budget.dispose();
  });

  it("keeps uncertain 429s explicit and classifies unavailable quotas conservatively", () => {
    expect(providerFailure({ statusCode: 429 })).toMatchObject({ retryable: true, quotaExhausted: false });
    expect(providerFailure({ statusCode: 429, data: { error: { details: [{ violations: [{ quotaValue: "0" }] }] } } })).toMatchObject({ retryable: false, quotaExhausted: true });
    expect(providerFailure({ statusCode: 429, message: "Daily quota limit exhausted test-secret" })).toMatchObject({ retryable: false, quotaExhausted: true });
  });
});
