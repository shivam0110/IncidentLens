import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import incidents from "@/data/incidents.json";
import { incidentSchema, usageSchema } from "@/lib/schemas";

export const dashboardIncidents = z.array(incidentSchema).parse(incidents);
const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1);
const ratio = z.object({ correct: count, denominator: count });
const measurement = z.object({ modelAttemptsKnown: count, latencyMsKnown: z.number().nonnegative(), usage: usageSchema });
const aggregate = z.object({
  planned: count, reports: count, statuses: z.object({ completed: count, failed: count, pending: count, running: count, interrupted: count, quota_blocked: count }),
  rootCause: ratio, correctInconclusive: ratio, grounding: z.object({ macroRate: rate, judgeFailed: count }),
  citations: z.object({ macroRate: rate }),
  investigator: measurement.extend({ toolAttemptsKnown: count, observedRuns: count, missingRuns: count }), judge: measurement,
});
const checkpoint = z.object({
  version: z.literal(1), updatedAt: z.iso.datetime(),
  manifest: z.object({ model: z.string(), identity: z.record(z.string(), z.string()), cases: z.array(z.string()), modes: z.array(z.string()) }),
  rows: z.array(z.object({ status: z.string(), report: z.unknown().nullable(), judge: z.object({ status: z.string() }) })),
  aggregate: z.object({ "multi-agent": aggregate, "single-agent": aggregate }).nullable(),
});
export type EvaluationView = {
  status: "missing" | "unavailable" | "partial" | "complete" | "stale";
  message: string; updatedAt?: string; model?: string;
  rows: ({ mode: "multi-agent" | "single-agent" } & z.infer<typeof aggregate>)[];
};

export async function readEvaluation(root = process.cwd()): Promise<EvaluationView> {
  let text: string;
  try { text = await readFile(join(root, "results/evaluation.json"), "utf8"); }
  catch (error) { return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable", message: "Saved evaluation results are unavailable. Run task 06 to generate them.", rows: [] }; }
  try {
    const data = checkpoint.parse(JSON.parse(text));
    const changed = (await Promise.all(Object.entries(data.manifest.identity).map(async ([path, hash]) => {
      // UI-only dependencies do not invalidate engine measurements; their manifest difference is disclosed.
      if (!/^(lib|data|evaluation)\/[\w.-]+\.(ts|json)$/.test(path)) return null;
      try { return createHash("sha256").update(await readFile(join(root, path))).digest("hex") === hash ? null : path; }
      catch { return path; }
    }))).filter(Boolean);
    const expected = data.manifest.cases.length * data.manifest.modes.length;
    const saved = data.rows.filter((row) => row.report !== null).length;
    const failures = data.rows.filter((row) => row.status !== "completed").length;
    const judges = data.rows.filter((row) => row.judge.status !== "completed").length;
    const partial = saved !== expected || failures > 0 || judges > 0 || !data.aggregate;
    return {
      status: changed.length ? "stale" : partial ? "partial" : "complete", updatedAt: data.updatedAt, model: data.manifest.model,
      message: `${saved}/${expected} reports saved · ${failures} incomplete/failed executions · ${judges} incomplete judgments. ` +
        (changed.length ? `Engine or dataset changed: ${changed.join(", ")}. These are historical results.` : "Recorded engine and dataset hashes match. UI dependency changes are excluded from this check."),
      rows: data.aggregate ? (["multi-agent", "single-agent"] as const).map((mode) => ({ mode, ...data.aggregate![mode] })) : [],
    };
  } catch { return { status: "unavailable", message: "Saved evaluation is invalid or incompatible. Regenerate the evaluation artifact.", rows: [] }; }
}
