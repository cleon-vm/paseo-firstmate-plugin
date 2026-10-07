/** Status reports are snapshots: board requests never wait for a timeline. */
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PluginLifecycleEvents, PluginLifecycleRegistration } from "@getpaseo/plugin/server";

import { CrewReportSchema, type CrewReportSummary } from "../shared/fleet";
import { parseCrewReport } from "./crew-report";
import type { PaseoAgent, PaseoApi, TimelineItem } from "./host-types";
import { pluginDir } from "./data-dir";
import { serialized } from "./serialize";

export const REPORT_CONCURRENCY = 4;
export const REPORT_DEADLINE_MS = 5_000;
/** A streamed closing reply may span several adjacent assistant messages. */
export function closingText(items: readonly TimelineItem[]): string | null {
  const parts: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) break;
    if (item.type === "assistant_message") {
      parts.unshift(item.text);
      continue;
    }
    if (item.type === "plugin" || item.type === "notification") continue;
    break;
  }
  const text = parts.join("");
  return text.trim() === "" ? null : text;
}
interface CachedReport {
  updatedAt: string;
  report: CrewReportSummary | null;
}
interface ReadJob {
  paseo: PaseoApi;
  agent: PaseoAgent;
  previous: CachedReport | undefined;
  expired: boolean;
}

export class ReportCache {
  private readonly reports = new Map<string, CachedReport>();
  private readonly pending = new Map<string, ReadJob>();
  private readonly queue: ReadJob[] = [];
  private readonly retryAfter = new Map<string, number>();
  private active = 0;
  private stopped = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly offs: Array<() => void> = [];

  constructor(private readonly stateFile: string | null = null) {
    if (stateFile === null) return;
    try {
      const saved: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
      if (!Array.isArray(saved)) throw new Error("Invalid report cache");
      for (const entry of saved) {
        if (typeof entry?.id !== "string" || typeof entry?.updatedAt !== "string") continue;
        const report = entry.report === null ? null : CrewReportSchema.safeParse(entry.report);
        if (report === null || report.success) {
          this.reports.set(entry.id, { updatedAt: entry.updatedAt, report: report === null ? null : report.data });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[firstmate] could not restore report cache");
    }
  }

  /** Returns the last known line (null means unknown), and schedules a stale read. */
  reportFor(paseo: PaseoApi, agent: PaseoAgent): CrewReportSummary | null {
    const cached = this.reports.get(agent.id);
    if (agent.status !== "running" && agent.status !== "initializing" && cached?.updatedAt !== agent.updatedAt) {
      this.refresh(paseo, agent);
    }
    return cached?.report ?? null;
  }

  private refresh(paseo: PaseoApi, agent: PaseoAgent): void {
    if (this.stopped || this.pending.has(agent.id) || (this.retryAfter.get(agent.id) ?? 0) > Date.now()) return;
    const job = { paseo, agent, previous: this.reports.get(agent.id), expired: false };
    this.pending.set(agent.id, job);
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.active < REPORT_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.expired) {
        this.pending.delete(job.agent.id);
        continue;
      }
      this.active += 1;
      const deadline = setTimeout(() => {
        job.expired = true;
        this.retryAfter.set(job.agent.id, Date.now() + REPORT_DEADLINE_MS);
      }, REPORT_DEADLINE_MS);
      deadline.unref?.();
      // The SDK has no cancellation argument. Keep the physical slot until the
      // host settles, even after the logical deadline, to bound actual RPCs.
      void Promise.resolve().then(() => job.paseo.agents.ref(job.agent.id).timeline.refetch({
        direction: "tail", limit: 30, projection: "projected",
      })).then((page) => {
        if (job.expired || this.stopped || this.reports.get(job.agent.id) !== job.previous) return;
        this.reports.set(job.agent.id, {
          updatedAt: job.agent.updatedAt,
          report: parseCrewReport(closingText(page.entries.map((entry) => entry.item))),
        });
        this.persist();
      }).catch(() => {
        this.retryAfter.set(job.agent.id, Date.now() + REPORT_DEADLINE_MS);
      }).finally(() => {
        clearTimeout(deadline);
        this.active -= 1;
        this.pending.delete(job.agent.id);
        this.pump();
      });
    }
  }

  /** Hook timelines already contain the reply; do not issue another RPC. */
  turnEnded(event: PluginLifecycleEvents["agent.turn_ended"]): void {
    if (this.stopped) return;
    const report = parseCrewReport(closingText(event.timeline));
    if (report === null && !this.reports.has(event.agent.id) && !this.pending.has(event.agent.id)) return;
    // Hooks have no updatedAt. The next poll can reconcile, while object identity
    // keeps an older in-flight read from overwriting this event's report.
    this.reports.set(event.agent.id, { updatedAt: "", report });
    this.persist();
  }

  register(server: PluginLifecycleRegistration): void {
    this.offs.push(server.on("agent.turn_ended", (event) => this.turnEnded(event)));
    const closed = (event: { agent: { id: string } }) => {
      const job = this.pending.get(event.agent.id);
      if (job !== undefined) job.expired = true;
      const cached = this.reports.get(event.agent.id);
      if (cached !== undefined) {
        this.reports.set(event.agent.id, { ...cached, updatedAt: "" });
        this.persist();
      }
      // The next board poll refreshes closed agents through the same bounded queue.
    };
    try {
      // Feature probe: 0.9/0.10 reject unknown event names synchronously.
      const on = server.on as unknown as (name: string, handler: typeof closed) => () => void;
      this.offs.push(on("agent.closed", closed));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Unknown lifecycle event: agent.closed") throw error;
      // turn_ended and polling remain available on the supported 0.9 baseline.
    }
  }

  retain(ids: ReadonlySet<string>): void {
    let changed = false;
    for (const id of this.reports.keys()) {
      if (!ids.has(id)) { this.reports.delete(id); changed = true; }
    }
    for (const [id, job] of this.pending) {
      if (!ids.has(id)) job.expired = true;
    }
    for (const id of this.retryAfter.keys()) if (!ids.has(id)) this.retryAfter.delete(id);
    if (changed) this.persist();
  }

  private persist(): void {
    if (this.stateFile === null) return;
    const stateFile = this.stateFile;
    const snapshot = JSON.stringify([...this.reports].map(([id, value]) => ({ id, ...value })));
    this.writes = serialized(stateFile, async () => {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(`${stateFile}.tmp`, snapshot, "utf8");
      await rename(`${stateFile}.tmp`, stateFile);
    }).catch(() => console.warn("[firstmate] could not persist report cache"));
  }

  /** Wait for disk writes only; never wait for daemon reads. */
  flush(): Promise<void> { return this.writes; }

  stop(): void {
    this.stopped = true;
    this.offs.splice(0).forEach((off) => off());
    for (const job of this.pending.values()) job.expired = true;
    this.queue.length = 0;
  }
}

export function registerReportCache(server: PluginLifecycleRegistration): ReportCache {
  const cache = new ReportCache(join(pluginDir(), "crew-reports.json"));
  cache.register(server);
  return cache;
}
