import { z } from "zod";
import { evidenceSchema, progressEventSchema, reportSchema, type ProgressEvent, type Role } from "@/lib/schemas";

export const modes = ["multi-agent", "single-agent"] as const;
export type Mode = typeof modes[number];
export const requestSchema = z.strictObject({ incidentId: z.string().max(40), mode: z.enum(modes) });
export const streamEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("progress"), event: progressEventSchema }),
  z.strictObject({ type: z.literal("result"), report: reportSchema, evidence: z.array(evidenceSchema) }),
  z.strictObject({ type: z.literal("error"), message: z.string().min(1) }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;

export async function readInvestigationStream(body: ReadableStream<Uint8Array>, receive: (event: StreamEvent) => void) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", terminal = false;
  function line(value: string) {
    if (!value.trim()) return;
    if (terminal) throw new Error("Unexpected event after the investigation ended.");
    let event: StreamEvent;
    try { event = streamEventSchema.parse(JSON.parse(value)); }
    catch { throw new Error("Invalid investigation stream. Please retry."); }
    terminal = event.type !== "progress";
    receive(event);
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (buffer.length > 2_000_000) throw new Error("Investigation stream exceeded the message limit.");
      if (done) break;
    }
    line(buffer);
    if (!terminal) throw new Error("Connection interrupted before the final report. Please retry.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export type NodeStatus = "idle" | "running" | "completed" | "failed" | "skipped";
export const roles = ["Orchestrator", "Observability", "Dependency", "Reasoning", "Critic", "Reporting"] as const;
export function roleStatuses(events: ProgressEvent[], ended: boolean): Record<Role, NodeStatus> {
  const result: Record<Role, NodeStatus> = { Orchestrator: "idle", Observability: "idle", Dependency: "idle", Reasoning: "idle", Critic: "idle", Reporting: "idle", Investigator: "idle" };
  const tasks = new Map<string, { role: Role; status: ProgressEvent["status"] }>();
  for (const event of events) {
    if (event.type === "role" && event.role && event.status && event.status !== "pending") result[event.role] = event.status;
    if (event.type === "task" && event.taskId && event.role) tasks.set(event.taskId, { role: event.role, status: event.status });
  }
  for (const role of roles) {
    const assigned = [...tasks.values()].filter((task) => task.role === role);
    if (assigned.some((task) => task.status === "running")) result[role] = "running";
    else if (assigned.some((task) => task.status === "failed")) result[role] = "failed";
    else if (assigned.length && assigned.every((task) => task.status === "skipped")) result[role] = "skipped";
    else if (assigned.some((task) => task.status === "pending")) result[role] = "idle";
  }
  if (ended) for (const role of [...roles, "Investigator"] as const) {
    if (result[role] === "running") result[role] = "failed";
    else if (result[role] === "idle") result[role] = "skipped";
  }
  return result;
}
