import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInvestigationStream, roleStatuses, type StreamEvent } from "../components/investigation-stream";
import type { ProgressEvent, Report } from "../lib/schemas";
import * as model from "../lib/model";
import { investigate } from "../lib/investigation";
import { investigateBaseline } from "../lib/baseline";
import { POST } from "../app/api/investigate/route";
import { readEvaluation } from "../app/dashboard-data";

vi.mock("server-only", () => ({}));
vi.mock("../lib/investigation", () => ({ investigate: vi.fn() }));
vi.mock("../lib/baseline", () => ({ investigateBaseline: vi.fn() }));

const event = (overrides: Partial<ProgressEvent> = {}): ProgressEvent => ({ sequence: 1, elapsedMs: 1, type: "role", role: "Orchestrator", status: "running", taskId: null, tool: null, round: 1, message: "Started", evidenceIds: [], ...overrides });
const report: Report = { incidentId: "inc-001", outcome: "inconclusive", summary: "No conclusion.", hypotheses: [], observedFacts: [], assumptions: [], unknowns: [], actions: [], limitations: [], failures: [], stopReason: "No evidence.",
  stats: { modelAttempts: 1, toolAttempts: 0, elapsedMs: 1, usage: { input: null, output: null, total: null, visibleOutput: null, thinking: null, cacheRead: null, toolUsePrompt: null, availability: "unavailable" } } };
function stream(parts: Uint8Array[]) { return new ReadableStream<Uint8Array>({ start(controller) { parts.forEach((part) => controller.enqueue(part)); controller.close(); } }); }
function request(body: unknown = { incidentId: "inc-001", mode: "multi-agent" }) { return new Request("http://localhost:3000/api/investigate", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }); }
function configure() { vi.spyOn(model, "getModelConfig").mockReturnValue(model.getModelConfig({ GEMINI_API_KEY: "unit-test-only", GEMINI_MODEL: "gemini-test" })); }
function result() { return { report, state: { evidence: {}, privateMarker: "PRIVATE_STATE" }, tracePath: "PRIVATE_PATH", toolHistory: [{ failureSchedule: "PRIVATE_SCHEDULE" }] } as unknown as Awaited<ReturnType<typeof investigate>>; }
afterEach(() => vi.restoreAllMocks());

describe("investigation streaming", () => {
  it("parses split JSON and split UTF-8, including an unterminated final line", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "progress", event: event({ message: "Evidence → café" }) }) + "\n" + JSON.stringify({ type: "result", report, evidence: [] }));
    const received: StreamEvent[] = [];
    await readInvestigationStream(stream([...bytes].map((byte) => Uint8Array.of(byte))), (value) => received.push(value));
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ event: { message: "Evidence → café" } });
  });
  it("rejects interrupted and malformed streams without treating complete progress as a final report", async () => {
    const encode = (text: string) => stream([new TextEncoder().encode(text)]);
    await expect(readInvestigationStream(encode(JSON.stringify({ type: "progress", event: event({ type: "complete" }) })), () => {})).rejects.toThrow("interrupted");
    await expect(readInvestigationStream(encode('{"type":"result"}'), () => {})).rejects.toThrow("Invalid investigation stream");
    const received: StreamEvent[] = [];
    await readInvestigationStream(encode('{"type":"error","message":"Check quota."}\n'), (value) => received.push(value));
    expect(received).toEqual([{ type: "error", message: "Check quota." }]);
  });
  it("derives concurrent and skipped roles from real events and resets independently", () => {
    const events = [event({ role: "Observability", type: "task", taskId: "a" }), event({ role: "Observability", type: "task", taskId: "b" }), event({ role: "Observability", type: "task", taskId: "a", status: "completed" })];
    expect(roleStatuses(events, false).Observability).toBe("running");
    expect(roleStatuses(events, true).Observability).toBe("failed");
    expect(roleStatuses([event({ role: "Dependency", type: "task", taskId: "c", status: "skipped" })], false).Dependency).toBe("skipped");
    expect(roleStatuses([], false).Observability).toBe("idle");
    expect(roleStatuses([event({ role: "Investigator", status: "completed" })], true)).toMatchObject({ Investigator: "completed", Observability: "skipped", Critic: "skipped" });
  });
});

describe("investigation POST", () => {
  it("rejects invalid or extra input and cross-origin execution before starting an engine", async () => {
    vi.mocked(investigate).mockClear();
    for (const input of [{ incidentId: "nope", mode: "multi-agent" }, { incidentId: "inc-001", mode: "fake" }, { incidentId: "inc-001", mode: "multi-agent", apiKey: "untrusted" }]) expect((await POST(request(input))).status).toBe(400);
    const crossOrigin = request(); crossOrigin.headers.set("origin", "https://example.com");
    expect((await POST(crossOrigin)).status).toBe(403);
    const localProxy = new Request("http://localhost:3000/api/investigate", { method: "POST", body: "{}", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } });
    expect((await POST(localProxy)).status).toBe(400);
    expect(investigate).not.toHaveBeenCalled();
  });
  it("isolates concurrent streams and projects only reports and retrieved evidence", async () => {
    configure();
    vi.mocked(investigate).mockImplementation(async (_id, options) => { options?.onEvent?.(event()); return result(); });
    vi.mocked(investigateBaseline).mockImplementation(async (_id, options) => { options?.onEvent?.(event({ role: "Investigator" })); return result(); });
    const responses = await Promise.all([POST(request()), POST(request({ incidentId: "inc-001", mode: "single-agent" }))]);
    const output = await Promise.all(responses.map((response) => response.text()));
    expect(output[0]).toContain('"role":"Orchestrator"');
    expect(output[0]).not.toContain('"role":"Investigator"');
    expect(output[1]).toContain('"role":"Investigator"');
    expect(output[1]).not.toContain('"role":"Orchestrator"');
    expect(output.join()).not.toMatch(/PRIVATE_|unit-test-only|apiKey|failureSchedule|tracePath/);
    const multiOptions = vi.mocked(investigate).mock.lastCall![1]!;
    const baselineOptions = vi.mocked(investigateBaseline).mock.lastCall![1]!;
    expect(multiOptions.signal).not.toBe(baselineOptions.signal);
    expect(multiOptions.pacer).toBe(baselineOptions.pacer);
    expect(multiOptions.config!.limits.modelIntervalMs).toBeGreaterThanOrEqual(4500);
  });
  it("aborts the engine when the response reader is cancelled", async () => {
    configure();
    let finish!: (value: Awaited<ReturnType<typeof investigate>>) => void;
    vi.mocked(investigate).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const response = await POST(request());
    const signal = vi.mocked(investigate).mock.lastCall![1]!.signal!;
    expect(signal.aborted).toBe(false);
    await response.body!.cancel();
    expect(signal.aborted).toBe(true);
    finish(result());
  });
  it("returns actionable configuration errors and sanitizes unexpected engine errors", async () => {
    vi.spyOn(model, "getModelConfig").mockImplementation(() => { throw new model.ConfigurationError("Set valid GEMINI_API_KEY in .env.local."); });
    expect(await (await POST(request())).json()).toEqual({ message: "Set valid GEMINI_API_KEY in .env.local." });
    vi.restoreAllMocks(); configure();
    vi.mocked(investigate).mockRejectedValue(new Error("PRIVATE_PROVIDER_PAYLOAD"));
    const text = await (await POST(request())).text();
    expect(text).toContain('"type":"error"');
    expect(text).not.toContain("PRIVATE_PROVIDER_PAYLOAD");
  });
});

describe("saved evaluation projection", () => {
  it("shows missing, invalid, partial and stale artifacts without exposing held-out answers", async () => {
    const root = await mkdtemp(join(tmpdir(), "incidentlens-dashboard-"));
    try {
      expect((await readEvaluation(root)).status).toBe("missing");
      await mkdir(join(root, "results"));
      const path = join(root, "results/evaluation.json");
      await writeFile(path, "{}");
      expect((await readEvaluation(root)).status).toBe("unavailable");
      const saved = JSON.parse(await readFile("results/evaluation.json", "utf8"));
      saved.manifest.identity = {};
      await writeFile(path, JSON.stringify(saved));
      const view = await readEvaluation(root);
      expect(view.status).toBe("partial");
      expect(view.rows.map((row) => row.rootCause)).toEqual(Object.values(saved.aggregate).map((row: unknown) => (row as { rootCause: unknown }).rootCause));
      expect(JSON.stringify(view)).not.toMatch(/acceptableCauses|expectedInconclusive|failureProfiles|perCase|judge_failed/);
      saved.manifest.identity = { "lib/model.ts": "old-hash" };
      await writeFile(path, JSON.stringify(saved));
      expect((await readEvaluation(root)).status).toBe("stale");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
