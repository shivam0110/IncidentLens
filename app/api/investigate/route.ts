import { investigate } from "@/lib/investigation";
import { investigateBaseline } from "@/lib/baseline";
import { createPacer } from "@/lib/budget";
import { ConfigurationError, getModelConfig, providerDiagnostic } from "@/lib/model";
import { requestSchema, streamEventSchema, type StreamEvent } from "@/components/investigation-stream";
import { dashboardIncidents } from "@/app/dashboard-data";

export const runtime = "nodejs";
let pacer: ReturnType<typeof createPacer> | undefined;

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  if (origin && origin !== `${url.protocol}//${request.headers.get("host") ?? url.host}`) return Response.json({ message: "Open the dashboard on this server to investigate." }, { status: 403 });
  let input: { incidentId: string; mode: "multi-agent" | "single-agent" };
  try {
    const text = await request.text();
    if (text.length > 2048) throw new Error();
    input = requestSchema.parse(JSON.parse(text));
    if (!dashboardIncidents.some(({ id }) => id === input.incidentId)) throw new Error();
  } catch { return Response.json({ message: "Choose a valid incident and investigation mode." }, { status: 400 }); }
  let config;
  try { config = getModelConfig(); }
  catch (error) { return Response.json({ message: error instanceof ConfigurationError ? error.message : "Check server configuration in .env.local." }, { status: 503 }); }
  // Respect the verified 15 RPM free-tier policy across dashboard requests.
  config.limits.modelIntervalMs = Math.max(4500, config.limits.modelIntervalMs);
  pacer ??= createPacer(config.limits.modelIntervalMs);
  const abort = new AbortController(), encoder = new TextEncoder();
  let closed = false;
  const cancel = () => { closed = true; abort.abort(); };
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: StreamEvent) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(streamEventSchema.parse(event)) + "\n"));
      };
      const runner = input.mode === "multi-agent" ? investigate : investigateBaseline;
      void (async () => {
        try {
          if (closed) return;
          const result = await runner(input.incidentId, { config, signal: abort.signal, pacer,
            traceDirectory: false, onEvent: (event) => send({ type: "progress", event }) });
          send({ type: "result", report: result.report, evidence: Object.values(result.state.evidence) });
        } catch (error) { send({ type: "error", message: providerDiagnostic(error) }); }
        finally {
          request.signal.removeEventListener("abort", cancel);
          if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    cancel,
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
