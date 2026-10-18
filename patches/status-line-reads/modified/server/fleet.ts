/**
 * The board, assembled on the daemon: the first mate, every crewmate Paseo
 * knows by its labels, the backlog the first mate keeps, and each crewmate's
 * last status line — joined into cards and filed into columns.
 *
 * Status lines are persistent snapshots, refreshed in the background through
 * a bounded queue. Timeline reads never delay this board response.
 */
import { realpath } from "node:fs/promises";

import {
  CREW_LABELS,
  type AgentSummary,
  type BacklogItem,
  type ColumnId,
  type CrewReportSummary,
  type FirstmateConfig,
  type Fleet,
  type FleetCard,
  type WatchSummary,
} from "../shared/fleet";
import { resolveHome } from "./config";
import { reportUrl } from "./crew-report";
import { ReportCache } from "./report-cache";
import { readCharterState } from "./charter-file";
import { isHomeReady, readBacklog, readProjects, readSuggestions } from "./home";
import type { AgentListOptions, PaseoAgent, PaseoApi } from "./host-types";

export { ReportCache, closingText } from "./report-cache";

const PAGE_SIZE = 200;

export function summarizeAgent(agent: PaseoAgent): AgentSummary {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title,
    provider: agent.provider,
    model: agent.model,
    status: agent.status,
    cwd: agent.cwd,
    pendingPermissions: agent.pendingPermissions.length,
    requiresAttention: agent.requiresAttention === true,
    lastError: agent.lastError ?? null,
    updatedAt: agent.updatedAt,
    labels: agent.labels,
  };
}

/** Every agent matching `filter`, across pages, archived ones excluded. */
export async function listAgents(
  paseo: PaseoApi,
  filter: NonNullable<AgentListOptions["filter"]> = {},
): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      filter,
      page: cursor === undefined ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor },
    });
    agents.push(...page.entries.map((entry) => entry.agent));
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return agents.filter((agent) => agent.archivedAt === null || agent.archivedAt === undefined);
}

/**
 * The first mate: the agent the config names, while Paseo still has it.
 *
 * The config is the only source. The agent also carries a `firstmate.role`
 * label, but that is for people (`paseo ls --label firstmate.role=first-mate`)
 * and is not consulted here: the SDK cannot take a label off, so falling back
 * to it would bring a released first mate straight back.
 */
export async function resolveMate(
  paseo: PaseoApi,
  config: FirstmateConfig,
): Promise<{ agent: PaseoAgent | null; missing: boolean }> {
  const configured = config.mateAgentId.trim();
  if (configured === "") return { agent: null, missing: false };
  const agent = await fetchLiveAgent(paseo, configured);
  return agent === null ? { agent: null, missing: true } : { agent, missing: false };
}

/**
 * One agent, or null when Paseo no longer has it or has archived it. The
 * daemon answers an unknown id with an error ("Agent not found: …") rather
 * than an empty result, so that error is the null; anything else — the
 * daemon unreachable, a timeout — is thrown, because "your first mate is
 * gone" is the wrong thing to say about a hiccup.
 */
export async function fetchLiveAgent(paseo: PaseoApi, agentId: string): Promise<PaseoAgent | null> {
  let found: Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>;
  try {
    found = await paseo.agents.ref(agentId).refresh();
  } catch (error) {
    if (error instanceof Error && /not found|unknown agent|no agent/i.test(error.message)) return null;
    throw error;
  }
  const agent = found?.agent ?? null;
  if (agent === null || (agent.archivedAt !== null && agent.archivedAt !== undefined)) return null;
  return agent;
}

/**
 * Where a crewmate belongs. What Paseo knows wins while the agent is busy or
 * stuck — a pending permission, an error, a turn in flight — and the status
 * line decides once its turn has ended. A live crewmate is never Done, even
 * after `done:` or `resolved:`: the task has landed only once the backlog says
 * so, and until then the first mate still has work to do with it.
 */
export function crewColumn(agent: AgentSummary, report: CrewReportSummary | null): ColumnId {
  if (agent.pendingPermissions > 0) return "blocked";
  if (agent.status === "error") return "failed";
  if (agent.status === "running" || agent.status === "initializing") return "working";
  switch (report?.state) {
    case "failed":
      return "failed";
    case "blocked":
    case "needs-decision":
      return "blocked";
    case "paused":
      return "parked";
    default:
      // Finished and waiting on the first mate, stopped without saying why,
      // or said "working" and then stopped.
      return "idle";
  }
}

/** Where a backlog item with no crewmate on it belongs. */
export function backlogColumn(item: BacklogItem): ColumnId {
  if (item.section === "done") return "done";
  if (item.section === "in-flight") return "idle";
  if (item.kind === "captain" || item.hold !== null) return "blocked";
  return "queued";
}

export interface CrewMember {
  agent: AgentSummary;
  report: CrewReportSummary | null;
}

/**
 * Crewmates and backlog items joined into cards. A crewmate is matched to its
 * item by the task label, or by the agent id the item recorded; whatever is
 * left over on either side is a card of its own.
 */
export function buildCards(backlog: readonly BacklogItem[], crew: readonly CrewMember[]): FleetCard[] {
  const cards: FleetCard[] = [];
  const claimed = new Set<number>();

  const byUpdate = [...crew].sort((a, b) => b.agent.updatedAt.localeCompare(a.agent.updatedAt));
  for (const member of byUpdate) {
    const taskId = member.agent.labels[CREW_LABELS.task] ?? null;
    const index = backlog.findIndex(
      (item, position) =>
        !claimed.has(position) &&
        item.section !== "done" &&
        ((taskId !== null && item.id === taskId) || item.agentId === member.agent.id),
    );
    const item = index === -1 ? null : (backlog[index] ?? null);
    if (index !== -1) claimed.add(index);
    cards.push({
      key: `agent:${member.agent.id}`,
      column: crewColumn(member.agent, member.report),
      taskId: taskId ?? item?.id ?? null,
      title: item?.title ?? member.agent.title ?? taskId ?? "Untitled crewmate",
      project: member.agent.labels[CREW_LABELS.project] ?? item?.project ?? null,
      kind: member.agent.labels[CREW_LABELS.kind] ?? item?.kind ?? null,
      backlog: item,
      agent: member.agent,
      report: member.report,
      url: (member.report === null ? null : reportUrl(member.report.text)) ?? item?.url ?? null,
    });
  }

  backlog.forEach((item, index) => {
    if (claimed.has(index)) return;
    cards.push({
      key: `backlog:${item.section}:${item.id}:${index}`,
      column: backlogColumn(item),
      taskId: item.id,
      title: item.title,
      project: item.project,
      kind: item.kind,
      backlog: item,
      agent: null,
      report: null,
      url: item.url,
    });
  });
  return cards;
}

/** Whether two paths name one directory, through symlinks; a path that does not resolve is compared as written. */
export async function sameDirectory(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return left === right;
}

/**
 * Whether agents get Paseo's own tools. Without them the first mate can talk
 * but cannot start a crewmate or hear from one, so the board says so up front.
 */
export async function readAgentTools(paseo: PaseoApi): Promise<boolean | null> {
  try {
    const { config } = await paseo.config.get();
    return config.mcp.injectIntoAgents === true;
  } catch (error) {
    console.error("[firstmate] could not read the daemon config:", error);
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadFleet(
  paseo: PaseoApi,
  config: FirstmateConfig,
  reports: ReportCache,
  watchSummaries: () => Promise<WatchSummary[]> = async () => [],
): Promise<Fleet> {
  const home = resolveHome(config);
  const warnings: string[] = [];
  let crewListed = true;

  const [homeReady, backlog, projects, suggestions, mate, crewAgents, agentTools, charter, watches] = await Promise.all([
    isHomeReady(home),
    readBacklog(home).catch((error: unknown) => {
      warnings.push(`The backlog could not be read: ${describe(error)}`);
      return [];
    }),
    readProjects(home).catch((error: unknown) => {
      warnings.push(`The project registry could not be read: ${describe(error)}`);
      return [];
    }),
    readSuggestions(home).catch((error: unknown) => {
      warnings.push(`The suggestions could not be read: ${describe(error)}`);
      return [];
    }),
    resolveMate(paseo, config),
    listAgents(paseo, { labels: { [CREW_LABELS.role]: CREW_LABELS.crewRole } }).catch((error: unknown) => {
      crewListed = false;
      warnings.push(`Paseo could not list the crew: ${describe(error)}`);
      return [];
    }),
    readAgentTools(paseo),
    readCharterState(home).catch((error: unknown) => {
      warnings.push(`The charter could not be read: ${describe(error)}`);
      return null;
    }),
    watchSummaries().catch((error: unknown) => {
      warnings.push(`The watches could not be read: ${describe(error)}`);
      return [];
    }),
  ]);

  if (crewListed) reports.retain(new Set(crewAgents.map((agent) => agent.id)));
  const crew = crewAgents.map((agent) => ({
    agent: summarizeAgent(agent),
    report: reports.reportFor(paseo, agent),
  }));

  return {
    home,
    homeReady,
    mate: mate.agent === null ? null : summarizeAgent(mate.agent),
    mateMissing: mate.missing,
    mateInHome: mate.agent === null ? true : await sameDirectory(mate.agent.cwd, home),
    cards: buildCards(backlog, crew),
    projects,
    suggestions,
    watches,
    agentTools,
    // A home nobody has launched in has no charter of the captain's to be out of date.
    charterOutdated: homeReady && charter !== null && charter.outdated,
    warnings,
  };
}
