import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { investigate } from "../lib/investigation";
import { investigateBaseline } from "../lib/baseline";
import { createPacer, safeError } from "../lib/budget";
import { getModelConfig, type ModelConfig } from "../lib/model";
import { evidenceSchema, labelSchema, reportSchema, runStatsSchema, scenarioSchema } from "../lib/schemas";
import { getIncident, listIncidents, toolSchemas } from "../lib/tools";
import type { InvestigationOptions } from "../lib/run";
import { accuracy, citationScore, groundingScore, judgeClaims, mergeUsage, selectClaims, verdictSchema } from "./scoring";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VERSION = 1;
const modes = ["multi-agent", "single-agent"] as const;
export type Mode = typeof modes[number];
type RunResult = Awaited<ReturnType<typeof investigate>>;
type Profile = z.infer<typeof scenarioSchema>;
type Runner = (incidentId: string, options: InvestigationOptions) => Promise<RunResult>;
const statusSchema = z.enum(["pending", "running", "completed", "failed", "interrupted", "quota_blocked"]);
const batchSchema = z.strictObject({ verdicts: z.array(verdictSchema), stats: runStatsSchema.nullable(), error: z.string().nullable() });
const rowSchema = z.strictObject({
  incidentId: z.string(), mode: z.enum(modes), status: statusSchema,
  artifact: z.string().nullable(), report: reportSchema.nullable(), error: z.string().nullable(),
  judge: z.strictObject({ status: statusSchema, batches: z.array(batchSchema), inFlight: z.array(z.string()) }),
});
type Row = z.infer<typeof rowSchema>;
const checkpointSchema = z.object({
  version: z.literal(VERSION), fingerprint: z.string(), manifest: z.unknown(), createdAt: z.string(), updatedAt: z.string(),
  rows: z.array(rowSchema), aggregate: z.unknown().nullable(),
  pauses: z.array(z.strictObject({ before: z.string(), requestedMs: z.number(), elapsedMs: z.number(), completed: z.boolean() })),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
export type EvaluationOptions = {
  config: ModelConfig; cases?: string[]; outputDirectory?: string; resume?: boolean; retryIncomplete?: boolean;
  tier: "free"; quotaPolicy: string; pauseMs?: number; signal?: AbortSignal;
  runners?: Record<Mode, Runner>; judgeTransport?: InvestigationOptions["transport"];
};
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const key = (row: Pick<Row, "incidentId" | "mode">) => `${row.incidentId}.${row.mode}`;
const filename = (row: Pick<Row, "incidentId" | "mode">) => join("runs", `${key(row)}.json`);
async function exists(path: string) {
  try { await readFile(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, path);
}

export async function validateInputs(cases = listIncidents().map((incident) => incident.id), validateLabels = false) {
  if (!cases.length || new Set(cases).size !== cases.length) throw new Error("Select nonempty, unique incident IDs.");
  cases.forEach(getIncident);
  const profiles = z.array(scenarioSchema).parse(await readJson(join(ROOT, "evaluation/scenarios.json")));
  if (new Set(profiles.map((profile) => profile.incidentId)).size !== profiles.length ||
      profiles.length !== listIncidents().length || listIncidents().some((incident) => !profiles.some((profile) => profile.incidentId === incident.id))) {
    throw new Error("Failure profiles must cover each incident exactly once.");
  }
  if (validateLabels) {
    const labels = await loadLabels();
    if (new Set(labels.map((label) => label.incidentId)).size !== labels.length ||
        labels.length !== listIncidents().length || listIncidents().some((incident) => !labels.some((label) => label.incidentId === incident.id))) {
      throw new Error("Labels must cover each incident exactly once.");
    }
  }
  return cases.map((incidentId) => profiles.find((profile) => profile.incidentId === incidentId)!);
}
async function loadLabels() { return z.array(labelSchema).parse(await readJson(join(ROOT, "evaluation/labels.json"))); }

export async function createManifest(options: EvaluationOptions, profiles: Profile[]) {
  const files = ["package.json", "package-lock.json"];
  for (const directory of ["lib", "data", "evaluation"]) {
    const names = await readdir(join(ROOT, directory));
    files.push(...names.filter((name) => /\.(ts|json)$/.test(name)).map((name) => `${directory}/${name}`));
  }
  const identity = Object.fromEntries(await Promise.all(files.sort().map(async (file) => [file, hash(await readFile(join(ROOT, file)))])));
  const allProfiles = (await validateInputs()).map((profile) => profiles.find((selected) => selected.incidentId === profile.incidentId) ?? profile);
  const manifest = {
    version: VERSION, identity, provider: "gemini-developer-api", model: options.config.model,
    thinkingLevel: options.config.thinkingLevel, sampling: "provider defaults", limits: options.config.limits,
    tier: options.tier, quotaPolicy: options.quotaPolicy, cases: profiles.map((profile) => profile.incidentId), modes,
    tools: Object.keys(toolSchemas), failureProfiles: allProfiles, pauseBetweenRunsMs: options.pauseMs ?? 0,
    failureReset: "Fresh tools, budget, state and injector per case/mode. Baseline collapses role schedules to Investigator admission ordinals, deduplicating identical ordinals.",
    judge: { batchSize: 6, model: "same Gemini model/settings", policy: "One bounded request per batch, no automatic retry; separate budget and usage, shared quota pacer." },
    grounding: "All sentences in facts, known-cause explanations and action rationales; compound sentences require support for every factual clause. Other prose excluded. Missing citations are unsupported. Failed/missing judgments stay in denominators; no claims => score 0/1. Automated judgment is imperfect.",
    accounting: "Reported tokens only; unknown counts remain null. Known totals are subtotals if availability is partial. UTF-8/3 input estimates cannot guarantee strict token caps. Pauses between runs are outside investigation latency; pacing inside a run is included.",
  };
  const { cases: _selection, ...runIdentity } = manifest;
  return { manifest, fingerprint: hash(JSON.stringify(runIdentity)) };
}

function retrieved(result: RunResult) {
  const report = reportSchema.parse(result.report);
  const records = result.toolHistory.flatMap((attempt) => attempt.result.evidence.map((record) => evidenceSchema.parse(record)));
  const evidence = Object.fromEntries(records.map((record) => [record.id, record]));
  if (report.incidentId !== result.state.incident.id || Object.keys(result.state.evidence).some((id) => !Object.hasOwn(evidence, id))) {
    throw new Error("Investigation artifact is inconsistent with retrieved tool evidence.");
  }
  return evidence;
}
async function readArtifact(directory: string, row: Row, fingerprint: string): Promise<RunResult> {
  const artifact = await readJson(join(directory, filename(row))) as { fingerprint: string; key: string; result: RunResult };
  if (artifact.fingerprint !== fingerprint || artifact.key !== key(row) || artifact.result.report.incidentId !== row.incidentId) {
    throw new Error("Saved run identity does not match this evaluation.");
  }
  retrieved(artifact.result);
  return artifact.result;
}

export function summarize(rows: Row[], labels: z.infer<typeof labelSchema>[]) {
  return Object.fromEntries(modes.map((mode) => {
    const selected = rows.filter((row) => row.mode === mode);
    const scores = selected.map((row) => accuracy(row.report, labels.find((label) => label.incidentId === row.incidentId)!));
    const answerable = scores.filter((score) => !score.expectedInconclusive);
    const inconclusive = scores.filter((score) => score.expectedInconclusive);
    const stats = selected.map((row) => row.report?.stats);
    const knownStats = stats.filter((stat) => stat !== undefined);
    const judgeStats = selected.flatMap((row) => row.judge.batches.map((batch) => batch.stats));
    const claims = selected.map((row) => groundingScore(row.report ? selectClaims(row.report) : [], row.judge.batches.flatMap((batch) => batch.verdicts)));
    // Citation scores are attached after reading the trusted, retrieved-evidence artifacts.
    return [mode, {
      planned: selected.length, reports: scores.filter((score) => score.available).length,
      statuses: Object.fromEntries(statusSchema.options.map((status) => [status, selected.filter((row) => row.status === status).length])),
      rootCause: { correct: answerable.filter((score) => score.correctCause).length, denominator: answerable.length },
      topPair: { matched: answerable.filter((score) => score.topPairMatch).length, denominator: answerable.length },
      correctInconclusive: { correct: inconclusive.filter((score) => score.correctInconclusive).length, denominator: inconclusive.length },
      conclusionCoverage: { concluded: scores.filter((score) => score.concluded).length, denominator: selected.length },
      conclusionPrecision: { correct: answerable.filter((score) => score.correctCause).length, denominator: scores.filter((score) => score.concluded).length },
      grounding: { supported: claims.reduce((sum, claim) => sum + claim.supported, 0), denominator: claims.reduce((sum, claim) => sum + claim.denominator, 0),
        macroRate: claims.reduce((sum, claim) => sum + claim.rate, 0) / selected.length,
        selectedClaims: claims.reduce((sum, claim) => sum + claim.selectedClaims, 0), judgeFailed: claims.reduce((sum, claim) => sum + claim.judgeFailed, 0) },
      investigator: {
        modelAttemptsKnown: knownStats.reduce((sum, stat) => sum + stat.modelAttempts, 0), toolAttemptsKnown: knownStats.reduce((sum, stat) => sum + stat.toolAttempts, 0),
        latencyMsKnown: knownStats.reduce((sum, stat) => sum + stat.elapsedMs, 0), observedRuns: knownStats.length, missingRuns: selected.length - knownStats.length,
        usage: mergeUsage(stats.map((stat) => stat?.usage ?? mergeUsage([]))),
      },
      judge: { modelAttemptsKnown: judgeStats.reduce((sum, stat) => sum + (stat?.modelAttempts ?? 0), 0),
        latencyMsKnown: judgeStats.reduce((sum, stat) => sum + (stat?.elapsedMs ?? 0), 0),
        interruptedBatches: judgeStats.filter((stat) => stat === null).length,
        usage: mergeUsage(judgeStats.filter((stat) => stat === null || stat.modelAttempts > 0).map((stat) => stat?.usage ?? mergeUsage([]))) },
    }];
  }));
}

export function renderEvaluation(checkpoint: Checkpoint) {
  const summary = checkpoint.aggregate as Record<Mode, ReturnType<typeof summarize>[string] & { citations: { macroRate: number } }> | null;
  const ratio = (correct: number, denominator: number) => denominator ? `${correct}/${denominator} (${(100 * correct / denominator).toFixed(1)}%)` : "N/A (0 cases)";
  return `# IncidentLens evaluation\n\nVersion ${VERSION}; identity \`${checkpoint.fingerprint}\`. Updated ${checkpoint.updatedAt}.\n\n` +
    "Accuracy requires a concluded report with the correct top cause class/component. Top-pair matching also includes inconclusive candidates. Correct inconclusive outcomes are separate. All planned case/mode slots remain in rates; absent or failed investigations receive zero accuracy credit.\n\n" +
    (summary ? "| Mode | Cause accuracy | Correct inconclusive | Conclusion coverage | Grounding (macro) | Citation validity (macro) |\n| --- | --- | --- | --- | --- | --- |\n" + modes.map((mode) => {
      const item = summary[mode];
      return `| ${mode} | ${ratio(item.rootCause.correct, item.rootCause.denominator)} | ${ratio(item.correctInconclusive.correct, item.correctInconclusive.denominator)} | ${ratio(item.conclusionCoverage.concluded, item.conclusionCoverage.denominator)} | ${(item.grounding.macroRate * 100).toFixed(1)}% | ${(item.citations.macroRate * 100).toFixed(1)}% |`;
    }).join("\n") + "\n\n" : "Evaluation is in progress; scores are not yet available.\n\n") +
    "| Case | Mode | Execution | Outcome | Investigation attempts (model/tool) | Judge |\n| --- | --- | --- | --- | --- | --- |\n" +
    checkpoint.rows.map((row) => `| ${row.incidentId} | ${row.mode} | ${row.status} | ${row.report?.outcome ?? "unavailable"} | ${row.report ? `${row.report.stats.modelAttempts}/${row.report.stats.toolAttempts}` : "unavailable"} | ${row.judge.status} |`).join("\n") +
    "\n\nGrounding uses sentences from observed facts, known-cause explanations and action rationales, with support required for every factual clause. Summary, confidence prose, assumptions, unknowns and proposed action text are excluded. Missing/unresolved citations, judge failures and missing results cannot earn support. No selected claims scores 0/1. Automated judgment is imperfect. See JSON for claim verdicts, coverage, citation counts, separate investigator/judge latency and reported token subtotals, failures, settings and raw artifact paths. Unknown usage stays null/incomplete. Between-run pauses are recorded outside individual latency.\n";
}

async function lock(directory: string) {
  const path = join(directory, ".evaluation.lock");
  try { const file = await open(path, "wx"); await file.writeFile(String(process.pid)); await file.close(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(path, "utf8"));
    try { process.kill(pid, 0); } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ESRCH") { await rm(path); return lock(directory); }
      throw failure;
    }
    throw new Error("Another evaluation owns this output directory.");
  }
  return () => rm(path, { force: true });
}

function newRow(incidentId: string, mode: Mode): Row {
  return { incidentId, mode, status: "pending", artifact: null, report: null, error: null, judge: { status: "pending", batches: [], inFlight: [] } };
}

export async function runEvaluation(options: EvaluationOptions) {
  if (options.tier !== "free" || !options.quotaPolicy.trim()) throw new Error("Record verified free-tier quota policy before live execution. Paid execution is not authorized.");
  if (!Number.isSafeInteger(options.pauseMs ?? 0) || (options.pauseMs ?? 0) < 0) throw new Error("pauseMs must be a nonnegative integer.");
  const profiles = await validateInputs(options.cases);
  const { manifest, fingerprint } = await createManifest(options, profiles);
  const directory = resolve(options.outputDirectory ?? join(ROOT, "results"));
  const checkpointPath = join(directory, "evaluation.json");
  await mkdir(directory, { recursive: true });
  const unlock = await lock(directory);
  const pacer = createPacer(options.config.limits.modelIntervalMs);
  const runners = options.runners ?? { "multi-agent": investigate, "single-agent": investigateBaseline };
  let checkpoint: Checkpoint;
  try {
    if (await exists(checkpointPath)) {
      if (!options.resume) throw new Error("Evaluation already exists. Use --resume or choose a new --output directory.");
      checkpoint = checkpointSchema.parse(await readJson(checkpointPath));
      const previousManifest = checkpoint.manifest as typeof manifest;
      if (checkpoint.fingerprint !== fingerprint || JSON.stringify({ ...previousManifest, cases: manifest.cases }) !== JSON.stringify(manifest)) {
        throw new Error("Code/data/model/settings identity changed; saved evaluation is stale. Choose a new --output directory.");
      }
      const expected = previousManifest.cases.flatMap((incidentId) => modes.map((mode) => `${incidentId}.${mode}`));
      if (JSON.stringify(checkpoint.rows.map(key)) !== JSON.stringify(expected)) throw new Error("Saved case/mode slots are inconsistent.");
      if (previousManifest.cases.some((id) => !manifest.cases.includes(id))) throw new Error("Resume cannot drop previously planned cases.");
      checkpoint.rows = profiles.flatMap((profile) => modes.map((mode) => checkpoint.rows.find((row) => row.incidentId === profile.incidentId && row.mode === mode) ?? newRow(profile.incidentId, mode)));
      checkpoint.manifest = manifest;
    } else {
      if (options.resume) throw new Error("No evaluation checkpoint exists to resume.");
      checkpoint = { version: VERSION, fingerprint, manifest, createdAt: new Date().toISOString(), updatedAt: "", aggregate: null, pauses: [],
        rows: profiles.flatMap((profile) => modes.map((mode) => newRow(profile.incidentId, mode))) };
    }
    async function save() {
      checkpoint.updatedAt = new Date().toISOString();
      await writeJson(checkpointPath, checkpoint);
      await writeFile(join(directory, "evaluation.md"), renderEvaluation(checkpoint));
    }
    await save();
    let ran = false;
    for (const row of checkpoint.rows) {
      let result: RunResult | null = null;
      const artifactExists = await exists(join(directory, filename(row)));
      if (row.artifact || artifactExists) {
        result = await readArtifact(directory, row, fingerprint);
        row.report = result.report;
        row.artifact = filename(row);
        if (["running", "pending"].includes(row.status)) row.status = result.report.failures.some((failure) => failure.scope !== "tool") ? "failed" : "completed";
      } else if (row.report) throw new Error("Completed report is missing its raw artifact; refusing duplicate API work.");
      else if (row.status === "running") { row.status = "interrupted"; row.error = "Interrupted investigation; provider usage and completion are unknown."; }
      if (row.judge.status === "running") {
        row.judge.batches.push({ stats: null, error: "Interrupted judge request; provider usage is unknown.",
          verdicts: row.judge.inFlight.map((id) => ({ id, verdict: "judge_failed", reason: "Interrupted judge request; not automatically repeated." })) });
        row.judge.status = "interrupted"; row.judge.inFlight = [];
      }
      if (options.retryIncomplete) {
        if (!result && ["interrupted", "failed", "quota_blocked"].includes(row.status)) row.status = "pending";
        row.judge.batches = row.judge.batches.map((batch) => ({ ...batch, verdicts: batch.verdicts.filter((verdict) => verdict.verdict !== "judge_failed") }));
      }
      if (!result && row.status === "quota_blocked") row.status = "pending";
      if (options.signal?.aborted || pacer.stopped) {
        if (row.status === "pending") { row.status = options.signal?.aborted ? "interrupted" : "quota_blocked"; row.error = pacer.stopped ?? "Evaluation cancelled before this run."; }
        if (row.judge.status !== "completed") row.judge.status = options.signal?.aborted ? "interrupted" : "quota_blocked";
        await save(); continue;
      }
      if (!result && row.status === "pending") {
        if (ran && options.pauseMs) {
          const started = performance.now();
          let completed = true;
          try { await pause(options.pauseMs, undefined, { signal: options.signal }); } catch { completed = false; }
          checkpoint.pauses.push({ before: key(row), requestedMs: options.pauseMs, elapsedMs: performance.now() - started, completed });
        }
        if (options.signal?.aborted) { row.status = "interrupted"; row.error = "Evaluation cancelled before this run."; await save(); continue; }
        row.status = "running"; row.error = null; checkpoint.aggregate = null; await save();
        const profile = profiles.find((item) => item.incidentId === row.incidentId)!;
        try {
          result = await runners[row.mode](row.incidentId, {
            config: options.config, signal: options.signal, pacer, apiTier: `${options.tier}; operator-recorded policy: ${options.quotaPolicy}`,
            toolFailures: profile.toolFailures, agentFailures: profile.agentFailures, traceDirectory: join(directory, "traces"),
          });
          retrieved(result);
          await writeJson(join(directory, filename(row)), { version: VERSION, fingerprint, key: key(row), result });
          row.artifact = filename(row); row.report = result.report;
          row.status = pacer.stopped ? "quota_blocked" : options.signal?.aborted ? "interrupted"
            : result.report.failures.some((failure) => failure.scope !== "tool") ? "failed" : "completed";
        } catch (failure) { row.status = pacer.stopped ? "quota_blocked" : options.signal?.aborted ? "interrupted" : "failed"; row.error = safeError(failure); }
        ran = true;
        await save();
      }
      if (result) {
        const evidence = retrieved(result);
        const claims = selectClaims(result.report);
        const ids = new Set(claims.map((claim) => claim.id));
        const saved = row.judge.batches.flatMap((batch) => batch.verdicts);
        if (new Set(saved.map((item) => item.id)).size !== saved.length || saved.some((item) => !ids.has(item.id))) throw new Error("Saved judge claims are inconsistent.");
        const remaining = claims.filter((claim) => !saved.some((verdict) => verdict.id === claim.id));
        for (let offset = 0; offset < remaining.length; offset += 6) {
          if (pacer.stopped || options.signal?.aborted) break;
          const batch = remaining.slice(offset, offset + 6);
          row.judge.status = "running"; row.judge.inFlight = batch.map((claim) => claim.id); await save();
          row.judge.batches.push(await judgeClaims(batch, evidence, { config: options.config, pacer, signal: options.signal, transport: options.judgeTransport }));
          row.judge.inFlight = [];
          row.judge.status = "pending"; await save();
        }
        const judged = row.judge.batches.flatMap((batch) => batch.verdicts);
        row.judge.status = pacer.stopped ? "quota_blocked" : options.signal?.aborted ? "interrupted"
          : judged.some((verdict) => verdict.verdict === "judge_failed") ? "failed" : "completed";
      } else if (row.judge.status === "pending") row.judge.status = row.status === "completed" ? "failed" : row.status;
      await save();
    }
    // Ground truth is opened only after investigations/judging have returned, never passed to a runner or judge.
    const labels = await loadLabels();
    const summary = summarize(checkpoint.rows, labels);
    const perCase = [];
    for (const row of checkpoint.rows) {
      const evidence = row.artifact ? retrieved(await readArtifact(directory, row, fingerprint)) : {};
      perCase.push({ key: key(row), accuracy: accuracy(row.report, labels.find((label) => label.incidentId === row.incidentId)!),
        citations: row.report ? citationScore(row.report, evidence) : { valid: 0, denominator: 1, rate: 0 },
        grounding: groundingScore(row.report ? selectClaims(row.report) : [], row.judge.batches.flatMap((batch) => batch.verdicts)) });
    }
    for (const mode of modes) {
      const selected = perCase.filter((item) => item.key.endsWith(`.${mode}`));
      Object.assign(summary[mode], { citations: { valid: selected.reduce((sum, item) => sum + item.citations.valid, 0),
        denominator: selected.reduce((sum, item) => sum + item.citations.denominator, 0),
        macroRate: selected.reduce((sum, item) => sum + item.citations.rate, 0) / selected.length }, perCase: selected });
    }
    checkpoint.aggregate = summary;
    await save();
    return checkpoint;
  } finally { await unlock(); }
}

async function main() {
  try { process.loadEnvFile(".env.local"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const args = process.argv.slice(2);
  const flags = new Set(["--dry-run", "--run", "--resume", "--retry-incomplete"]);
  const valued = new Set(["--cases", "--output", "--tier", "--quota-policy", "--pause-ms"]);
  const values = new Map<string, string>();
  const enabled = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (flags.has(args[i])) enabled.add(args[i]);
    else if (valued.has(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) values.set(args[i], args[++i]);
    else throw new Error("Unknown/missing evaluation argument. See README evaluation commands.");
  }
  const dryRun = enabled.has("--dry-run");
  if (dryRun === enabled.has("--run")) throw new Error("Choose exactly one of --dry-run or --run.");
  const config = getModelConfig({ ...process.env, GEMINI_API_KEY: dryRun ? "non-billable-validation" : process.env.GEMINI_API_KEY });
  const cases = values.get("--cases")?.split(",");
  if (dryRun) {
    const profiles = await validateInputs(cases, true);
    console.log(JSON.stringify({ valid: true, billable: false, benchmarkScores: false, cases: profiles.map((profile) => profile.incidentId),
      modes, model: config.model, thinkingLevel: config.thinkingLevel, limits: config.limits,
      tier: "Unverified: dry run makes no network requests and checks no quota.", expectedInvestigationSlots: profiles.length * 2 }, null, 2));
    return;
  }
  if (values.get("--tier") !== "free") throw new Error("Use --tier free with a verified --quota-policy. Paid execution is not authorized.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const result = await runEvaluation({ config, cases, outputDirectory: values.get("--output"), tier: "free", quotaPolicy: values.get("--quota-policy") ?? "",
      pauseMs: Number(values.get("--pause-ms") ?? 0), resume: enabled.has("--resume"), retryIncomplete: enabled.has("--retry-incomplete"), signal: controller.signal });
    console.log(`Evaluation saved. ${result.rows.filter((row) => row.status === "completed").length}/${result.rows.length} investigation slots completed. See evaluation.json and evaluation.md.`);
    if (result.rows.some((row) => row.status !== "completed" || row.judge.status !== "completed")) process.exitCode = 1;
  } finally { process.removeListener("SIGINT", cancel); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Evaluation failed."); process.exitCode = 1; });
}
