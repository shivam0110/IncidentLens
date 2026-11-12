import { performance } from "node:perf_hooks";
import { ProviderError, providerDiagnostic, tokenUsage, type ModelConfig } from "./model";
import type { AIMessage } from "@langchain/core/messages";
import type { Usage } from "./schemas";

export class RunError extends Error {}
export class OutputError extends RunError {}
export class RequestTimeout extends RunError {}
export type ModelResponse = { raw: AIMessage; parsed?: unknown };
export type Clock = {
  now(): number;
  timer(ms: number): { signal: AbortSignal; dispose(): void };
};
export const monotonicClock: Clock = {
  now: () => performance.now(),
  timer(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, ms));
    return { signal: controller.signal, dispose: () => clearTimeout(timer) };
  },
};
const emptyUsage = (): Usage => ({ input: null, output: null, total: null, visibleOutput: null, thinking: null, cacheRead: null, toolUsePrompt: null, availability: "unavailable" });

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, error: () => Error) {
  if (signal.aborted) throw error();
  let rejectAbort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(error());
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([operation(signal), cancelled]); }
  finally { signal.removeEventListener("abort", rejectAbort); }
}

// Share this object across runs when evaluation needs project-wide pacing. Only starts are spaced;
// requests already running remain concurrent. A throttle hint delays every waiting caller.
export function createPacer(intervalMs: number, clock: Clock = monotonicClock) {
  let nextStart = 0, blockedUntil = 0;
  let stopped: string | null = null;
  let changed = new AbortController();
  function wake() { const previous = changed; changed = new AbortController(); previous.abort(); }
  return {
    get stopped() { return stopped; },
    stop(reason: string) { stopped = reason; wake(); },
    defer(ms: number) { blockedUntil = Math.max(blockedUntil, clock.now() + ms); wake(); },
    async wait(signal: AbortSignal, remaining: () => number) {
      for (;;) {
        if (stopped) throw new RunError(stopped);
        if (signal.aborted) throw new RunError("Run cancelled or deadline reached while waiting for quota pacing.");
        const delay = Math.max(nextStart, blockedUntil) - clock.now();
        if (remaining() <= Math.max(0, delay)) throw new RunError("Quota/pacing wait cannot fit within the remaining deadline.");
        if (delay <= 0) { nextStart = clock.now() + intervalMs; return; }
        const timer = clock.timer(delay);
        try {
          const wait = AbortSignal.any([signal, timer.signal, changed.signal]);
          await new Promise<void>((resolve) => { if (wait.aborted) resolve(); else wait.addEventListener("abort", () => resolve(), { once: true }); });
        } finally { timer.dispose(); }
      }
    },
  };
}
export type Pacer = ReturnType<typeof createPacer>;

export function createBudget(config: ModelConfig, parent?: AbortSignal, clock: Clock = monotonicClock,
  pacer = createPacer(config.limits.modelIntervalMs, clock)) {
  const started = clock.now();
  const { limits } = config;
  const deadline = clock.timer(limits.deadlineMs);
  const gathering = clock.timer(limits.deadlineMs - limits.reportReserveMs);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const usage: Usage[] = [];
  let modelAttempts = 0, toolAttempts = 0, inFlightTokens = 0;
  let violation: string | null = null;
  const elapsed = () => Math.max(0, clock.now() - started);
  const remaining = (reporting = false) => limits.deadlineMs - elapsed() - (reporting ? 0 : limits.reportReserveMs);
  const reportedTotal = () => usage.reduce((sum, item) => sum + (item.total ?? 0), 0);
  function check(reporting = false, model = true) {
    if (signal.aborted || remaining(true) <= 0) throw new RunError(parent?.aborted ? "Run cancelled." : "Run deadline reached.");
    if (!reporting && (gathering.signal.aborted || remaining() <= 0)) throw new RunError("Gathering deadline reached; reporting time reserved.");
    if (pacer.stopped) throw new RunError(pacer.stopped);
    if (violation) throw new RunError(violation);
    if (reportedTotal() >= limits.maxRunTokens) throw new RunError("Reported token limit reached.");
    if (model && modelAttempts >= limits.maxModelAttempts - (reporting ? 0 : limits.reportReserveModelAttempts)) {
      throw new RunError("Model attempt limit reached; reporting capacity reserved.");
    }
  }
  function record(slot: number, value: Usage) {
    usage[slot] = value;
    if (value.output !== null && value.output > limits.maxOutputTokens) violation = "Provider-reported output exceeded the per-call output/thinking cap.";
    else if (reportedTotal() > limits.maxRunTokens) violation = "Reported token limit exceeded.";
  }
  function gatheringStop() {
    try {
      check();
      if (toolAttempts >= limits.maxToolAttempts) return "Tool attempt limit reached.";
      if (reportedTotal() + inFlightTokens + limits.maxOutputTokens > limits.maxRunTokens - limits.reportReserveTokens) return "Token gathering allowance exhausted; reporting tokens reserved.";
      return null;
    } catch (error) { return safeError(error); }
  }
  async function request<T>(operation: (signal: AbortSignal) => Promise<T>, reporting = false) {
    const started = clock.now();
    const timeout = clock.timer(Math.min(limits.requestTimeoutMs, remaining(reporting)));
    const abort = AbortSignal.any(reporting ? [signal, timeout.signal] : [signal, gathering.signal, timeout.signal]);
    try {
      const timeoutError = () => {
        if (signal.aborted || remaining(true) <= 0) return new RunError(parent?.aborted ? "Run cancelled." : "Run deadline reached.");
        if (!reporting && remaining() <= 0) return new RunError("Gathering deadline reached; reporting time reserved.");
        return new RequestTimeout("Request timed out.");
      };
      const result = await bounded(operation, abort, timeoutError);
      if (remaining(reporting) <= 0 || clock.now() - started >= limits.requestTimeoutMs) throw timeoutError();
      return result;
    } finally { timeout.dispose(); }
  }
  return {
    limits, signal, elapsed, remaining, check, gatheringStop, violation: () => violation,
    dispose() { deadline.dispose(); gathering.dispose(); },
    canGather: () => gatheringStop() === null,
    defer: (ms: number) => pacer.defer(ms),
    async model(operation: (signal: AbortSignal) => Promise<ModelResponse>, inputEstimate: number, reporting = false) {
      check(reporting);
      // Pacing precedes admission. Re-check after waiting; concurrent callers claim slots atomically.
      await pacer.wait(reporting ? signal : AbortSignal.any([signal, gathering.signal]), () => remaining(reporting));
      check(reporting);
      const reserved = inputEstimate + limits.maxOutputTokens;
      if (!Number.isFinite(inputEstimate) || inputEstimate < 0 || reportedTotal() + inFlightTokens + reserved > limits.maxRunTokens - (reporting ? 0 : limits.reportReserveTokens)) {
        throw new RunError("Token budget cannot admit another request; reporting tokens reserved.");
      }
      modelAttempts++;
      inFlightTokens += reserved;
      const slot = usage.push(emptyUsage()) - 1;
      let active = true;
      try {
        return await request(async (abort) => {
          try {
            const result = await operation(abort);
            if (active) {
              record(slot, tokenUsage(result.raw));
              if (violation) throw new RunError(violation);
            }
            return result;
          } catch (error) {
            if (active && error instanceof ProviderError) {
              record(slot, error.usage);
              if (error.quotaExhausted) pacer.stop("Gemini project/day quota exhausted or unavailable; pause until quota is restored.");
              else if (error.retryable) pacer.defer(Math.max(limits.retryDelayMs, error.retryAfterMs));
            }
            throw error;
          }
        }, reporting);
      } finally {
        active = false;
        inFlightTokens -= reserved;
      }
    },
    async tool<T>(operation: (signal: AbortSignal) => Promise<T>) {
      check(false, false);
      if (toolAttempts >= limits.maxToolAttempts) throw new RunError("Tool attempt limit reached.");
      toolAttempts++;
      return request(operation);
    },
    snapshot() {
      const sum = (field: Exclude<keyof Usage, "availability">) => usage.some((item) => item[field] !== null)
        ? usage.reduce((total, item) => total + (item[field] ?? 0), 0) : null;
      return {
        toolAttempts, modelAttempts, elapsedMs: elapsed(),
        usage: {
          input: sum("input"), output: sum("output"), total: sum("total"), visibleOutput: sum("visibleOutput"),
          thinking: sum("thinking"), cacheRead: sum("cacheRead"), toolUsePrompt: sum("toolUsePrompt"),
          availability: usage.length > 0 && usage.every((item) => item.availability === "complete")
            ? "complete" as const : usage.some((item) => item.availability !== "unavailable") ? "partial" as const : "unavailable" as const,
        },
      };
    },
  };
}
export type Budget = ReturnType<typeof createBudget>;
export function safeError(error: unknown) {
  return error instanceof RunError ? error.message : providerDiagnostic(error);
}
