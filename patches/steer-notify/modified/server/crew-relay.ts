/**
 * Relays a crewmate's finish, error, permission request or close to the current first mate when
 * Paseo's own note about it went nowhere.
 *
 * Paseo tells a crewmate's news only to the agent that created or prompted it
 * (`setupFinishNotification` in Paseo's agent-prompt module), and says nothing when that agent is
 * archived. So after a Restart — which archives the first mate and starts another — every crewmate the
 * old one started finishes silently, and the new one hears of it only at its next heartbeat. This
 * module fills that gap from the plugin's lifecycle hooks, with no model turn spent on looking:
 *
 * - **What is relayed.** An event of an agent labelled `firstmate.role=crew` whose creator (Paseo's
 *   `paseo.parent-agent-id` label) is gone or archived: a completed turn ("finished"), a failed one
 *   ("errored"), a permission request ("needs permission"), or its archiving ("was closed") when the
 *   plugin saw it finish before. A crewmate whose creator is still live — the current first mate above
 *   all — is Paseo's to tell, and is left alone; so are canceled turns, agents without the crew label,
 *   and the first mate's own events.
 * - **Crewmates the captain steered.** A steer from the board is not a prompt from the first mate, so
 *   Paseo arms no note for it, and a plugin cannot arm one. `touch` records the crewmate in `touched`,
 *   saved with the queue; from then on its events are relayed as an orphan's are, whoever created it,
 *   until it is archived.
 * - **Not twice.** Each event has a key — the turn's id and the length of the timeline it ended with, a
 *   permission's request id — kept in `crew-relay.json` in the plugin's data folder with the queue, so
 *   a plugin reload neither loses a note nor sends one again. A note is taken off the queue and saved
 *   before it is sent: a crash in between loses it rather than repeating it, and the heartbeat is the
 *   backstop.
 * - **Not what Paseo already said.** When the current first mate prompted the crewmate itself
 *   (`send_agent_prompt`), Paseo armed its own note for it. Just before sending, the first mate's
 *   timeline is read back to the crewmate's previous finish, and a note it would duplicate is dropped.
 * - **Never a flood.** Notes wait while the first mate is mid-turn or missing, as watch output does; a
 *   burst is gathered for a few seconds and sent as one message; a crewmate that ends several turns
 *   while its note waits is relayed once, with the latest; messages are at least `MIN_GAP_MS` apart and
 *   at most `MAX_PER_HOUR` an hour; the queue holds `MAX_QUEUED`, the oldest dropped and counted.
 *
 * Paseo's events are live only — none are replayed after a reload — so an event that lands while the
 * plugin is down is not seen; the first mate's heartbeat still covers those.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PluginLifecycleEvents, PluginLifecycleRegistration } from "@getpaseo/plugin/server";

import { CREW_LABELS, type FirstmateConfig } from "../shared/fleet";
import { pluginDir } from "./data-dir";
import { closingText, resolveMate } from "./fleet";
import type { PaseoApi, TimelineItem } from "./host-types";
import { isMidTurn } from "./mate";
import { sendWithoutInterrupting } from "./send";
import { serialized } from "./serialize";
import { TEMPLATES, message } from "./templates";
import { AFTER_TURN_DELAYS_MS, quoted } from "./watches";

/** The label Paseo puts on an agent created through its MCP tools, naming the agent that created it. */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
/** How a relay message is told apart in the first mate's timeline; the daemon keeps it as `clientMessageId`. */
export const CREW_RELAY_MESSAGE_ID_PREFIX = "firstmate-crew-";

/** The most of a crewmate's last message relayed; the same cap Paseo's own note uses. */
export const MAX_RESPONSE_CHARS = 4000;
/** Notes waiting for the first mate; past this the oldest go, counted in the next message. */
export const MAX_QUEUED = 20;
/** The most one message may hold. Past it the rest wait for the next message rather than go. */
export const MAX_MESSAGE_CHARS = 32000;
/** How long a first note waits for others in the same burst. */
export const COALESCE_MS = 5000;
/** The least time between two relay messages. */
export const MIN_GAP_MS = 30_000;
/** The most relay messages in any hour. */
export const MAX_PER_HOUR = 20;
/** How often a waiting queue is tried while the first mate is busy or missing. */
export const RETRY_MS = 60_000;
/** How long an event key is remembered, and how many at most. */
export const HANDLED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_HANDLED = 2000;
/** The most crewmates whose last finish is remembered. */
export const MAX_FINISHED = 500;
/** How far back the first mate's timeline is read for its own prompts: pages of this many, at most this many pages. */
const MATE_TIMELINE_PAGE = 200;
const MATE_TIMELINE_PAGES = 5;
const HOUR_MS = 60 * 60 * 1000;

export type RelayEvent = "finished" | "errored" | "needs permission" | "was closed";

/** One crewmate event waiting to be told to the first mate. */
export interface RelayNote {
  key: string;
  agentId: string;
  title: string;
  event: RelayEvent;
  /** The agent that created the crewmate, gone when the note was queued. */
  creatorId: string;
  /** When the plugin saw the event (ISO). */
  at: string;
  /** The crewmate's previous finish the plugin saw (ISO), or null: where a prompt from the first mate would have armed Paseo's own note. */
  since: string | null;
  /** The text the turn closed with. */
  response?: string;
  /** For "errored": what went wrong. */
  error?: string;
  /** For "needs permission": the request's id, and the request as Paseo gives it. */
  requestId?: string;
  request?: unknown;
  /** Earlier turns of the same crewmate folded into this note while it waited. */
  earlier?: number;
  /** Relayed because the captain steered the crewmate, not because its creator is gone. */
  steered?: true;
}

export interface RelayState {
  /** Every event key queued, sent or skipped, with when; so none is relayed twice. */
  handled: Record<string, string>;
  queue: RelayNote[];
  /** Notes dropped from a full queue since the last message. */
  dropped: number;
  /** Each crewmate's last finish the plugin saw (ISO). */
  finished: Record<string, string>;
  /** When recent relay messages went (ISO), for the rate limit. */
  sent: string[];
  /** Crewmates the captain steered from the board, with when it last did (ISO). */
  touched: Record<string, string>;
}

export function emptyState(): RelayState {
  return { handled: {}, queue: [], dropped: 0, finished: {}, sent: [], touched: {} };
}

export interface RelayStore {
  load(): Promise<RelayState>;
  save(state: RelayState): Promise<void>;
}

/** What the relay needs to know of a crewmate. */
export interface CrewFacts {
  labels: Readonly<Record<string, string>>;
  archived: boolean;
  pendingPermissionIds: readonly string[];
}

/** One Paseo tool call the first mate made about a crewmate. */
export interface MateAction {
  tool: "send_agent_prompt" | "archive_agent";
  agentId: string;
  /** When it was made (ms). */
  at: number;
  /** For a prompt: whether it asked Paseo to notify (the default). */
  notify: boolean;
}

/** Paseo, as far as the relay uses it; `paseoRelayHost` is the real one. */
export interface RelayHost {
  /** The first mate the config names, '' when none. */
  configuredMateId(): Promise<string>;
  /** The live first mate, and whether it is mid-turn; null when there is none. */
  liveMate(): Promise<{ id: string; busy: boolean } | null>;
  /** The agent, archived or not; null when Paseo has no such agent. */
  crewFacts(agentId: string): Promise<CrewFacts | null>;
  /** Whether the agent exists and is not archived. */
  isLive(agentId: string): Promise<boolean>;
  /** The first mate's Paseo tool calls about crewmates, reaching back at least to `since` when the timeline has it. */
  mateActions(mateId: string, since: number | null): Promise<MateAction[]>;
  send(mateId: string, text: string): Promise<void>;
}

/** The hook agent, as the relay reads it. */
type HookAgent = PluginLifecycleEvents["agent.turn_ended"]["agent"];

// ---------------------------------------------------------------------------
// Decisions, free of Paseo and the clock
// ---------------------------------------------------------------------------

/** What a turn's end is to the relay, or null when it is nothing to tell: a canceled turn is the one a steer or a stop replaced. */
export function turnEvent(outcome: PluginLifecycleEvents["agent.turn_ended"]["outcome"]): RelayEvent | null {
  if (outcome.kind === "completed") return "finished";
  if (outcome.kind === "failed") return "errored";
  return null;
}

/**
 * A turn's key. Paseo's turn id can repeat once a session reopens, so the length of the timeline the
 * turn ended with — the whole conversation, which only grows — goes with it.
 */
export function turnKey(agentId: string, turnId: string | null, timelineLength: number): string {
  return `turn:${agentId}:${turnId ?? "-"}:${timelineLength}`;
}

export function permissionKey(agentId: string, requestId: string): string {
  return `permission:${agentId}:${requestId}`;
}

export function closedKey(agentId: string): string {
  return `closed:${agentId}`;
}

/** Whether the agent is a crewmate at all: the crew label, and not the first mate itself. */
export function isCrew(agentId: string, labels: Readonly<Record<string, string>>, mateId: string): boolean {
  return agentId !== mateId && labels[CREW_LABELS.role] === CREW_LABELS.crewRole;
}

/** Paseo's tool names as the providers report them: `mcp__paseo__send_agent_prompt`, `paseo.send_agent_prompt`, or bare. */
const MATE_TOOLS = /(?:^|[._:/]|__)(send_agent_prompt|archive_agent)$/;

function inputOf(detail: unknown): Record<string, unknown> | null {
  if (typeof detail !== "object" || detail === null) return null;
  let input = (detail as { input?: unknown }).input;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : null;
}

/** The first mate's Paseo tool calls in timeline entries, with when each was made. A call that failed armed nothing. */
export function mateActionsIn(entries: ReadonlyArray<{ item: TimelineItem; timestamp: string }>): MateAction[] {
  const actions: MateAction[] = [];
  for (const entry of entries) {
    const item = entry.item;
    if (item.type !== "tool_call" || item.status === "failed") continue;
    const tool = MATE_TOOLS.exec(item.name)?.[1] as MateAction["tool"] | undefined;
    if (tool === undefined) continue;
    const input = inputOf(item.detail);
    const agentId = input?.agentId;
    if (typeof agentId !== "string" || agentId === "") continue;
    const at = Date.parse(entry.timestamp);
    actions.push({ tool, agentId, at: Number.isNaN(at) ? 0 : at, notify: input?.notifyOnFinish !== false });
  }
  return actions;
}

/**
 * Whether Paseo told the first mate this itself: it prompted the crewmate with a notification between
 * the crewmate's previous finish and this event (Paseo arms one note per prompt, for the next finish,
 * error, close or permission request), or, for a close, archived the crewmate itself.
 */
export function toldByPaseo(note: RelayNote, actions: readonly MateAction[]): boolean {
  const since = note.since === null ? Number.NEGATIVE_INFINITY : Date.parse(note.since);
  const until = Date.parse(note.at);
  return actions.some((action) => {
    if (action.agentId !== note.agentId) return false;
    if (note.event === "was closed" && action.tool === "archive_agent") return true;
    return action.tool === "send_agent_prompt" && action.notify && action.at > since && action.at <= until;
  });
}

/** How long the rate limit holds the next message back, from `now`; 0 when it may go. */
export function rateLimitWait(sent: readonly string[], now: number): number {
  const times = sent.map((at) => Date.parse(at)).filter((at) => !Number.isNaN(at) && at > now - HOUR_MS);
  if (times.length === 0) return 0;
  const gap = Math.max(...times) + MIN_GAP_MS - now;
  const hourly = times.length >= MAX_PER_HOUR ? Math.min(...times) + HOUR_MS - now : 0;
  return Math.max(0, gap, hourly);
}

/**
 * Adds a note to the queue. A finish, error or close replaces a note of that kind still waiting for the
 * same crewmate — its latest status line is the one that matters — and counts the one it replaced; past
 * `MAX_QUEUED` the oldest go.
 */
export function enqueue(state: RelayState, note: RelayNote): void {
  if (note.event !== "needs permission") {
    const index = state.queue.findIndex((queued) => queued.agentId === note.agentId && queued.event !== "needs permission");
    if (index !== -1) {
      const replaced = state.queue.splice(index, 1)[0];
      note = { ...note, since: replaced?.since ?? note.since, earlier: (replaced?.earlier ?? 0) + 1 };
    }
  }
  state.queue.push(note);
  while (state.queue.length > MAX_QUEUED) {
    state.queue.shift();
    state.dropped += 1;
  }
}

/** Forgets keys past their time, and the oldest past `MAX_HANDLED`; the same for crewmates' finishes and sends. */
export function prune(state: RelayState, now: number): void {
  const keep = (entries: Record<string, string>, ttl: number, max: number) =>
    Object.fromEntries(
      Object.entries(entries)
        .filter(([, at]) => Date.parse(at) > now - ttl)
        .sort(([, a], [, b]) => b.localeCompare(a))
        .slice(0, max),
    );
  state.handled = keep(state.handled, HANDLED_TTL_MS, MAX_HANDLED);
  state.finished = keep(state.finished, HANDLED_TTL_MS, MAX_FINISHED);
  state.touched = keep(state.touched, HANDLED_TTL_MS, MAX_FINISHED);
  state.sent = state.sent.filter((at) => Date.parse(at) > now - HOUR_MS);
}

function clipResponse(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_RESPONSE_CHARS) return trimmed;
  const omitted = trimmed.length - MAX_RESPONSE_CHARS;
  return `${trimmed.slice(0, MAX_RESPONSE_CHARS)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
}

/**
 * One note as its block (`templates/messages/crew-relay*.md`), in Paseo's own words. What the crewmate
 * wrote cannot open or close a tag the first mate trusts: it is escaped as watch output is.
 */
export async function relayBlock(note: RelayNote): Promise<string> {
  const sections: string[] = [];
  if (note.event === "needs permission" && note.requestId !== undefined) {
    const request = JSON.stringify({ agentId: note.agentId, requestId: note.requestId, request: note.request ?? null }, null, 2);
    sections.push(await message(TEMPLATES.crewRelayPermission, { request: quoted(request) }));
  }
  if (note.error !== undefined && note.error.trim() !== "") {
    sections.push(`<agent-error>\n${quoted(note.error.trim())}\n</agent-error>`);
  }
  if (note.response !== undefined && note.response.trim() !== "") {
    sections.push(`<agent-response>\n${quoted(clipResponse(note.response))}\n</agent-response>`);
  }
  if ((note.earlier ?? 0) > 0) {
    sections.push(await message(TEMPLATES.crewRelayEarlier, { count: String(note.earlier) }));
  }
  return message(note.steered ? TEMPLATES.crewRelaySteered : TEMPLATES.crewRelay, {
    agentId: note.agentId,
    // The title sits in Paseo's first line; a newline in it would break the line the chat shows.
    title: quoted(note.title.replace(/\s+/g, " ").trim()),
    event: note.event,
    creator: note.creatorId,
    sections: sections.map((section) => `\n\n${section}`).join(""),
  });
}

/**
 * The message for the queue within `max` characters: the oldest notes first, as many as fit — always
 * at least one — and the rest left for the next message. A count of dropped notes goes first.
 */
export async function fitRelayMessage(
  notes: readonly RelayNote[],
  dropped: number,
  max: number = MAX_MESSAGE_CHARS,
): Promise<{ text: string; sent: RelayNote[] }> {
  const parts = dropped > 0 ? [await message(TEMPLATES.crewRelayDropped, { count: String(dropped) })] : [];
  const sent: RelayNote[] = [];
  let length = parts.join("\n\n").length;
  for (const note of notes) {
    const block = await relayBlock(note);
    const added = (parts.length > 0 ? 2 : 0) + block.length;
    if (sent.length > 0 && length + added > max) break;
    parts.push(block);
    sent.push(note);
    length += added;
  }
  return { text: parts.join("\n\n"), sent };
}

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

export interface CrewRelayOptions {
  host: RelayHost;
  store: RelayStore;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class CrewRelay {
  private state: RelayState | null = null;
  private loading: Promise<RelayState> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private timer: { handle: unknown; at: number } | null = null;
  private readonly afterTurn = new Set<unknown>();
  private stopped = false;
  private readonly host: RelayHost;
  private readonly store: RelayStore;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(options: CrewRelayOptions) {
    this.host = options.host;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  /**
   * The creator of a crewmate whose news is the relay's, and whether that is because the captain
   * steered it; null when the event is not the relay's: not a crewmate, the first mate itself, or —
   * for a crewmate the captain has not steered — no creator on record, or a creator Paseo will tell,
   * one that is still live.
   */
  private async relayed(agent: HookAgent): Promise<{ creatorId: string; steered: boolean } | null> {
    const creatorId = agent.parentAgentId?.trim() ?? "";
    const touched = (await this.load()).touched[agent.id] !== undefined;
    if (creatorId === "" && !touched) return null;
    const mateId = await this.host.configuredMateId();
    if (agent.id === mateId) return null;
    const facts = await this.host.crewFacts(agent.id);
    if (facts === null || !isCrew(agent.id, facts.labels, mateId)) return null;
    if (creatorId !== "" && !(await this.host.isLive(creatorId))) return { creatorId, steered: false };
    return touched ? { creatorId, steered: true } : null;
  }

  /**
   * The captain steered the crewmate from the board: relay its news from now on. Saved before the
   * steer is sent, so a turn that ends at once is still covered and a reload forgets nothing.
   */
  async touch(agentId: string): Promise<void> {
    const state = await this.load();
    const now = this.now();
    state.touched[agentId] = new Date(now).toISOString();
    prune(state, now);
    await this.persist();
  }

  async onTurnEnded(event: PluginLifecycleEvents["agent.turn_ended"]): Promise<void> {
    const kind = turnEvent(event.outcome);
    if (kind === null) return;
    const key = turnKey(event.agent.id, event.turnId, event.timeline.length);
    if ((await this.load()).handled[key] !== undefined) return;
    const relayed = await this.relayed(event.agent);
    if (relayed === null) return;
    const response = closingText(event.timeline);
    await this.add(event.agent, relayed, key, kind, {
      ...(response === null ? {} : { response }),
      ...(event.outcome.kind === "failed" ? { error: event.outcome.error.message } : {}),
    });
  }

  async onPermissionRequested(event: PluginLifecycleEvents["agent.permission_requested"]): Promise<void> {
    const key = permissionKey(event.agent.id, event.request.id);
    if ((await this.load()).handled[key] !== undefined) return;
    const relayed = await this.relayed(event.agent);
    if (relayed === null) return;
    await this.add(event.agent, relayed, key, "needs permission", {
      requestId: event.request.id,
      request: event.request,
    });
  }

  /** A request answered or cleared before its note went is not sent. */
  async onPermissionResolved(event: PluginLifecycleEvents["agent.permission_resolved"]): Promise<void> {
    const state = await this.load();
    const before = state.queue.length;
    state.queue = state.queue.filter(
      (note) => !(note.agentId === event.agent.id && note.event === "needs permission" && note.requestId === event.requestId),
    );
    if (state.queue.length !== before) await this.persist();
  }

  /** Only a crewmate the plugin saw finish: an archived one it knows nothing of is not dug up. */
  async onArchived(event: PluginLifecycleEvents["agent.archived"]): Promise<void> {
    const state = await this.load();
    const key = closedKey(event.agent.id);
    const relayed =
      state.handled[key] !== undefined || state.finished[event.agent.id] === undefined ? null : await this.relayed(event.agent);
    if (relayed !== null) {
      // A permission the crewmate was waiting on cannot be answered any more.
      state.queue = state.queue.filter((note) => !(note.agentId === event.agent.id && note.event === "needs permission"));
      await this.add(event.agent, relayed, key, "was closed", {});
    }
    if (state.touched[event.agent.id] !== undefined) {
      delete state.touched[event.agent.id];
      await this.persist();
    }
  }

  private async add(
    agent: HookAgent,
    relayed: { creatorId: string; steered: boolean },
    key: string,
    kind: RelayEvent,
    extra: Partial<RelayNote>,
  ): Promise<void> {
    const state = await this.load();
    // Checked again: another event for the same key may have landed while this one asked Paseo.
    if (state.handled[key] !== undefined) return;
    const now = this.now();
    const at = new Date(now).toISOString();
    // For a steered crewmate, a prompt from the first mate before the steer armed nothing still waiting.
    const finished = state.finished[agent.id] ?? null;
    const touched = relayed.steered ? (state.touched[agent.id] ?? null) : null;
    const since = finished === null || (touched !== null && touched > finished) ? touched : finished;
    const note: RelayNote = {
      key,
      agentId: agent.id,
      title: agent.title ?? agent.id,
      event: kind,
      creatorId: relayed.creatorId,
      at,
      since,
      ...(relayed.steered ? { steered: true as const } : {}),
      ...extra,
    };
    state.handled[key] = at;
    if (kind !== "needs permission") state.finished[agent.id] = at;
    enqueue(state, note);
    prune(state, now);
    await this.persist();
    this.wake(COALESCE_MS);
  }

  /** The first mate ended a turn: try the queue over the next seconds, as the watches do. */
  mateTurnEnded(delays: readonly number[] = AFTER_TURN_DELAYS_MS): void {
    if (this.stopped) return;
    for (const delay of delays) {
      const handle = this.setTimer(() => {
        this.afterTurn.delete(handle);
        void this.flush().catch((error: unknown) => console.error("[firstmate] crew relay flush failed:", error));
      }, delay);
      this.afterTurn.add(handle);
    }
  }

  /** Makes sure a waiting queue is tried within `ms`. A sooner try already set stands. */
  wake(ms: number): void {
    if (this.stopped) return;
    const at = this.now() + ms;
    if (this.timer !== null && this.timer.at <= at) return;
    if (this.timer !== null) this.clearTimer(this.timer.handle);
    const handle = this.setTimer(() => {
      if (this.timer?.handle === handle) this.timer = null;
      void this.flush().catch((error: unknown) => console.error("[firstmate] crew relay flush failed:", error));
    }, ms);
    this.timer = { handle, at };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer.handle);
    this.timer = null;
    this.afterTurn.forEach((handle) => this.clearTimer(handle));
    this.afterTurn.clear();
  }

  /** Sends what is queued, if the first mate can take it. One flush at a time. */
  flush(): Promise<void> {
    const run = this.flushing.then(() => this.flushOnce());
    this.flushing = run.catch(() => undefined);
    return run;
  }

  /** Called at start: a queue a previous run left gets tried. */
  async resume(): Promise<void> {
    const state = await this.load();
    if (state.queue.length > 0 || state.dropped > 0) this.wake(COALESCE_MS);
  }

  private async flushOnce(): Promise<void> {
    if (this.stopped) return;
    const state = await this.load();
    if (state.queue.length === 0 && state.dropped === 0) return;
    const now = this.now();
    const wait = rateLimitWait(state.sent, now);
    if (wait > 0) {
      this.wake(wait);
      return;
    }
    const mate = await this.host.liveMate();
    if (mate === null || mate.busy) {
      this.wake(RETRY_MS);
      return;
    }

    const earliest = state.queue.reduce<number | null>((min, note) => {
      if (note.since === null) return Number.NEGATIVE_INFINITY;
      const since = Date.parse(note.since);
      return min === null ? since : Math.min(min, since);
    }, null);
    let actions: MateAction[];
    try {
      actions = await this.host.mateActions(mate.id, earliest === Number.NEGATIVE_INFINITY ? null : earliest);
    } catch (error) {
      // Unsure what Paseo already told it: wait rather than risk saying it twice.
      console.error("[firstmate] crew relay could not read the first mate's timeline:", error);
      this.wake(RETRY_MS);
      return;
    }

    const waiting: RelayNote[] = [];
    for (const note of state.queue) {
      if ((!note.steered && note.creatorId === mate.id) || toldByPaseo(note, actions)) continue;
      if (note.event === "needs permission") {
        const facts = await this.host.crewFacts(note.agentId).catch(() => null);
        if (facts === null || facts.archived || !facts.pendingPermissionIds.includes(note.requestId ?? "")) continue;
      }
      waiting.push(note);
    }

    const { text, sent } = waiting.length === 0 && state.dropped === 0
      ? { text: "", sent: [] as RelayNote[] }
      : await fitRelayMessage(waiting, state.dropped);
    const dropped = state.dropped;
    // Off the queue and saved before the send: a crash loses a note rather than repeating it.
    state.queue = waiting.filter((note) => !sent.includes(note));
    if (text === "") {
      await this.persist();
      return;
    }
    state.dropped = 0;
    state.sent.push(new Date(now).toISOString());
    await this.persist();
    try {
      await this.host.send(mate.id, text);
    } catch (error) {
      console.error("[firstmate] crew relay could not send to the first mate:", error);
      state.queue = [...sent, ...state.queue];
      state.dropped += dropped;
      state.sent.pop();
      await this.persist();
      this.wake(RETRY_MS);
      return;
    }
    if (state.queue.length > 0) this.wake(Math.max(MIN_GAP_MS, rateLimitWait(state.sent, this.now())));
  }

  /** The saved state, for tests and the board. */
  snapshot(): Promise<RelayState> {
    return this.load();
  }

  private load(): Promise<RelayState> {
    if (this.state !== null) return Promise.resolve(this.state);
    this.loading ??= this.store.load().then((state) => {
      this.state = state;
      return state;
    });
    return this.loading;
  }

  private persist(): Promise<void> {
    const state = this.state;
    if (state === null) return Promise.resolve();
    return this.store.save(state).catch((error: unknown) => {
      console.error("[firstmate] could not save the crew relay's state:", error);
    });
  }
}

// ---------------------------------------------------------------------------
// The file, and Paseo
// ---------------------------------------------------------------------------

function strings(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const EVENTS: ReadonlySet<string> = new Set<RelayEvent>(["finished", "errored", "needs permission", "was closed"]);

function readNote(value: unknown): RelayNote[] {
  if (typeof value !== "object" || value === null) return [];
  const note = value as Record<string, unknown>;
  const text = (name: string) => (typeof note[name] === "string" ? (note[name] as string) : null);
  const [key, agentId, title, event, creatorId, at] = ["key", "agentId", "title", "event", "creatorId", "at"].map(text);
  if (key == null || agentId == null || title == null || event == null || creatorId == null || at == null) return [];
  if (!EVENTS.has(event)) return [];
  const optional = (name: string) => (text(name) === null ? {} : { [name]: text(name) as string });
  return [
    {
      key,
      agentId,
      title,
      event: event as RelayEvent,
      creatorId,
      at,
      since: text("since"),
      ...optional("response"),
      ...optional("error"),
      ...optional("requestId"),
      ...("request" in note ? { request: note.request } : {}),
      ...(typeof note.earlier === "number" && note.earlier > 0 ? { earlier: Math.floor(note.earlier) } : {}),
      ...(note.steered === true ? { steered: true as const } : {}),
    },
  ];
}

/** The saved state, leniently: anything it cannot read starts afresh rather than stopping the relay. */
export async function readRelayState(path: string): Promise<RelayState> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[firstmate] ${path} could not be read, starting afresh:`, error);
    }
    return emptyState();
  }
  const object = (raw ?? {}) as Record<string, unknown>;
  return {
    handled: strings(object.handled),
    queue: Array.isArray(object.queue) ? object.queue.flatMap(readNote) : [],
    dropped: typeof object.dropped === "number" && object.dropped > 0 ? Math.floor(object.dropped) : 0,
    finished: strings(object.finished),
    sent: Array.isArray(object.sent) ? object.sent.filter((at): at is string => typeof at === "string") : [],
    touched: strings(object.touched),
  };
}

/** `crew-relay.json`, written whole to a temporary file and renamed into place. */
export function fileStore(path: string): RelayStore {
  return {
    load: () => readRelayState(path),
    save: (state) =>
      serialized(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await rename(temporary, path);
      }),
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /not found|unknown agent|no agent/i.test(error.message);
}

/**
 * Paseo for the relay. The plugin's Paseo handle comes with every hook and RPC, not at start
 * (`watch-service.ts` says why), so `handle` returns the last one seen, or null until one has.
 */
export function paseoRelayHost(handle: () => PaseoApi | null, readConfig: () => Promise<FirstmateConfig>): RelayHost {
  const paseo = (): PaseoApi => {
    const current = handle();
    if (current === null) throw new Error("the plugin has no Paseo handle yet");
    return current;
  };
  return {
    async configuredMateId() {
      return (await readConfig()).mateAgentId.trim();
    },
    async liveMate() {
      if (handle() === null) return null;
      const { agent } = await resolveMate(paseo(), await readConfig());
      return agent === null ? null : { id: agent.id, busy: isMidTurn(agent) };
    },
    async crewFacts(agentId) {
      let found: Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>;
      try {
        found = await paseo().agents.ref(agentId).refresh();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const agent = found?.agent ?? null;
      if (agent === null) return null;
      return {
        labels: agent.labels,
        archived: agent.archivedAt !== null && agent.archivedAt !== undefined,
        pendingPermissionIds: agent.pendingPermissions.map((request) => request.id),
      };
    },
    async isLive(agentId) {
      let found: Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>;
      try {
        found = await paseo().agents.ref(agentId).refresh();
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
      const agent = found?.agent ?? null;
      return agent !== null && (agent.archivedAt === null || agent.archivedAt === undefined);
    },
    async mateActions(mateId, since) {
      const timeline = paseo().agents.ref(mateId).timeline;
      const entries: Array<{ item: TimelineItem; timestamp: string }> = [];
      let page = await timeline.refetch({ direction: "tail", limit: MATE_TIMELINE_PAGE, projection: "projected" });
      for (let pages = 1; ; pages += 1) {
        entries.unshift(...page.entries.map((entry) => ({ item: entry.item, timestamp: entry.timestamp })));
        const oldest = Date.parse(page.entries[0]?.timestamp ?? "");
        const reached = since !== null && !Number.isNaN(oldest) && oldest <= since;
        if (reached || !page.hasOlder || page.startCursor === null || pages >= MATE_TIMELINE_PAGES) break;
        page = await timeline.refetch({
          direction: "before",
          cursor: page.startCursor,
          limit: MATE_TIMELINE_PAGE,
          projection: "projected",
        });
      }
      return mateActionsIn(entries);
    },
    async send(mateId, text) {
      await sendWithoutInterrupting(paseo(), mateId, text, { messageId: `${CREW_RELAY_MESSAGE_ID_PREFIX}${randomUUID()}` });
    },
  };
}

/** Wires the relay to Paseo's hooks. Returns what stops it. */
export function registerCrewRelay(
  server: PluginLifecycleRegistration,
  readConfig: () => Promise<FirstmateConfig>,
  stateFile: string = join(pluginDir(), "crew-relay.json"),
): { relay: CrewRelay; remember: (paseo: PaseoApi) => void; stop: () => void } {
  let paseo: PaseoApi | null = null;
  const remember = (handle: PaseoApi) => {
    const first = paseo === null;
    paseo = handle;
    if (first) void relay.resume().catch((error: unknown) => console.error("[firstmate] crew relay could not resume:", error));
  };
  const relay = new CrewRelay({ host: paseoRelayHost(() => paseo, readConfig), store: fileStore(stateFile) });
  const guard =
    <E>(name: string, run: (event: E) => Promise<void>) =>
    async (event: E, context: { paseo: PaseoApi }) => {
      remember(context.paseo);
      try {
        await run(event);
      } catch (error) {
        console.error(`[firstmate] crew relay could not handle ${name}:`, error);
      }
    };
  const offs = [
    server.on("agent.turn_started", (_event, context) => remember(context.paseo)),
    server.on(
      "agent.turn_ended",
      guard<PluginLifecycleEvents["agent.turn_ended"]>("a turn's end", async (event) => {
        if (event.agent.id === (await readConfig()).mateAgentId.trim()) relay.mateTurnEnded();
        else await relay.onTurnEnded(event);
      }),
    ),
    server.on(
      "agent.permission_requested",
      guard<PluginLifecycleEvents["agent.permission_requested"]>("a permission request", (event) => relay.onPermissionRequested(event)),
    ),
    server.on(
      "agent.permission_resolved",
      guard<PluginLifecycleEvents["agent.permission_resolved"]>("a resolved permission", (event) => relay.onPermissionResolved(event)),
    ),
    server.on("agent.archived", guard<PluginLifecycleEvents["agent.archived"]>("an archive", (event) => relay.onArchived(event))),
  ];
  return {
    relay,
    remember,
    stop() {
      offs.forEach((off) => off());
      relay.stop();
    },
  };
}
