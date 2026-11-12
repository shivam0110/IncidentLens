import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "node:process";
import { ChatGoogle } from "@langchain/google/node";
import type { AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { Usage } from "./schemas";

const integer = (fallback: number) => z.preprocess(
  (value) => value === undefined || value === "" ? fallback : Number(value), z.number().int().positive(),
);
const nonnegative = (fallback: number) => z.preprocess(
  (value) => value === undefined || value === "" ? fallback : Number(value), z.number().int().nonnegative(),
);
const environment = z.object({
  GEMINI_API_KEY: z.string().trim().min(1),
  GEMINI_MODEL: z.string().trim().regex(/^gemini-[\w.-]+$/),
  GEMINI_THINKING_LEVEL: z.enum(["low", "medium", "high"]).default("low"),
  INCIDENTLENS_MAX_OUTPUT_TOKENS: integer(2048),
  INCIDENTLENS_MAX_RUN_TOKENS: integer(64000),
  INCIDENTLENS_MAX_ROUNDS: integer(2),
  INCIDENTLENS_MAX_MODEL_ATTEMPTS: integer(20),
  INCIDENTLENS_MAX_TOOL_ATTEMPTS: integer(20),
  INCIDENTLENS_DEADLINE_MS: integer(120000),
  INCIDENTLENS_REQUEST_TIMEOUT_MS: integer(20000),
  INCIDENTLENS_REPORT_RESERVE_MS: integer(25000),
  INCIDENTLENS_REPORT_RESERVE_TOKENS: integer(12288),
  INCIDENTLENS_REPORT_RESERVE_MODEL_ATTEMPTS: integer(3),
  INCIDENTLENS_MODEL_INTERVAL_MS: nonnegative(250),
  INCIDENTLENS_RETRY_DELAY_MS: nonnegative(1000),
  INCIDENTLENS_RECURSION_LIMIT: z.preprocess((value) => value === "" ? undefined : value === undefined ? undefined : Number(value), z.number().int().positive().optional()),
});

export class ConfigurationError extends Error {}

export function getModelConfig(source: Record<string, string | undefined> = env) {
  const parsed = environment.safeParse(source);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]))];
    throw new ConfigurationError(`Set valid ${fields.join(", ")} in .env.local.`);
  }
  const data = parsed.data;
  const limits = {
    maxOutputTokens: data.INCIDENTLENS_MAX_OUTPUT_TOKENS,
    maxRunTokens: data.INCIDENTLENS_MAX_RUN_TOKENS,
    maxRounds: data.INCIDENTLENS_MAX_ROUNDS,
    maxModelAttempts: data.INCIDENTLENS_MAX_MODEL_ATTEMPTS,
    maxToolAttempts: data.INCIDENTLENS_MAX_TOOL_ATTEMPTS,
    deadlineMs: data.INCIDENTLENS_DEADLINE_MS,
    requestTimeoutMs: data.INCIDENTLENS_REQUEST_TIMEOUT_MS,
    reportReserveMs: data.INCIDENTLENS_REPORT_RESERVE_MS,
    reportReserveTokens: data.INCIDENTLENS_REPORT_RESERVE_TOKENS,
    reportReserveModelAttempts: data.INCIDENTLENS_REPORT_RESERVE_MODEL_ATTEMPTS,
    modelIntervalMs: data.INCIDENTLENS_MODEL_INTERVAL_MS,
    retryDelayMs: data.INCIDENTLENS_RETRY_DELAY_MS,
    recursionLimit: data.INCIDENTLENS_RECURSION_LIMIT ?? data.INCIDENTLENS_MAX_ROUNDS * 4 + 3,
  };
  if (limits.maxOutputTokens > limits.reportReserveTokens || limits.reportReserveTokens >= limits.maxRunTokens ||
      limits.requestTimeoutMs > limits.reportReserveMs || limits.reportReserveMs >= limits.deadlineMs ||
      limits.reportReserveModelAttempts >= limits.maxModelAttempts) {
    throw new ConfigurationError("Invalid INCIDENTLENS limits: reporting reserves must fit within the run and cover a model request.");
  }
  return { apiKey: data.GEMINI_API_KEY, model: data.GEMINI_MODEL, thinkingLevel: data.GEMINI_THINKING_LEVEL, limits };
}

export type ModelConfig = ReturnType<typeof getModelConfig>;
const usageFields = ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount", "cachedContentTokenCount", "toolUsePromptTokenCount"] as const;
type ReportedUsage = Partial<Record<typeof usageFields[number], number>>;
const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

function normalizeUsage(raw: ReportedUsage = {}): Usage {
  const input = count(raw.promptTokenCount);
  const visibleOutput = count(raw.candidatesTokenCount);
  const thinking = count(raw.thoughtsTokenCount);
  const output = visibleOutput === null ? null : visibleOutput + (thinking ?? 0);
  const total = count(raw.totalTokenCount);
  const toolUsePrompt = count(raw.toolUsePromptTokenCount);
  return {
    input, output, total, visibleOutput, thinking,
    cacheRead: count(raw.cachedContentTokenCount), toolUsePrompt,
    availability: input !== null && output !== null && total !== null && total === input + output + (toolUsePrompt ?? 0) ? "complete" as const :
      Object.values(raw).some((value) => count(value) !== null) ? "partial" as const : "unavailable" as const,
  };
}

export function tokenUsage(message: AIMessage) {
  // LangChain synthesizes zero counts and totals. Use only captured provider fields.
  return normalizeUsage(message.response_metadata.geminiUsage as ReportedUsage | undefined);
}

export class ProviderError extends Error {
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly quotaExhausted: boolean;
  readonly retryAfterMs: number;
  constructor(error: unknown, readonly usage = normalizeUsage()) {
    super(providerDiagnostic(error));
    const policy = providerFailure(error);
    this.statusCode = policy.statusCode;
    this.retryable = policy.retryable;
    this.quotaExhausted = policy.quotaExhausted;
    this.retryAfterMs = policy.retryAfterMs;
  }
}

// Retain only safe classification and numeric retry hints, never raw provider errors.
export function providerFailure(error: unknown) {
  if (error instanceof ProviderError) return error;
  const failure = error as { statusCode?: number; name?: string; message?: string; data?: { error?: { message?: string; details?: {
    retryDelay?: string; violations?: { quotaId?: string; quotaValue?: string | number; quotaMetric?: string }[];
  }[] } }; retryAfterMs?: number } | null;
  const details = Array.isArray(failure?.data?.error?.details) ? failure.data.error.details : [];
  const violations = details.flatMap((detail) => Array.isArray(detail.violations) ? detail.violations : []);
  const message = `${failure?.message ?? ""} ${failure?.data?.error?.message ?? ""}`;
  const quotaExhausted = failure?.statusCode === 429 && (violations.some((item) =>
    Number(item.quotaValue) === 0 || /perday|daily/i.test(`${item.quotaId ?? ""} ${item.quotaMetric ?? ""}`)) ||
    /(?:daily|per[\s_-]?day).{0,60}(?:quota|limit)|(?:quota|limit).{0,60}(?:daily|per[\s_-]?day)|project quota (?:is )?exhausted|(?:credit|billing).{0,40}(?:exhausted|insufficient)/i.test(message));
  const delays = details.flatMap((detail) => typeof detail.retryDelay === "string" && /^\d+(\.\d+)?s$/.test(detail.retryDelay)
    ? [Number.parseFloat(detail.retryDelay) * 1000] : []);
  const hint = failure?.retryAfterMs;
  return {
    statusCode: failure?.statusCode, quotaExhausted,
    retryAfterMs: Math.max(0, ...delays, typeof hint === "number" && Number.isFinite(hint) ? hint : 0),
    retryable: !quotaExhausted && ([408, 429, 500, 502, 503, 504].includes(failure?.statusCode ?? 0) ||
      ["TimeoutError", "AbortError", "TypeError"].includes(failure?.name ?? "")),
  };
}

export function requestSignal(config: ModelConfig, parent?: AbortSignal) {
  const timeout = AbortSignal.timeout(config.limits.requestTimeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

// The native client hook isolates key auth and captures only reported usage per call.
class GeminiModel extends ChatGoogle {
  private readonly context: AsyncLocalStorage<{ usage?: ReportedUsage }>;
  constructor(private readonly config: ModelConfig, outputTokens: number) {
    const context = new AsyncLocalStorage<{ usage?: ReportedUsage }>();
    super({
      apiKey: config.apiKey, model: config.model, platformType: "gai", apiHandler: "generateContent",
      maxOutputTokens: outputTokens, thinkingLevel: config.thinkingLevel,
      maxRetries: 0, streaming: false, disableStreaming: true,
      apiClient: {
        hasApiKey: () => true,
        async getProjectId() { throw new ConfigurationError("Vertex AI is not configured."); },
        async fetch(request) {
          request.headers.set("x-goog-api-key", config.apiKey);
          const response = await fetch(request);
          const data = await response.clone().json().catch(() => null);
          const state = context.getStore();
          if (state) state.usage = Object.fromEntries(usageFields.flatMap((field) =>
            count(data?.usageMetadata?.[field]) === null ? [] : [[field, data.usageMetadata[field]]],
          ));
          if (!response.ok) {
            const retry = response.headers.get("retry-after");
            const retryAfterMs = retry === null ? 0 : /^\d+(\.\d+)?$/.test(retry)
              ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
            throw new ProviderError({ statusCode: response.status, data, retryAfterMs }, normalizeUsage(state?.usage));
          }
          return response;
        },
      },
    });
    this.context = context;
  }

  override async _generate(...[messages, options, manager]: Parameters<ChatGoogle["_generate"]>) {
    const state: { usage?: ReportedUsage } = {};
    return this.context.run(state, async () => {
      try {
        const result = await super._generate(messages, { ...options, maxRetries: 0, signal: requestSignal(this.config, options.signal) }, manager);
        for (const generation of result.generations) {
          const message = generation.message as AIMessage;
          message.response_metadata.geminiUsage = state.usage ?? {};
          if (!message.text.trim() && !message.tool_calls?.length) {
            throw new ConfigurationError(message.response_metadata.finish_reason === "MAX_TOKENS" ?
              "Gemini exhausted the output/thinking allowance before returning content." : "Gemini returned empty or blocked output. Safety settings are unchanged.");
          }
        }
        return result;
      } catch (error) {
        throw new ProviderError(error, normalizeUsage(state.usage));
      }
    });
  }
}

export function createModel(config = getModelConfig(), outputTokens = config.limits.maxOutputTokens) {
  if (!Number.isInteger(outputTokens) || outputTokens < 1 || outputTokens > config.limits.maxOutputTokens) {
    throw new ConfigurationError("Output token limit must be positive and within INCIDENTLENS_MAX_OUTPUT_TOKENS.");
  }
  return new GeminiModel(config, outputTokens);
}

// Gathering and schema-based reporting use separate requests, preserving messages.
export function structuredModel<T extends z.ZodObject>(model: ChatGoogle, schema: T) {
  return model.withStructuredOutput(schema, { method: "jsonSchema", includeRaw: true });
}

export function providerDiagnostic(error: unknown): string {
  if (error instanceof ConfigurationError || error instanceof ProviderError) return error.message;
  const failure = error as { statusCode?: number; name?: string; data?: { error?: { details?: { violations?: { quotaId?: string; quotaValue?: string }[] }[] } } } | null;
  if (["AbortError", "TimeoutError"].includes(failure?.name ?? "")) return "Gemini request cancelled or timed out within the configured deadline.";
  if (["PromptBlockedError", "PromptRefusedError", "NoCandidatesError", "MalformedOutputError"].includes(failure?.name ?? "")) {
    return "Gemini returned empty, blocked, or invalid output. Safety settings are unchanged.";
  }
  const status = failure?.statusCode;
  const exhausted = providerFailure(error).quotaExhausted;
  const hints: Record<number, string> = {
    400: "Check GEMINI_API_KEY, GEMINI_MODEL, and supported thinking/schema settings.",
    401: "Check GEMINI_API_KEY and AI Studio key access.",
    403: "Check AI Studio API-key restrictions, project permissions, and regional availability.",
    404: "Check GEMINI_MODEL is available through the Gemini Developer API for this project.",
    408: "Request timed out.",
    429: exhausted ? "Quota exhausted or unavailable. Check active free-tier quotas in AI Studio; do not retry blindly." :
      "Quota or throttling limit reached. Check AI Studio limits; bounded waits/retries must fit within the run deadline.",
  };
  return status ? `Gemini HTTP ${status}. ${hints[status] ?? "Provider request failed; check service availability."}` :
    "Gemini request failed. Check connectivity and AI Studio access. Raw errors are omitted to protect credentials.";
}
