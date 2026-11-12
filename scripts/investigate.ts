import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { investigateBaseline } from "../lib/baseline";
import { investigate } from "../lib/investigation";
import { RunError, safeError } from "../lib/budget";
import { getModelConfig } from "../lib/model";
import { scenarioSchema } from "../lib/schemas";
import { listIncidents } from "../lib/tools";
import { z } from "zod";

// Node's dotenv loader preserves existing environment overrides; no Next.js dependency.
try { process.loadEnvFile(".env.local"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const id = process.argv[2];
if (!id || id === "--list") {
  console.log(listIncidents().map((incident) => `${incident.id}\t${incident.title}`).join("\n"));
  if (!id) console.error("Usage: npm run investigate -- inc-001");
} else {
  try {
    if (!listIncidents().some((incident) => incident.id === id)) throw new RunError("Unknown incident. Use --list.");
    const profiles = z.array(scenarioSchema).parse(JSON.parse(await readFile(fileURLToPath(new URL("../evaluation/scenarios.json", import.meta.url)), "utf8")));
    const profile = profiles.find((item) => item.incidentId === id);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    try {
      const runner = process.argv.includes("--single-agent") ? investigateBaseline : investigate;
      const result = await runner(id, {
        config: getModelConfig(), signal: controller.signal, toolFailures: profile?.toolFailures, agentFailures: profile?.agentFailures,
        onEvent: (event) => console.error(`${(event.elapsedMs / 1000).toFixed(1)}s ${event.type} ${event.role ?? ""} ${event.message}`),
      });
      console.log(JSON.stringify({ report: result.report, tracePath: result.tracePath }, null, 2));
      if (result.report.failures.some((failure) => failure.scope !== "tool")) process.exitCode = 1;
    } finally { process.removeListener("SIGINT", cancel); }
  } catch (error) {
    console.error(safeError(error));
    process.exitCode = 1;
  }
}
