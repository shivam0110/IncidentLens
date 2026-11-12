import { z } from "zod";
import incidentData from "../data/incidents.json";
import evidenceData from "../data/evidence.json";
import { evidenceSchema, incidentSchema, toolEnvelopeSchema, toolFailureRuleSchema } from "./schemas";
import type { Evidence, ToolEnvelope, ToolName } from "./schemas";

const text = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: true });
const limit = z.number().int().min(1).max(100).default(50);
const range = { service: text.optional(), start: timestamp, end: timestamp, limit };
const ordered = (value: { start: string; end: string }) => Date.parse(value.start) <= Date.parse(value.end);
export const toolSchemas = {
  query_logs: z.strictObject({ ...range, severity: z.enum(["debug", "info", "warn", "error"]).optional(), search: text.optional(), region: text.optional() }).refine(ordered, "Invalid time range"),
  query_metrics: z.strictObject({ ...range, metric: text.optional(), region: text.optional() }).refine(ordered, "Invalid time range"),
  query_changes: z.strictObject({ ...range, kind: z.enum(["deployment", "configuration"]).optional() }).refine(ordered, "Invalid time range"),
  query_dependencies: z.strictObject({ service: text, at: timestamp, direction: z.enum(["upstream", "downstream", "both"]).default("downstream"), limit }),
  search_incidents: z.strictObject({ service: text.optional(), terms: z.array(text).min(1).max(10), before: timestamp, limit }),
};
export const toolDescriptions: Record<ToolName, string> = {
  query_logs: "Retrieve raw logs in an inclusive time range. Service, exact severity, region and case-insensitive substring filters are optional.",
  query_metrics: "Retrieve raw metric samples in an inclusive time range. Optional service, exact metric name and region filters. Global and regional samples remain separate.",
  query_changes: "Retrieve deployment and configuration changes in an inclusive time range, optionally by service and change kind.",
  query_dependencies: "Retrieve dependency edges active at a timestamp. Downstream means services called by the named service; upstream means its callers.",
  search_incidents: "Search historical incident text before a timestamp. All terms must occur, case-insensitively; optional service matches the primary service or affected components. Similarity does not establish the present cause.",
};

const incidents = z.array(incidentSchema).parse(incidentData);
const records = z.array(z.strictObject({ incidentId: text, evidence: evidenceSchema })).parse(evidenceData);
export function listIncidents() { return incidents.map(({ id, title }) => ({ id, title })); }
export function getIncident(id: string) {
  const incident = incidents.find((item) => item.id === id);
  if (!incident) throw new Error("Unknown incident");
  return structuredClone(incident);
}
const sources: Record<ToolName, Evidence["source"]> = {
  query_logs: "logs", query_metrics: "metrics", query_changes: "changes",
  query_dependencies: "dependencies", search_incidents: "history",
};
type FailureRule = z.input<typeof toolFailureRuleSchema>;
export type ToolArguments<N extends ToolName> = z.input<typeof toolSchemas[N]>;
export type ToolAttempt = { tool: ToolName; args: unknown; attempt: number; result: ToolEnvelope };

export function createToolContext(incidentId: string, failures: FailureRule[] = []) {
  getIncident(incidentId);
  const rules = z.array(toolFailureRuleSchema).parse(failures);
  const data = records.filter((record) => record.incidentId === incidentId).map((record) => record.evidence);
  const counts = new Map<ToolName, number>();
  const collected = new Map<string, Evidence>();
  const attempts: ToolAttempt[] = [];

  // One invocation is one attempt. The shared runner, not this wrapper, owns retries/budgets.
  async function invoke<N extends ToolName>(tool: N, input: unknown, signal?: AbortSignal): Promise<ToolEnvelope> {
    const attempt = (counts.get(tool) ?? 0) + 1;
    counts.set(tool, attempt);
    function finish(result: ToolEnvelope) {
      const validated = toolEnvelopeSchema.parse(result);
      attempts.push({ tool, args: structuredClone(input), attempt, result: structuredClone(validated) });
      for (const record of validated.evidence) collected.set(record.id, structuredClone(record));
      return validated;
    }
    function error(code: NonNullable<ToolEnvelope["error"]>["code"], message: string, retryable: boolean) {
      return finish({ tool, status: "error", evidence: [], completeness: "unavailable", matched: null, warnings: [], error: { code, message, retryable } });
    }
    const parsed = toolSchemas[tool].safeParse(input);
    if (!parsed.success) return error("invalid_arguments", `Invalid arguments: ${parsed.error.issues.map((issue) => issue.path.join(".") || "query").join(", ")}`, false);
    if (signal?.aborted) return error("cancelled", "Tool request cancelled.", false);
    const rule = rules.find((item) => item.tool === tool && item.mode === "persistent_error") ??
      rules.find((item) => item.tool === tool && item.mode === "first_timeout" && attempt === 1);
    if (rule) return rule.mode === "first_timeout"
      ? error("timeout", "Source request timed out.", true)
      : error("unavailable", "Source is unavailable.", false);

    const query = parsed.data;
    const selected = data.filter((record) => {
      if (record.source !== sources[tool]) return false;
      if ("at" in query) {
        if (record.source !== "dependencies" || Date.parse(record.timestamp) > Date.parse(query.at) ||
            (record.raw.validUntil !== null && Date.parse(query.at) >= Date.parse(record.raw.validUntil))) return false;
        return (query.direction !== "upstream" && record.service === query.service) ||
          (query.direction !== "downstream" && record.raw.dependency === query.service);
      }
      if ("terms" in query) {
        return record.source === "history" && Date.parse(record.timestamp) < Date.parse(query.before) &&
          (!query.service || record.service === query.service || record.raw.components.includes(query.service)) &&
          query.terms.every((term) => [record.raw.title, record.raw.symptoms, record.raw.resolution, ...record.raw.components].join(" ").toLowerCase().includes(term.toLowerCase()));
      }
      if ((query.service && record.service !== query.service) || Date.parse(record.timestamp) < Date.parse(query.start) || Date.parse(record.timestamp) > Date.parse(query.end)) return false;
      const region = "region" in query ? query.region : undefined;
      if (record.source === "logs") {
        const severity = "severity" in query ? query.severity : undefined;
        const search = "search" in query ? query.search : undefined;
        return (!severity || record.raw.severity === severity) && (!region || record.raw.region === region) &&
          (!search || record.raw.message.toLowerCase().includes(search.toLowerCase()));
      }
      if (record.source === "metrics") {
        const metric = "metric" in query ? query.metric : undefined;
        return (!metric || record.raw.metric === metric) && (!region || record.raw.region === region);
      }
      const kind = "kind" in query ? query.kind : undefined;
      return record.source === "changes" && (!kind || record.raw.kind === kind);
    }).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
    const truncations = rules.filter((item) => item.tool === tool && item.mode === "truncate");
    const cap = Math.min(query.limit, ...truncations.map((item) => item.maxRecords!));
    const evidence = structuredClone(selected.slice(0, cap));
    const partial = evidence.length < selected.length;
    return finish({
      tool, status: partial ? "partial" : "ok", evidence, completeness: partial ? "truncated" : "complete",
      matched: selected.length, warnings: partial ? ["Results truncated; narrow the query to retrieve omitted records."] : [], error: null,
    });
  }
  return {
    invoke,
    queryLogs: (args: ToolArguments<"query_logs">, signal?: AbortSignal) => invoke("query_logs", args, signal),
    queryMetrics: (args: ToolArguments<"query_metrics">, signal?: AbortSignal) => invoke("query_metrics", args, signal),
    queryChanges: (args: ToolArguments<"query_changes">, signal?: AbortSignal) => invoke("query_changes", args, signal),
    queryDependencies: (args: ToolArguments<"query_dependencies">, signal?: AbortSignal) => invoke("query_dependencies", args, signal),
    searchIncidents: (args: ToolArguments<"search_incidents">, signal?: AbortSignal) => invoke("search_incidents", args, signal),
    snapshot: () => ({ attempts: structuredClone(attempts), evidence: structuredClone([...collected.values()]) }),
  };
}
