import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createModel, getModelConfig, structuredModel, tokenUsage } from "../lib/model";
import { createToolContext, getIncident, toolDescriptions, toolSchemas } from "../lib/tools";
import {
  evidenceSchema, incidentSchema, labelSchema, reportSchema, roleResultSchemas, scenarioSchema,
  toolEnvelopeSchema, usageSchema,
} from "../lib/schemas";
import incidents from "../data/incidents.json";
import records from "../data/evidence.json";
import labels from "../evaluation/labels.json";
import profiles from "../evaluation/scenarios.json";

describe("synthetic dataset integrity and evaluation boundary", () => {
  it("validates every incident, typed raw record, label, and run profile", () => {
    expect(z.array(incidentSchema).parse(incidents)).toHaveLength(10);
    const parsed = z.array(z.strictObject({ incidentId: z.string(), evidence: evidenceSchema })).parse(records);
    expect(parsed).toHaveLength(116);
    expect(z.array(labelSchema).parse(labels)).toHaveLength(incidents.length);
    expect(z.array(scenarioSchema).parse(profiles)).toHaveLength(incidents.length);
    for (const items of [incidents.map(({ id }) => id), records.map(({ evidence }) => evidence.id),
      labels.map(({ incidentId }) => incidentId), profiles.map(({ incidentId }) => incidentId)]) {
      expect(new Set(items).size).toBe(items.length);
    }
    const incidentIds = incidents.map(({ id }) => id);
    for (const row of [...records, ...labels, ...profiles]) expect(incidentIds).toContain(row.incidentId);
    for (const label of labels) {
      const validIds = records.filter((record) => record.incidentId === label.incidentId).map(({ evidence }) => evidence.id);
      expect(label.relevantEvidenceIds.length).toBeGreaterThan(0);
      for (const id of label.relevantEvidenceIds) expect(validIds).toContain(id);
      expect(label.acceptableCauses.length > 0).toBe(!label.expectedInconclusive);
    }
    for (const { evidence } of parsed) if (evidence.source === "dependencies" && evidence.raw.validUntil !== null) {
      expect(Date.parse(evidence.raw.validUntil)).toBeGreaterThan(Date.parse(evidence.timestamp));
    }
  });

  it("makes all records reachable through only the five tools, without labels or profiles", async () => {
    for (const incident of incidents) {
      const context = createToolContext(incident.id);
      const range = { start: "2020-01-01T00:00:00Z", end: "2030-01-01T00:00:00Z" };
      const results = await Promise.all([
        context.queryLogs(range), context.queryMetrics(range), context.queryChanges(range),
        context.queryDependencies({ service: incident.service, at: incident.reportedAt, direction: "both" }),
        context.searchIncidents({ terms: [incident.service], before: incident.start }),
      ]);
      const ownRecords = records.filter((row) => row.incidentId === incident.id);
      for (const { evidence } of ownRecords) {
        if (evidence.source === "dependencies") await context.queryDependencies({ service: evidence.service, at: incident.reportedAt });
      }
      for (const result of results) toolEnvelopeSchema.parse(result);
      const retrieved = context.snapshot().evidence;
      expect(retrieved.map(({ id }) => id).sort()).toEqual(ownRecords.map(({ evidence }) => evidence.id).sort());
      expect(retrieved.every((record) => ownRecords.some(({ evidence }) => evidence.id === record.id))).toBe(true);
      const agentInput = { incident: getIncident(incident.id), evidence: retrieved };
      for (const hidden of ["acceptableCauses", "relevantEvidenceIds", "expectedInconclusive", "toolFailures", "agentFailures"]) {
        expect(JSON.stringify(agentInput)).not.toContain(hidden);
      }
    }
  });

  it("keeps evaluation files outside the transitive runtime import graph", () => {
    const visited = new Set<string>();
    function visit(path: string) {
      if (visited.has(path)) return;
      visited.add(path);
      expect(path).not.toContain("/evaluation/");
      if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
        const target = resolve(dirname(path), match[1]);
        visit(/\.(json|tsx?)$/.test(target) ? target : `${target}.ts`);
      }
    }
    for (const directory of ["lib", "app"]) for (const file of readdirSync(directory, { recursive: true })) {
      if (/\.tsx?$/.test(String(file))) visit(resolve(directory, String(file)));
    }
    expect(visited.has(resolve("data/incidents.json"))).toBe(true);
    expect(visited.has(resolve("data/evidence.json"))).toBe(true);
  });

  it("retains inconclusive evidence and a generic, isolated failure profile", () => {
    expect(labels.find((row) => row.incidentId === "inc-010")).toMatchObject({ expectedInconclusive: true, acceptableCauses: [] });
    expect(profiles.find((row) => row.incidentId === "inc-008")?.toolFailures).toEqual([{ tool: "query_logs", mode: "first_timeout" }]);
    expect(profiles.find((row) => row.incidentId === "inc-009")).toMatchObject({
      agentFailures: [{ role: "Reasoning", attempt: 1 }],
      toolFailures: [{ tool: "query_metrics", mode: "persistent_error" }, { tool: "query_logs", mode: "truncate", maxRecords: 2 }],
    });
  });
});

describe("shared output contracts", () => {
  it("requires citations in the native schema for facts, findings and actions", () => {
    const schema = z.toJSONSchema(reportSchema) as { properties: Record<string, any> };
    expect(schema.properties.observedFacts.items.properties.evidenceIds.minItems).toBe(1);
    expect(schema.properties.actions.items.properties.evidenceIds.minItems).toBe(1);
    const finding = roleResultSchemas.Observability.shape.findings.element;
    expect(finding.safeParse({ statement: "No matching source was retrieved.", evidenceIds: [], contradictions: [] }).success).toBe(false);
  });

  it("retains missing and unreconciled token totals and thinking/cache details", () => {
    for (const raw of [{}, { promptTokenCount: 10 }, {
      promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2,
      cachedContentTokenCount: 4, totalTokenCount: 99,
    }]) {
      const message = new AIMessage({ content: "test", response_metadata: { geminiUsage: raw } });
      const usage = usageSchema.parse(tokenUsage(message));
      expect(usage.availability).not.toBe("complete");
      expect(usage.total).toBe("totalTokenCount" in raw ? 99 : null);
      if ("totalTokenCount" in raw) expect(usage).toMatchObject({ output: 5, visibleOutput: 3, thinking: 2, cacheRead: 4 });
    }
  });

  it("requires complete report fields including contradictions, failures and unknown usage", () => {
    const report = {
      incidentId: "inc-010", outcome: "inconclusive", summary: "Two export requests failed.",
      hypotheses: [{ id: "h1", causeClass: "dependency_degradation", component: "object-storage", explanation: "A slow storage request is possible.",
        support: ["ev-010-001"], contradictions: [], confidence: "low", rationale: "No child spans were retained.", assumptions: [], unknowns: ["Storage request duration"] }],
      observedFacts: [{ statement: "An export hit its deadline.", evidenceIds: ["ev-010-001"] }], assumptions: [], unknowns: ["Failed request timings"],
      actions: [{ action: "Restore tracing and collect a failed request.", evidenceIds: ["ev-010-002"], rationale: "Required timing spans are missing." }],
      limitations: ["Sparse telemetry"], failures: [], stopReason: "No useful evidence remains.",
      stats: { toolAttempts: 2, modelAttempts: 0, elapsedMs: 1, usage: tokenUsage(new AIMessage("test")) },
    };
    expect(reportSchema.parse(report).stats.usage.total).toBeNull();
    const { failures: omitted, ...missing } = report;
    expect(omitted).toEqual([]);
    expect(reportSchema.safeParse(missing).success).toBe(false);
    expect(reportSchema.safeParse({ ...report, hypotheses: [{ ...report.hypotheses[0], causeClass: "inc-010-answer" }] }).success).toBe(false);
  });

  it("rejects an envelope that pretends an unavailable source is an empty search", () => {
    expect(toolEnvelopeSchema.safeParse({ tool: "query_logs", status: "ok", evidence: [], matched: 0,
      completeness: "unavailable", warnings: [], error: null }).success).toBe(false);
  });

  it("exports explicit JSON schemas without arbitrary objects for every role and tool", () => {
    for (const schema of [...Object.values(roleResultSchemas), ...Object.values(toolSchemas), evidenceSchema]) {
      const json = z.toJSONSchema(schema);
      function check(value: unknown) {
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) { value.forEach(check); return; }
        const object = value as Record<string, unknown>;
        if (object.type === "object") expect(object.properties).toBeDefined();
        for (const key of ["oneOf", "allOf", "patternProperties", "discriminator"]) expect(object).not.toHaveProperty(key);
        Object.values(object).forEach(check);
      }
      check(json);
    }
  });

  it("passes all five tool declarations and the report schema through the native Gemini boundary offline", async () => {
    const payloads: Record<string, unknown>[] = [];
    const response = () => new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "READY" }] } }] }), { headers: { "Content-Type": "application/json" } });
    vi.stubGlobal("fetch", async (request: Request) => { payloads.push(await request.json()); return response(); });
    try {
      const model = createModel(getModelConfig({ GEMINI_API_KEY: "test-secret", GEMINI_MODEL: "gemini-3.5-flash-lite" }));
      const tools = Object.entries(toolSchemas).map(([name, schema]) => ({ name, schema, description: toolDescriptions[name as keyof typeof toolSchemas] }));
      await model.bindTools(tools).invoke([new HumanMessage("Inspect available telemetry.")]);
      const declarations = (payloads[0].tools as { functionDeclarations: unknown[] }[])[0].functionDeclarations;
      expect(declarations).toHaveLength(5);
      // includeRaw preserves invalid output as parsed:null; the future runner must check it.
      expect((await structuredModel(model, reportSchema).invoke("Return a report.")).parsed).toBeNull();
      expect(payloads[1].generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { type: "object" } });
    } finally { vi.unstubAllGlobals(); }
  });
});
