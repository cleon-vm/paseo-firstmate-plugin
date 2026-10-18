/**
 * What the captain can do to one crewmate from the board: steer it, interrupt
 * its turn, end it, or have the first mate relaunch it.
 *
 * None of these tears anything down. Ending a crewmate archives the agent and
 * leaves its workspace and worktree exactly as they are; relaunching is the
 * first mate's job, because it owns the brief and the backlog.
 *
 * Steering goes straight to the crewmate — the captain's words are
 * authoritative, as if typed into its tab — and the first mate is told what
 * was said at once. What the crewmate does after, the crew relay tells it
 * (`server/crew-relay.ts`): Paseo arms its own note only for the first mate's
 * prompts.
 */
import { CREW_LABELS, type FirstmateConfig } from "../shared/fleet";
import { stopAgent } from "./cli";
import { fetchLiveAgent, resolveMate } from "./fleet";
import type { PaseoAgent, PaseoApi } from "./host-types";
import { askMate } from "./mate";
import { sendWithoutInterrupting } from "./send";
import { TEMPLATES, message } from "./templates";
import { quoted } from "./watches";

/** The most of the captain's words relayed to the first mate; the same cap Paseo's own notification uses. */
const MAX_RELAYED_CHARS = 4000;
/** The most of the crewmate's title in that note. */
const MAX_TITLE_CHARS = 200;
/** The most the whole note can be: the template, a capped title, capped words, and the warning. */
export const MAX_STEER_NOTE_CHARS = 6000;

/** Refuses anything that is not a live crewmate, so the board cannot be pointed at an arbitrary agent. */
async function requireCrew(paseo: PaseoApi, agentId: string): Promise<PaseoAgent> {
  const agent = await fetchLiveAgent(paseo, agentId);
  if (agent === null) throw new Error(`Paseo has no live agent ${agentId}.`);
  if (agent.labels[CREW_LABELS.role] !== CREW_LABELS.crewRole) {
    throw new Error(`${agent.title ?? agentId} is not one of the crew.`);
  }
  return agent;
}

/**
 * The crewmate is marked as steered before the send, so a turn that ends the
 * instant the message lands is still relayed. The first mate is told once the
 * crewmate has the words; a failure to tell it does not fail the steer. A mark
 * that could not be saved still lets the steer go, but is logged and the note
 * says so: the relay would forget the crewmate at the next reload.
 */
export async function steerCrew(
  paseo: PaseoApi,
  relay: { touch(agentId: string): Promise<boolean> },
  readConfig: () => Promise<FirstmateConfig>,
  agentId: string,
  text: string,
): Promise<void> {
  const agent = await requireCrew(paseo, agentId);
  const saved = await relay.touch(agentId);
  await sendWithoutInterrupting(paseo, agentId, text);
  try {
    const mate = await resolveMate(paseo, await readConfig());
    if (mate.agent !== null) await sendWithoutInterrupting(paseo, mate.agent.id, await steerNote(agent, text, saved));
  } catch (error) {
    console.error(`[firstmate] could not tell the first mate about the captain's words to ${agentId}:`, error);
  }
}

export async function interruptCrew(paseo: PaseoApi, agentId: string): Promise<void> {
  await requireCrew(paseo, agentId);
  await stopAgent(agentId);
}

export async function exitCrew(paseo: PaseoApi, agentId: string): Promise<void> {
  await requireCrew(paseo, agentId);
  await paseo.agents.ref(agentId).archive();
}

/** What the first mate is asked when the captain presses Relaunch (`templates/messages/relaunch.md`). */
export function relaunchText(agent: Pick<PaseoAgent, "id" | "title" | "labels">, note: string): Promise<string> {
  const task = agent.labels[CREW_LABELS.task];
  return message(TEMPLATES.relaunch, {
    worker: task ?? `"${agent.title ?? agent.id}"`,
    agentId: agent.id,
    note: note.trim(),
  });
}

export async function relaunchCrew(paseo: PaseoApi, agentId: string, note: string): Promise<string> {
  const agent = await requireCrew(paseo, agentId);
  return askMate(paseo, { text: await relaunchText(agent, note) });
}

/**
 * What the first mate is told the moment the captain steers a crewmate from the board
 * (`templates/messages/steer-relay.md`). Quoted as the crew relay quotes, so nothing in the words
 * or the title can close the note or open another, and cut after quoting, so the note stays within
 * `MAX_STEER_NOTE_CHARS` however much escaping adds. `saved` false adds steer-relay-unsaved.md.
 */
export async function steerNote(agent: { id: string; title: string | null }, text: string, saved = true): Promise<string> {
  const words = quoted(text.trim());
  const captain =
    words.length <= MAX_RELAYED_CHARS
      ? words
      : await message(TEMPLATES.steerRelayClipped, { text: words.slice(0, MAX_RELAYED_CHARS) });
  const title = quoted((agent.title ?? agent.id).replace(/\s+/g, " ").trim());
  const followup = await message(TEMPLATES.steerRelayNoAnswer);
  return message(TEMPLATES.steerRelay, {
    agentId: agent.id,
    title: title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS)}… [truncated]`,
    captain,
    followup: saved ? followup : `${await message(TEMPLATES.steerRelayUnsaved)}\n${followup}`,
  });
}
