import { AIMessage, HumanMessage, ToolMessage, isAIMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createModel, getModelConfig, ProviderError, providerDiagnostic, requestSignal, structuredModel, tokenUsage } from "../lib/model";

const environment = { GEMINI_API_KEY: "test-secret", GEMINI_MODEL: "gemini-3.5-flash-lite" };
const response = (parts: object[], usageMetadata?: object, finishReason = "STOP") => new Response(JSON.stringify({
  candidates: [{ content: { role: "model", parts }, finishReason }], usageMetadata, modelVersion: "gemini-3.5-flash-lite",
}), { headers: { "Content-Type": "application/json" } });
const usage = { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 6, totalTokenCount: 22, cachedContentTokenCount: 3 };
const body = (request: Request) => request.clone().json();

beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); })));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("shared Gemini configuration", () => {
  it("uses the selected model and shared limits with thinking headroom", () => {
    const config = getModelConfig(environment);
    expect(config.model).toBe("gemini-3.5-flash-lite");
    expect(config.thinkingLevel).toBe("low");
    expect(config.limits).toEqual({
      maxOutputTokens: 2048, maxRunTokens: 64000, maxRounds: 2, maxModelAttempts: 20,
      maxToolAttempts: 20, deadlineMs: 120000, requestTimeoutMs: 20000,
      reportReserveMs: 25000, reportReserveTokens: 12288, reportReserveModelAttempts: 3,
      modelIntervalMs: 250, retryDelayMs: 1000, recursionLimit: 11,
    });
    expect(getModelConfig({ ...environment, INCIDENTLENS_MAX_RUN_TOKENS: "40000" }).limits.maxRunTokens).toBe(40000);
  });

  it.each([
    { GEMINI_API_KEY: "" }, { GEMINI_MODEL: " " }, { GEMINI_MODEL: "old-provider-model" },
    { GEMINI_THINKING_LEVEL: "minimal" }, { INCIDENTLENS_MAX_RUN_TOKENS: "NaN" },
    { INCIDENTLENS_MAX_ROUNDS: "1.5" }, { INCIDENTLENS_MAX_TOOL_ATTEMPTS: "0" },
    { INCIDENTLENS_MAX_RUN_TOKENS: "4096" }, { INCIDENTLENS_DEADLINE_MS: "1000" },
    { INCIDENTLENS_REQUEST_TIMEOUT_MS: "30000" }, { INCIDENTLENS_MAX_MODEL_ATTEMPTS: "2" },
    { INCIDENTLENS_MAX_OUTPUT_TOKENS: "13000" },
  ])("rejects invalid configuration without exposing secrets: %j", (override) => {
    expect(() => getModelConfig({ ...environment, ...override })).toThrow();
    try { getModelConfig({ ...environment, ...override }); }
    catch (error) { expect(providerDiagnostic(error)).not.toContain("test-secret"); }
  });
});

describe("native Gemini HTTP boundary (offline)", () => {
  it("maps the key explicitly and ignores ambient Google/Vertex credentials", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "wrong-key");
    vi.stubEnv("GOOGLE_CLOUD_CREDENTIALS", "invalid ambient credentials");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/does/not/exist");
    vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
    const fetch = vi.fn(async (_request: Request) => response([{ text: "READY" }], usage));
    vi.stubGlobal("fetch", fetch);
    const message = await createModel(getModelConfig(environment), 1024).invoke("hello");
    const request = fetch.mock.calls[0][0];
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(request.headers.get("x-goog-api-key")).toBe("test-secret");
    expect(request.headers.has("authorization")).toBe(false);
    const payload = await body(request);
    expect(payload.generationConfig).toMatchObject({ maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(payload.generationConfig).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("safetySettings");
    expect(tokenUsage(message)).toMatchObject({ input: 12, output: 10, total: 22, thinking: 6, cacheRead: 3, availability: "complete" });
  });

  it.each([429, 503])("does not hide retries for HTTP %s", async (status) => {
    const fetch = vi.fn(async () => new Response('{"error":{"message":"test-secret"}}', { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(createModel(getModelConfig(environment)).invoke("hello")).rejects.toMatchObject({ statusCode: status });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains safe native retry hints and project/day quota classification", async () => {
    for (const exhausted of [false, true]) {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ usageMetadata: usage, error: { message: "test-secret", details: [
        { retryDelay: "3s" }, { violations: [{ quotaId: exhausted ? "GenerateRequestsPerDayPerProject" : "GenerateRequestsPerMinute", quotaValue: "15" }] },
      ] } }), { status: 429, headers: { "Retry-After": "2", "Content-Type": "application/json" } }));
      vi.stubGlobal("fetch", fetch);
      await expect(createModel(getModelConfig(environment)).invoke("hello")).rejects.toMatchObject({
        statusCode: 429, quotaExhausted: exhausted, retryable: !exhausted, retryAfterMs: 3000,
        usage: { total: 22, thinking: 6, cacheRead: 3, availability: "complete" },
      });
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it.each([0, 2049, Infinity])("rejects a per-call output allowance outside the shared cap: %s", (tokens) => {
    expect(() => createModel(getModelConfig(environment), tokens)).toThrow(/Output token limit/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["parent", "timeout"])("cancels the native request on %s", async (mode) => {
    const fetch = vi.fn(async (request: Request) => new Promise<Response>((_resolve, reject) => {
      if (request.signal.aborted) reject(request.signal.reason);
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const config = getModelConfig({ ...environment, INCIDENTLENS_REQUEST_TIMEOUT_MS: mode === "timeout" ? "100" : "20000" });
    const controller = new AbortController();
    const pending = expect(createModel(config).invoke("hello", { signal: requestSignal(config, controller.signal) })).rejects.toThrow(/cancelled|timed out/);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    if (mode === "parent") controller.abort();
    await pending;
    expect(fetch.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it("preserves the tool call ID, name and thought signature through a real result message", async () => {
    const fetch = vi.fn(async (_request: Request) => response([{ text: "verified" }], usage));
    fetch.mockResolvedValueOnce(response([{ functionCall: { name: "provider_probe", args: { id: "probe" }, id: "call-1" }, thoughtSignature: "c2lnbmF0dXJl" }], usage));
    vi.stubGlobal("fetch", fetch);
    const model = createModel(getModelConfig(environment));
    const prompt = new HumanMessage("Call provider_probe.");
    const call = await model.bindTools([{ name: "provider_probe", description: "Test probe", schema: z.object({ id: z.string() }) }], { tool_choice: "provider_probe" }).invoke([prompt]);
    const result = new ToolMessage({ name: "provider_probe", tool_call_id: call.tool_calls![0].id!, content: '{"token":"verified"}' });
    await model.invoke([prompt, call, result]);
    const payload = await body(fetch.mock.calls[1][0]);
    expect(payload.contents).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "model", parts: expect.arrayContaining([expect.objectContaining({ thoughtSignature: "c2lnbmF0dXJl", functionCall: expect.objectContaining({ name: "provider_probe", id: "call-1" }) })]) }),
      expect.objectContaining({ parts: expect.arrayContaining([expect.objectContaining({ functionResponse: expect.objectContaining({ name: "provider_probe", id: "call-1", response: { result: '{"token":"verified"}' } }) })]) }),
    ]));
  });

  it.each([true, false])("validates native response schema, valid=%s, without hidden repairs", async (valid) => {
    const fetch = vi.fn(async (_request: Request) => response([{ text: JSON.stringify({ label: valid ? "ready" : 123 }) }], usage));
    vi.stubGlobal("fetch", fetch);
    const result = await structuredModel(createModel(getModelConfig(environment)), z.object({ label: z.string() })).invoke("Return JSON.");
    expect(result.parsed).toEqual(valid ? { label: "ready" } : null);
    expect(isAIMessage(result.raw) && tokenUsage(result.raw).total).toBe(22);
    const payload = await body(fetch.mock.calls[0][0]);
    expect(payload.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { type: "object", properties: { label: { type: "string" } } } });
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("response_format");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [undefined, { input: null, output: null, total: null, thinking: null, cacheRead: null, availability: "unavailable" }],
    [{ promptTokenCount: 8 }, { input: 8, output: null, total: null, availability: "partial" }],
    [{ promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }, { input: 0, output: 0, total: 0, availability: "complete" }],
    [{ ...usage, totalTokenCount: 99 }, { total: 99, output: 10, cacheRead: 3, availability: "partial" }],
  ])("preserves reported usage without assuming SDK zeros or recomputing totals", async (raw, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => response([{ text: "READY" }], raw)));
    expect(tokenUsage(await createModel(getModelConfig(environment)).invoke("hello"))).toMatchObject(expected);
  });

  it("keeps usage isolated across concurrent requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const payload = await body(request);
      const tokens = payload.contents[0].parts[0].text === "first" ? 11 : 27;
      return response([{ text: "READY" }], { promptTokenCount: tokens, candidatesTokenCount: 2, totalTokenCount: tokens + 2 });
    }));
    const model = createModel(getModelConfig(environment));
    const results = await Promise.all([model.invoke("first"), model.invoke("second")]);
    expect(results.map((message) => tokenUsage(message).input)).toEqual([11, 27]);
  });

  it.each(["empty", "blocked", "truncated"])("reports %s output safely and retains any usage", async (kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => kind === "blocked" ? new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: usage })) : response([], usage, kind === "truncated" ? "MAX_TOKENS" : "STOP")));
    try {
      await createModel(getModelConfig(environment)).invoke("hello");
      expect.fail("Expected an output failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).usage.total).toBe(22);
      expect(providerDiagnostic(error)).toMatch(/empty|blocked|allowance/);
    }
  });
});

it("keeps diagnostics secret-safe and distinguishes explicit quota exhaustion", () => {
  expect(providerDiagnostic({ statusCode: 401, message: "test-secret" })).toContain("GEMINI_API_KEY");
  const quota = { statusCode: 429, data: { error: { details: [{ violations: [{ quotaValue: "0" }] }] } }, message: "test-secret" };
  expect(providerDiagnostic(quota)).toContain("Quota exhausted");
  expect(providerDiagnostic(quota)).not.toContain("test-secret");
  expect(providerDiagnostic(new Error("test-secret"))).not.toContain("test-secret");
  expect(tokenUsage(new AIMessage("hello")).availability).toBe("unavailable");
});
