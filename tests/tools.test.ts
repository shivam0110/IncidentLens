import { describe, expect, it } from "vitest";
import { createToolContext, getIncident, listIncidents } from "../lib/tools";
import type { ToolName } from "../lib/schemas";
import scenarios from "../evaluation/scenarios.json";

const range = { start: "2026-10-01T09:50:00Z", end: "2026-10-01T10:15:00Z" };
const windowFor = (id: string) => { const { start, end } = getIncident(id); return { start, end }; };

describe("validated operational queries", () => {
  it.each<[ToolName, unknown]>([
    ["query_logs", { ...range, severity: "fatal" }], ["query_logs", { ...range, service: " " }],
    ["query_logs", { ...range, start: range.end, end: range.start }],
    ["query_metrics", { ...range, start: "yesterday" }], ["query_metrics", { ...range, limit: 101 }],
    ["query_changes", { ...range, kind: "incident" }], ["query_changes", { ...range, answer: "x" }],
    ["query_dependencies", { service: "checkout-api", at: range.start, direction: "sideways" }],
    ["search_incidents", { terms: [], before: range.start }], ["search_incidents", { terms: [" "], before: range.start }],
    ["query_logs", null], ["query_logs", { ...range, limit: 0 }],
  ])("rejects invalid %s arguments", async (tool, input) => {
    const context = createToolContext("inc-001");
    const result = await context.invoke(tool, input);
    expect(result).toMatchObject({ status: "error", completeness: "unavailable", matched: null,
      evidence: [], error: { code: "invalid_arguments", retryable: false } });
    expect(context.snapshot().attempts).toHaveLength(1);
    expect(context.snapshot().evidence).toEqual([]);
  });

  it("filters logs by service, inclusive time, exact severity, region and substring", async () => {
    const context = createToolContext("inc-001");
    const result = await context.queryLogs({ service: "checkout-api", start: "2026-10-01T10:01:00Z",
      end: "2026-10-01T10:01:00Z", severity: "error", region: "eu-west", search: "COUPON" });
    expect(result.evidence.map((record) => record.id)).toEqual(["ev-001-003"]);
    expect(result).toMatchObject({ status: "ok", matched: 1, completeness: "complete", error: null });
    expect((await context.queryLogs({ ...range, severity: "warn" })).evidence.map((record) => record.id)).toEqual(["ev-001-004"]);
    expect((await context.queryLogs({ ...range, service: "unknown" })).evidence).toEqual([]);
  });

  it("keeps aggregate and regional metric samples separate", async () => {
    const context = createToolContext("inc-006");
    const range = windowFor("inc-006");
    const results = await Promise.all(["global", "eu-west", "us-east"].map((region) =>
      context.queryMetrics({ ...range, service: "profile-api", metric: "error_rate", region })));
    expect(results.map((result) => result.evidence.map((record) => record.source === "metrics" && record.raw.value))).toEqual([[0.8], [72], [0.1]]);
    expect((await context.queryMetrics({ ...range, service: "profile-store", metric: "latency_p95", start: "2026-10-06T10:03:00Z" })).evidence).toHaveLength(1);
    expect((await context.queryMetrics({ ...range, metric: "absent" })).status).toBe("ok");
  });

  it("filters changes by kind, service and time", async () => {
    const context = createToolContext("inc-003");
    const range = windowFor("inc-003");
    const result = await context.queryChanges({ ...range, service: "session-api", kind: "configuration", end: "2026-10-03T10:00:00Z" });
    expect(result.evidence.map((record) => record.id)).toEqual(["ev-003-002"]);
    expect((await context.queryChanges({ ...range, kind: "deployment" })).evidence.map((record) => record.service)).toEqual(["identity-api"]);
  });

  it("queries active dependency edges in either direction", async () => {
    const context = createToolContext("inc-002");
    const at = getIncident("inc-002").start;
    const incoming = await context.queryDependencies({ service: "payments-db", at, direction: "upstream" });
    expect(incoming.evidence.map((record) => record.service).sort()).toEqual(["batch-worker", "payments-api"]);
    const outgoing = await context.queryDependencies({ service: "payments-api", at });
    expect(outgoing.evidence.map((record) => record.source === "dependencies" && record.raw.dependency).sort()).toEqual(["payment-processor", "payments-db"]);
    expect((await context.queryDependencies({ service: "payments-db", at, direction: "both" })).evidence).toEqual(incoming.evidence);
    expect((await context.queryDependencies({ service: "payments-api", at: "2026-10-01T00:00:00Z" })).evidence).toEqual([]);
  });

  it("searches all historical text with AND semantics, component and strict before filters", async () => {
    const context = createToolContext("inc-007");
    const before = getIncident("inc-007").start;
    const result = await context.searchIncidents({ terms: ["INVOICE", "heap"], service: "invoice-renderer", before });
    expect(result.evidence.map((record) => record.id)).toEqual(["ev-007-010"]);
    expect((await context.searchIncidents({ terms: ["invoice", "unknown-term"], before })).evidence).toEqual([]);
    expect((await context.searchIncidents({ terms: ["invoice"], before: "2026-09-15T12:00:00Z" })).evidence).toEqual([]);
    expect((await context.searchIncidents({ terms: ["invoice"], service: "unrelated", before })).evidence).toEqual([]);
  });
});

describe("per-run evidence and deterministic failures", () => {
  it("distinguishes complete empty, partial/truncated, and unavailable results", async () => {
    const normal = createToolContext("inc-001");
    expect(await normal.queryLogs({ ...range, search: "no matching log" })).toMatchObject({ status: "ok", completeness: "complete", evidence: [], matched: 0, error: null });
    const partial = await normal.queryLogs({ ...range, limit: 1 });
    expect(partial).toMatchObject({ status: "partial", completeness: "truncated", matched: 4, error: null });
    expect(partial.evidence).toHaveLength(1);
    expect(partial.warnings).not.toEqual([]);
    const failed = createToolContext("inc-001", [{ tool: "query_logs", mode: "persistent_error" }]);
    expect(await failed.queryLogs({ ...range, search: "no matching log" })).toMatchObject({ status: "error", completeness: "unavailable", matched: null, error: { retryable: false } });
  });

  it("resets the first-attempt timeout for each run and leaves retries to the caller", async () => {
    const profile = scenarios.find((scenario) => scenario.incidentId === "inc-008")!;
    const failures = [{ tool: "query_logs", mode: "first_timeout" }] as const;
    expect(profile.toolFailures).toEqual(failures);
    for (let run = 0; run < 2; run++) {
      const context = createToolContext(profile.incidentId, [...failures]);
      const args = windowFor(profile.incidentId);
      expect(await context.queryLogs(args)).toMatchObject({ status: "error", error: { code: "timeout", retryable: true } });
      expect(context.snapshot().attempts).toHaveLength(1);
      expect(context.snapshot().evidence).toEqual([]);
      expect((await context.queryLogs(args)).status).toBe("ok");
      expect(context.snapshot().attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    }
  });

  it("tracks concurrent attempts and collects only returned records by stable IDs", async () => {
    const context = createToolContext("inc-001");
    const [small, full, metrics] = await Promise.all([
      context.queryLogs({ ...range, limit: 1 }), context.queryLogs(range), context.queryMetrics(range),
    ]);
    expect(small.evidence[0]).toEqual(full.evidence[0]);
    expect(context.snapshot().evidence).toHaveLength(full.evidence.length + metrics.evidence.length);
    expect(context.snapshot().attempts.map(({ tool, attempt }) => [tool, attempt])).toEqual([["query_logs", 1], ["query_logs", 2], ["query_metrics", 1]]);
    small.evidence[0].service = "modified";
    const snapshot = context.snapshot();
    snapshot.attempts.length = 0;
    snapshot.evidence[0].service = "modified";
    expect(context.snapshot().attempts).toHaveLength(3);
    expect((await context.queryLogs(range)).evidence[0].service).toBe("checkout-api");
    expect(context.snapshot().evidence[0].service).toBe("checkout-api");
  });

  it("supports persistent and truncated sources independently with narrower follow-up", async () => {
    const context = createToolContext("inc-009", [
      { tool: "query_metrics", mode: "persistent_error" }, { tool: "query_logs", mode: "truncate", maxRecords: 2 },
    ]);
    const args = windowFor("inc-009");
    for (let i = 0; i < 2; i++) expect((await context.queryMetrics(args)).error?.retryable).toBe(false);
    expect((await context.queryLogs(args)).status).toBe("partial");
    const followup = await context.queryLogs({ ...args, start: "2026-10-09T10:08:00Z" });
    expect(followup).toMatchObject({ status: "ok", matched: 1 });
    expect(context.snapshot().evidence.map((record) => record.id)).toEqual(["ev-009-001", "ev-009-003", "ev-009-008"]);
    expect((await context.queryChanges(args)).status).toBe("ok");
  });

  it("can return partial data with zero records without misreporting an empty search", async () => {
    const context = createToolContext("inc-001", [{ tool: "query_logs", mode: "truncate", maxRecords: 0 }]);
    expect(await context.queryLogs(range)).toMatchObject({ status: "partial", evidence: [], matched: 4, completeness: "truncated" });
    expect(await context.queryLogs({ ...range, search: "no match" })).toMatchObject({ status: "ok", evidence: [], matched: 0 });
  });

  it("rejects malformed failure configuration and honors cancellation", async () => {
    expect(() => createToolContext("inc-001", [{ tool: "query_logs", mode: "truncate" }])).toThrow();
    expect(() => createToolContext("inc-001", [{ tool: "query_logs", mode: "first_timeout", maxRecords: 1 }])).toThrow();
    expect(() => createToolContext("missing")).toThrow("Unknown incident");
    const context = createToolContext("inc-001");
    expect(await context.queryLogs(range, AbortSignal.abort())).toMatchObject({ status: "error", error: { code: "cancelled", retryable: false } });
    expect(context.snapshot().attempts).toHaveLength(1);
  });

  it("returns only the selected incident, with isolated runs and immutable catalog access", async () => {
    const incident = getIncident("inc-001");
    incident.description = "modified";
    expect(getIncident(incident.id).description).not.toBe("modified");
    const catalog = listIncidents();
    catalog.length = 0;
    expect(listIncidents()).toHaveLength(10);
    const one = createToolContext("inc-001");
    const two = createToolContext("inc-002");
    await one.queryLogs({ start: "2020-01-01T00:00:00Z", end: "2030-01-01T00:00:00Z" });
    expect(one.snapshot().evidence.every((record) => record.id.startsWith("ev-001-"))).toBe(true);
    expect(two.snapshot()).toEqual({ attempts: [], evidence: [] });
  });
});
