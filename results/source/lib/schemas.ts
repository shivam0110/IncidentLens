import { z } from "zod";

const text = z.string().trim().min(1);
const texts = z.array(text);
const timestamp = z.iso.datetime({ offset: true });
const counter = z.number().int().nonnegative();
export const roleSchema = z.enum(["Orchestrator", "Observability", "Dependency", "Reasoning", "Critic", "Reporting", "Investigator"]);
export const specialistSchema = z.enum(["Observability", "Dependency"]);
export const toolNameSchema = z.enum(["query_logs", "query_metrics", "query_changes", "query_dependencies", "search_incidents"]);
export const taskStatusSchema = z.enum(["pending", "running", "completed", "failed", "skipped"]);
export const causeClassSchema = z.enum(["software_regression", "configuration", "resource_exhaustion", "dependency_degradation", "traffic_saturation", "network", "data_integrity", "unknown"]);
const confidence = z.enum(["low", "medium", "high"]);

export const incidentSchema = z.strictObject({
  id: text, title: text, description: text, service: text,
  start: timestamp, end: timestamp, reportedAt: timestamp,
}).refine((value) => Date.parse(value.start) <= Date.parse(value.end), "Invalid incident time range");

const evidenceBase = { id: text, timestamp, service: text };
export const evidenceSchema = z.union([
  z.strictObject({ ...evidenceBase, source: z.literal("logs"), raw: z.strictObject({
    severity: z.enum(["debug", "info", "warn", "error"]), message: text, region: text, traceId: text.nullable(),
  }) }),
  z.strictObject({ ...evidenceBase, source: z.literal("metrics"), raw: z.strictObject({
    metric: text, value: z.number(), unit: text, region: text, windowSeconds: counter.positive(),
  }) }),
  z.strictObject({ ...evidenceBase, source: z.literal("changes"), raw: z.strictObject({
    kind: z.enum(["deployment", "configuration"]), revision: text, key: text.nullable(),
    before: text.nullable(), after: text, actor: text,
  }) }),
  z.strictObject({ ...evidenceBase, source: z.literal("dependencies"), raw: z.strictObject({
    dependency: text, relationship: z.enum(["synchronous", "asynchronous", "datastore"]),
    critical: z.boolean(), validUntil: timestamp.nullable(),
  }) }),
  z.strictObject({ ...evidenceBase, source: z.literal("history"), raw: z.strictObject({
    reference: text, title: text, symptoms: text, resolution: text, components: texts,
  }) }),
]);
export type Incident = z.infer<typeof incidentSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Role = z.infer<typeof roleSchema>;
export type ToolName = z.infer<typeof toolNameSchema>;

export const toolErrorSchema = z.strictObject({
  code: z.enum(["invalid_arguments", "timeout", "unavailable", "cancelled"]), message: text, retryable: z.boolean(),
});
export const toolEnvelopeSchema = z.strictObject({
  tool: toolNameSchema, status: z.enum(["ok", "partial", "error"]), evidence: z.array(evidenceSchema),
  completeness: z.enum(["complete", "truncated", "unavailable"]), matched: counter.nullable(),
  warnings: texts, error: toolErrorSchema.nullable(),
}).refine((value) => value.status === "error"
  ? value.error !== null && value.completeness === "unavailable" && value.evidence.length === 0 && value.matched === null
  : value.error === null && value.matched !== null && (value.status === "ok"
    ? value.completeness === "complete" && value.matched === value.evidence.length
    : value.completeness === "truncated" && value.matched > value.evidence.length), "Inconsistent tool envelope");
export type ToolEnvelope = z.infer<typeof toolEnvelopeSchema>;

const tokenCount = counter.nullable();
export const usageSchema = z.strictObject({
  input: tokenCount, output: tokenCount, total: tokenCount, visibleOutput: tokenCount,
  thinking: tokenCount, cacheRead: tokenCount, toolUsePrompt: tokenCount,
  availability: z.enum(["complete", "partial", "unavailable"]),
});
export type Usage = z.infer<typeof usageSchema>;
export const runStatsSchema = z.strictObject({
  toolAttempts: counter, modelAttempts: counter, elapsedMs: z.number().nonnegative(), usage: usageSchema,
});
export const claimSchema = z.strictObject({ statement: text, evidenceIds: texts });
export const findingSchema = z.strictObject({
  ...claimSchema.shape, contradictions: texts,
});
export const taskSchema = z.strictObject({
  id: text, role: specialistSchema, question: text, dependsOn: texts, status: taskStatusSchema,
});
export const planSchema = z.strictObject({ questions: texts, tasks: z.array(taskSchema), rationale: text });
export const hypothesisSchema = z.strictObject({
  id: text, causeClass: causeClassSchema, component: text, explanation: text,
  support: texts, contradictions: texts, confidence, rationale: text, assumptions: texts, unknowns: texts,
});
export const criticRequestSchema = z.strictObject({
  id: text, role: specialistSchema, question: text, rationale: text, hypothesisIds: texts,
});
export const specialistResultSchema = z.strictObject({ findings: z.array(findingSchema), gaps: texts });
export const reasoningResultSchema = z.strictObject({ hypotheses: z.array(hypothesisSchema), assumptions: texts, unknowns: texts });
export const criticResultSchema = z.strictObject({
  recommendation: z.enum(["follow_up", "stop"]), rationale: text, requests: z.array(criticRequestSchema),
});
export const failureSchema = z.strictObject({
  scope: z.enum(["tool", "agent", "run"]), name: text, message: text, retryable: z.boolean(),
});
export const reportSchema = z.strictObject({
  incidentId: text, outcome: z.enum(["concluded", "inconclusive"]), summary: text,
  hypotheses: z.array(hypothesisSchema), observedFacts: z.array(claimSchema), assumptions: texts, unknowns: texts,
  actions: z.array(z.strictObject({ action: text, evidenceIds: texts, rationale: text })),
  limitations: texts, failures: z.array(failureSchema), stopReason: text, stats: runStatsSchema,
});
export const roleResultSchemas = {
  Orchestrator: planSchema, Observability: specialistResultSchema, Dependency: specialistResultSchema,
  Reasoning: reasoningResultSchema, Critic: criticResultSchema, Reporting: reportSchema, Investigator: reportSchema,
};
export const progressEventSchema = z.strictObject({
  sequence: counter, elapsedMs: z.number().nonnegative(),
  type: z.enum(["round", "task", "role", "tool", "evidence", "error", "complete"]),
  role: roleSchema.nullable(), taskId: text.nullable(), tool: toolNameSchema.nullable(),
  status: taskStatusSchema.nullable(), round: counter.nullable(), message: text, evidenceIds: texts,
});
export type Task = z.infer<typeof taskSchema>;
export type Hypothesis = z.infer<typeof hypothesisSchema>;
export type Report = z.infer<typeof reportSchema>;
export type ProgressEvent = z.infer<typeof progressEventSchema>;

// Evaluation configuration is never imported by the operational tools or model layer.
export const labelSchema = z.strictObject({
  incidentId: text, acceptableCauses: z.array(z.strictObject({ causeClass: causeClassSchema, component: text })),
  relevantEvidenceIds: texts, expectedInconclusive: z.boolean(),
});
export const toolFailureRuleSchema = z.strictObject({
  tool: toolNameSchema, mode: z.enum(["first_timeout", "persistent_error", "truncate"]),
  maxRecords: counter.optional(),
}).refine((rule) => rule.mode === "truncate" ? rule.maxRecords !== undefined : rule.maxRecords === undefined,
  "Only truncation requires maxRecords");
export const scenarioSchema = z.strictObject({
  incidentId: text, toolFailures: z.array(toolFailureRuleSchema),
  agentFailures: z.array(z.strictObject({ role: roleSchema, attempt: counter.positive() })),
});
