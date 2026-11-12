"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Background, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { EvaluationView } from "@/app/dashboard-data";
import type { Evidence, Incident, ProgressEvent, Report } from "@/lib/schemas";
import { modes, readInvestigationStream, roles, roleStatuses, type Mode, type NodeStatus } from "./investigation-stream";
import { Card, CardTitle } from "./ui/card";

const number = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString("en-US");
const seconds = (value: number) => `${(value / 1000).toFixed(1)}s`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const colors: Record<NodeStatus, string> = { idle: "#94a3b8", running: "#2563eb", completed: "#059669", failed: "#dc2626", skipped: "#94a3b8" };
const positions = [{ x: 220, y: 0 }, { x: 60, y: 100 }, { x: 380, y: 100 }, { x: 220, y: 200 }, { x: 220, y: 300 }, { x: 220, y: 400 }];
const links = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [4, 0], [4, 5]];

function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{value.replaceAll("_", " ")}</span>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="space-y-2"><h3 className="text-sm font-semibold">{title}</h3>{children}</div>;
}
function Items({ values }: { values: string[] }) {
  return values.length ? <ul className="list-disc space-y-1 pl-4 text-sm text-slate-600">{values.map((value, i) => <li key={i}>{value}</li>)}</ul> : <p className="text-sm text-slate-500">None recorded.</p>;
}
function Citations({ ids, available = true }: { ids: string[]; available?: boolean }) {
  return ids.length ? <span className="inline-flex flex-wrap gap-1">{ids.map((id) => available ? <a className="citation" href={`#${id}`} key={id}>{id}</a> : <span className="citation" key={id}>{id}</span>)}</span> : <span className="text-xs text-slate-500">None recorded</span>;
}

function InvestigationGraph({ events, ended, mode }: { events: ProgressEvent[]; ended: boolean; mode: Mode }) {
  const statuses = useMemo(() => roleStatuses(events, ended), [events, ended]);
  const nodes: Node[] = roles.map((role, i) => ({ id: role, position: positions[i],
    data: { label: <div className="flex items-center justify-between gap-3"><span className="font-semibold">{role}</span><Status value={statuses[role]} /></div> },
    style: { width: 210, padding: "14px 16px", borderRadius: 10, borderColor: colors[statuses[role]], background: "white", boxShadow: "0 2px 6px #0f172a08" },
  }));
  const edges: Edge[] = links.map(([from, to]) => ({ id: `${from}-${to}`, source: roles[from], target: roles[to],
    type: "smoothstep", label: from === 4 && to === 0 ? "Follow-up" : undefined,
    style: { stroke: "#cbd5e1" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" },
  }));
  if (mode === "single-agent") return <div className="flex min-h-[340px] flex-col items-center justify-center gap-4 rounded-lg bg-slate-50 text-center">
    <div className="rounded-xl border bg-white px-8 py-5"><p className="mb-3 font-semibold">General investigator</p><Status value={statuses.Investigator} /></div>
    <p className="max-w-sm px-4 text-sm text-slate-500">One agent gathers evidence and writes the report. Specialist roles and the critic are inactive in baseline mode.</p>
  </div>;
  return <div className="h-[365px] rounded-lg bg-slate-50" aria-label="Six-agent investigation status">
    <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.14 }} nodesDraggable={false} nodesConnectable={false}
      elementsSelectable={false} nodesFocusable={false} edgesFocusable={false} panOnDrag={false} zoomOnScroll={false} zoomOnPinch={false}
      zoomOnDoubleClick={false} preventScrolling={false} minZoom={0.3} maxZoom={1}>
      <Background color="#dbe2ea" gap={18} size={1} />
    </ReactFlow>
  </div>;
}

function FinalReport({ report, evidence }: { report: Report; evidence: Evidence[] }) {
  const { stats } = report;
  return <div className="space-y-6" aria-label="Final investigation report">
    <div className="flex flex-wrap items-center justify-between gap-2"><CardTitle>Investigation report</CardTitle><Status value={report.outcome} /></div>
    <p className="text-sm leading-6 text-slate-600">{report.summary}</p>
    <div className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-4 text-sm">
      <div><p className="metric-label">Elapsed</p><strong>{seconds(stats.elapsedMs)}</strong></div>
      <div><p className="metric-label">Model attempts</p><strong>{stats.modelAttempts}</strong></div>
      <div><p className="metric-label">Tool attempts</p><strong>{stats.toolAttempts}</strong></div>
    </div>
    <Section title="Ranked hypotheses">
      <p className="text-xs text-slate-500">Confidence is an assessment, not a calibrated probability or proof of cause.</p>
      {!report.hypotheses.length && <p className="text-sm text-slate-500">No supported hypothesis was produced.</p>}
      {report.hypotheses.map((hypothesis, i) => <article className="space-y-3 rounded-lg border border-slate-200 p-4" key={hypothesis.id}>
        <div className="flex flex-wrap justify-between gap-2"><h4 className="text-sm font-semibold">{i + 1}. {hypothesis.component}</h4><Status value={`${hypothesis.confidence} confidence`} /></div>
        <p className="text-xs text-slate-500">{hypothesis.causeClass.replaceAll("_", " ")}</p>
        <p className="text-sm text-slate-600">{hypothesis.explanation}</p>
        <p className="text-sm"><strong>Confidence rationale: </strong>{hypothesis.rationale}</p>
        <div className="text-xs"><p className="mb-1 font-semibold text-emerald-700">Supporting evidence</p><Citations ids={hypothesis.support} /></div>
        <div className="text-xs"><p className="mb-1 font-semibold text-amber-700">Contradicting evidence</p><Citations ids={hypothesis.contradictions} /></div>
        <details className="text-sm"><summary>Assumptions and unknowns</summary><div className="mt-2 space-y-3"><Section title="Assumptions"><Items values={hypothesis.assumptions} /></Section><Section title="Unknowns"><Items values={hypothesis.unknowns} /></Section></div></details>
      </article>)}
    </Section>
    <Section title="Observed facts">{report.observedFacts.length ? report.observedFacts.map((fact, i) => <div key={i} className="space-y-1 border-l-2 border-emerald-200 pl-3"><p className="text-sm text-slate-600">{fact.statement}</p><Citations ids={fact.evidenceIds} /></div>) : <p className="text-sm text-slate-500">No observed facts recorded.</p>}</Section>
    <Section title="Assumptions"><Items values={report.assumptions} /></Section>
    <Section title="Unknowns"><Items values={report.unknowns} /></Section>
    <Section title="Recommended actions · advisory only">{report.actions.length ? report.actions.map((action, i) => <div key={i} className="space-y-1 rounded-lg bg-slate-50 p-3"><p className="text-sm font-medium">{action.action}</p><p className="text-sm text-slate-600">{action.rationale}</p><Citations ids={action.evidenceIds} /></div>) : <p className="text-sm text-slate-500">No actions recommended.</p>}</Section>
    <Section title="Limitations"><Items values={report.limitations} /></Section>
    <Section title="Tool and agent failures"><Items values={report.failures.map((failure) => `${failure.scope} / ${failure.name}: ${failure.message}`)} /></Section>
    <Section title="Stop reason"><p className="text-sm text-slate-600">{report.stopReason}</p></Section>
    <Section title={`Token usage · ${stats.usage.availability}`}>
      <p className="text-xs text-slate-500">{stats.usage.availability === "complete" ? "Provider-reported totals." : "Known counts are subtotals; missing counts are unavailable."} Output includes thinking; cache is an input subset.</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">{([['Input', stats.usage.input], ['Output', stats.usage.output], ['Total', stats.usage.total], ['Visible output', stats.usage.visibleOutput], ['Thinking tokens', stats.usage.thinking], ['Cached input', stats.usage.cacheRead], ['Tool prompt', stats.usage.toolUsePrompt]] as const).map(([label, value]) => <div className="flex justify-between gap-2" key={label}><dt className="text-slate-500">{label}</dt><dd className="font-medium">{number(value)}</dd></div>)}</dl>
    </Section>
    <Section title={`Retrieved evidence · ${evidence.length}`}>
      {evidence.length ? evidence.map((record) => <details className="scroll-mt-6 rounded-lg border border-slate-200 p-3 text-sm" id={record.id} key={record.id}>
        <summary><span className="font-mono text-xs text-blue-700">{record.id}</span> · {record.source} · {record.service}</summary>
        <p className="my-2 text-xs text-slate-500">{record.timestamp}</p><pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 text-xs">{JSON.stringify(record.raw, null, 2)}</pre>
      </details>) : <p className="text-sm text-slate-500">No evidence retrieved.</p>}
    </Section>
  </div>;
}

function Evaluation({ data }: { data: EvaluationView }) {
  return <Card className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><CardTitle>Measured, not assumed</CardTitle><p className="mt-1 text-sm text-slate-500">Saved multi-agent and single-agent evaluation</p></div><Status value={data.status} /></div>
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{data.message}</p>
    {data.updatedAt && <p className="text-xs text-slate-500">{data.model} · Saved {data.updatedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC")}</p>}
    {!!data.rows.length && <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm">
      <thead><tr>{["Mode", "Cause accuracy", "Correct inconclusive", "Grounding", "Valid citations", "Tools / models", "Mean latency", "Known tokens"].map((label) => <th key={label} className="border-b px-3 py-3 text-xs font-medium text-slate-500">{label}</th>)}</tr></thead>
      <tbody>{data.rows.map((row) => <tr key={row.mode}>
        <td className="table-cell font-semibold">{row.mode === "multi-agent" ? "Multi-agent" : "Single-agent"}<span className="mt-1 block text-xs font-normal text-slate-500">{row.statuses.completed}/{row.planned} completed</span></td>
        <td className="table-cell">{row.rootCause.correct}/{row.rootCause.denominator}</td><td className="table-cell">{row.correctInconclusive.correct}/{row.correctInconclusive.denominator}</td>
        <td className="table-cell">{percent(row.grounding.macroRate)}{row.grounding.judgeFailed > 0 && <span className="block text-xs text-amber-700">{row.grounding.judgeFailed} unjudged claims</span>}</td>
        <td className="table-cell">{percent(row.citations.macroRate)}</td><td className="table-cell">{row.investigator.toolAttemptsKnown} / {row.investigator.modelAttemptsKnown}</td>
        <td className="table-cell">{row.investigator.observedRuns ? seconds(row.investigator.latencyMsKnown / row.investigator.observedRuns) : "Unavailable"}</td>
        <td className="table-cell">{number(row.investigator.usage.total)}<span className="block text-xs text-slate-500">{row.investigator.usage.availability}</span></td>
      </tr>)}</tbody>
    </table></div>}
    <p className="text-xs leading-5 text-slate-500">Ten synthetic incidents; one stochastic run per mode. Failed runs receive no accuracy credit. Grounding and citation rates are per-case macro averages; failed judgments stay in denominators. Automated judgment is imperfect. Investigator metrics exclude judging.</p>
    {!!data.rows.length && <details className="text-sm"><summary>Separate evaluator cost</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{data.rows.map((row) => <div className="rounded-lg bg-slate-50 p-3" key={row.mode}><p className="font-medium">{row.mode}</p><p className="mt-1 text-xs text-slate-600">{row.judge.modelAttemptsKnown} requests · {seconds(row.judge.latencyMsKnown)} · {number(row.judge.usage.total)} known tokens ({row.judge.usage.availability})</p></div>)}</div></details>}
  </Card>;
}

export default function Dashboard({ incidents, evaluation }: { incidents: Incident[]; evaluation: EvaluationView }) {
  const [incidentId, setIncidentId] = useState(incidents[0]?.id ?? "");
  const [mode, setMode] = useState<Mode>("multi-agent");
  const [status, setStatus] = useState<"idle" | "running" | "completed" | "error" | "cancelled">("idle");
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [result, setResult] = useState<{ report: Report; evidence: Evidence[] } | null>(null);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null), feed = useRef<HTMLDivElement>(null);
  const incident = incidents.find(({ id }) => id === incidentId);
  const running = status === "running";
  const evidenceCount = new Set(events.flatMap((event) => event.evidenceIds)).size;
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [events]);
  function clear() { setEvents([]); setResult(null); setError(""); setStatus("idle"); }
  async function start() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    clear(); setStatus("running");
    try {
      const response = await fetch("/api/investigate", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incidentId, mode }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(150_000)]) });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.message === "string" ? body.message : "Investigation request failed. Please retry.");
      }
      if (!response.body) throw new Error("Streaming is unavailable in this browser.");
      await readInvestigationStream(response.body, (event) => {
        if (active.current !== controller) return;
        if (event.type === "progress") setEvents((prior) => [...prior, event.event]);
        else if (event.type === "result") { setResult(event); setStatus("completed"); }
        else { setError(event.message); setStatus("error"); }
      });
    } catch (failure) {
      if (active.current !== controller) return;
      setResult(null);
      if (controller.signal.aborted) setStatus("cancelled");
      else { setError(failure instanceof Error && failure.name !== "TypeError" ? failure.message : "Connection failed. Check the local server and retry."); setStatus("error"); }
    } finally { if (active.current === controller) active.current = null; }
  }
  return <>
    <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
      <a href="/" className="flex items-center gap-3 font-semibold tracking-tight"><span className="grid size-8 place-items-center rounded-lg bg-slate-900 text-xs text-white">IL</span>IncidentLens</a>
      <span className="flex items-center gap-2 text-xs text-slate-500"><span className="size-1.5 rounded-full bg-emerald-500" />Local workspace</span>
    </div></header>
    <main className="mx-auto max-w-7xl space-y-6 px-5 py-8 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Investigation workspace</p><h1 className="text-3xl font-semibold tracking-tight">Follow the evidence.</h1><p className="mt-2 text-sm text-slate-500">Investigate an incident, challenge its causes, and inspect every citation.</p></div><span className="text-xs text-slate-500">Simulated operational data · Gemini</span></div>
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <Card className="space-y-5"><div><CardTitle>Start an investigation</CardTitle><p className="mt-1 text-xs text-slate-500">Choose a report and an investigation approach.</p></div>
          <label className="block text-sm font-medium">Incident<select value={incidentId} disabled={running} onChange={(event) => { setIncidentId(event.target.value); clear(); }} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm">{incidents.map((item) => <option value={item.id} key={item.id}>{item.id} · {item.title}</option>)}</select></label>
          {incident && <div className="rounded-lg bg-slate-50 p-4"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Incident report</p><p className="text-sm leading-6">{incident.description}</p><p className="mt-3 text-xs text-slate-500">{incident.service} · {incident.start.slice(0, 10)}</p></div>}
          <fieldset disabled={running}><legend className="mb-2 text-sm font-medium">Investigation mode</legend><div className="grid grid-cols-2 gap-2">{modes.map((value) => <label className={`cursor-pointer rounded-lg border px-3 py-3 text-center text-sm ${mode === value ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 text-slate-600"}`} key={value}><input className="sr-only" type="radio" name="mode" value={value} checked={mode === value} onChange={() => { setMode(value); clear(); }} />{value === "multi-agent" ? "Multi-agent" : "Single-agent"}</label>)}</div></fieldset>
          <button className="primary-button w-full" disabled={running || !incident} onClick={start}>{running ? "Investigating…" : "Investigate →"}</button>
          {running && <button className="w-full rounded-lg border border-slate-300 py-2 text-sm" onClick={() => { active.current?.abort(); setStatus("cancelled"); }}>Cancel investigation</button>}
          <p className="text-xs leading-5 text-slate-500">Runs use the server’s configured Gemini key and shared execution limits. Recommendations are advisory.</p>
        </Card>
        <Card className="space-y-4"><div className="flex items-center justify-between gap-3"><div><CardTitle>{mode === "multi-agent" ? "Six roles. One investigation." : "Single-agent baseline"}</CardTitle><p className="mt-1 text-xs text-slate-500">Status follows actual backend events.</p></div><Status value={status} /></div>
          <InvestigationGraph events={events} ended={!running && status !== "idle"} mode={mode} />
          <p className="text-xs text-slate-500">{running ? "Gathering and assessing evidence…" : status === "completed" ? "Report ready below." : status === "idle" ? "Select an incident, then start a run." : "Run ended before a final report."} {events.length > 0 && `${events.length} events · ${evidenceCount} evidence records`}</p>
        </Card>
      </div>
      <div role="status" aria-live="polite" className={status === "error" || status === "cancelled" ? "rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" : "sr-only"}>{status === "error" ? error : status === "cancelled" ? "Investigation cancelled. No final report received; partial events are retained. Start another run to try again." : status === "completed" ? `Report ready: ${result?.report.outcome}.` : running ? "Investigation running." : "Ready to investigate."}</div>
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_360px]">
        <Card>{result ? <FinalReport {...result} /> : <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center"><span className="grid size-10 place-items-center rounded-full bg-slate-100 text-slate-500">⌕</span><CardTitle>Evidence before conclusions</CardTitle><p className="max-w-sm text-sm leading-6 text-slate-500">{running ? "The investigation is in progress. A validated report will appear here when it ends." : "Your ranked hypotheses, supporting records, contradictions, and next steps will appear here."}</p></div>}</Card>
        <Card className="space-y-4"><div className="flex items-center justify-between"><CardTitle>Activity & evidence</CardTitle><span className="text-xs text-slate-500">{events.length} events</span></div>
          <div ref={feed} className="max-h-[560px] space-y-4 overflow-y-auto pr-2" aria-label="Investigation event feed">
            {!events.length && <p className="py-8 text-center text-sm text-slate-500">Waiting for an investigation.</p>}
            {events.map((event) => <div className="border-l-2 border-slate-200 pl-3" key={event.sequence}><div className="flex justify-between gap-2 text-xs"><span className="font-semibold">{event.role ?? "Investigation"}</span><span className="text-slate-400">{seconds(event.elapsedMs)}</span></div><p className={`mt-1 break-words text-xs leading-5 ${event.type === "error" ? "text-red-700" : "text-slate-600"}`}>{event.message}</p>{event.status && <span className="mt-1 inline-block text-[10px] uppercase tracking-wide text-slate-400">{event.type} · {event.status}{event.round ? ` · Round ${event.round}` : ""}</span>}{!!event.evidenceIds.length && <div className="mt-1"><Citations ids={event.evidenceIds} available={!!result} /></div>}</div>)}
          </div>
        </Card>
      </div>
      <Evaluation data={evaluation} />
      <footer className="pb-4 text-center text-xs text-slate-400">IncidentLens · Evidence-backed investigation on synthetic data · Run state is in memory and clears on refresh.</footer>
    </main>
  </>;
}
