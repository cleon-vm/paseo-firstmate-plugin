/**
 * The quota pill beside the chat's buttons: the contract between the daemon,
 * which reads Usage Monitor's saved readings, and the chat, which draws them,
 * plus the pure rules for what the pill says. Percentages are USED, never
 * remaining. Nothing here carries a credential; the daemon hands over only the
 * percent, the window's name, when it resets and when it was read.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Providers with their own name, icon and stale window, in pill order. Any
 * other provider in Usage Monitor's readings is shown too, after these and
 * alphabetically, with a name from its id, a neutral icon and the default
 * stale window.
 */
export const KNOWN_QUOTA_PROVIDERS = ["codex", "claude"] as const;
export type KnownQuotaProviderId = (typeof KNOWN_QUOTA_PROVIDERS)[number];
/** A key of Usage Monitor's readings file that passed `isQuotaProviderId`. */
export type QuotaProviderId = string;

/** The readings file's keys are short slugs; anything past this is not one. */
export const MAX_PROVIDER_ID = 40;

/** Non-empty, at most `MAX_PROVIDER_ID` long, no surrounding whitespace and no control characters. */
export function isQuotaProviderId(value: unknown): value is QuotaProviderId {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= MAX_PROVIDER_ID &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function isKnownQuotaProvider(id: QuotaProviderId): id is KnownQuotaProviderId {
  return (KNOWN_QUOTA_PROVIDERS as readonly string[]).includes(id);
}

/** Known providers first in their own order, then the rest alphabetically; duplicates dropped. */
export function sortProviderIds(ids: Iterable<QuotaProviderId>): QuotaProviderId[] {
  const unique = [...new Set(ids)];
  const known = KNOWN_QUOTA_PROVIDERS.filter((id) => unique.includes(id));
  const rest = unique.filter((id) => !isKnownQuotaProvider(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...known, ...rest];
}

/** Past this age a reading is shown as stale, with its age. Claude's source is polled slowly on purpose. */
export const STALE_AFTER_MS: Record<KnownQuotaProviderId, number> = {
  codex: 10 * 60 * 1000,
  claude: 45 * 60 * 1000,
};
/** The stale window of a provider without its own. */
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

export function staleAfterMs(id: QuotaProviderId): number {
  return isKnownQuotaProvider(id) ? STALE_AFTER_MS[id] : DEFAULT_STALE_AFTER_MS;
}

export const QuotaWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  window: z.string(),
  resetsAt: z.string().nullable(),
});

export const QuotaProviderSchema = z.object({
  id: z.string().min(1).max(MAX_PROVIDER_ID).refine(isQuotaProviderId),
  session: QuotaWindowSchema.nullable(),
  weekly: QuotaWindowSchema.nullable(),
  fetchedAt: z.string().nullable(),
});

export const QuotaSnapshotSchema = z.object({
  /** `unavailable` is a missing, oversized or malformed file; a good file lists exactly the providers it has, sorted. */
  state: z.enum(["ok", "unavailable"]),
  providers: z.array(QuotaProviderSchema),
});

export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export type QuotaProvider = z.infer<typeof QuotaProviderSchema>;
export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

export const readQuota = defineRpc({
  name: "firstmate.quota.read",
  input: z.object({}),
  output: QuotaSnapshotSchema,
});

export const QUOTA_QUERY_KEY = ["firstmate", "quota"] as const;
export const QUOTA_POLL_MS = 60_000;

const FULL: Record<KnownQuotaProviderId, string> = { codex: "Codex", claude: "Claude" };

/** `Codex`, `Claude`; any other id title-cased from its words, `opencode-go` to `Opencode Go`. */
export function providerName(id: QuotaProviderId): string {
  if (isKnownQuotaProvider(id)) return FULL[id];
  const words = id.split(/[-_.\s]+/).filter((word) => word !== "");
  return words.length === 0 ? id : words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

/** Milliseconds since the reading, or null when it has none or its time is unreadable. */
export function ageMs(fetchedAt: string | null, nowMs: number): number | null {
  if (fetchedAt === null) return null;
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, nowMs - at);
}

export function isStale(id: QuotaProviderId, fetchedAt: string | null, nowMs: number): boolean {
  const age = ageMs(fetchedAt, nowMs);
  return age !== null && age > staleAfterMs(id);
}

/** `just now`, `5m`, `2h`, `3d`. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type QuotaTone = "normal" | "muted" | "warning" | "danger";

export type QuotaCell = {
  id: QuotaProviderId;
  /** `32%`, `—`, or `61% · 2h old` when stale; the provider is drawn as an icon beside it. */
  text: string;
  tone: QuotaTone;
  stale: boolean;
  /** Spoken by a screen reader: provider, percent used, window, freshness. */
  label: string;
};

export function usedTone(percent: number): QuotaTone {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warning";
  return "normal";
}

export function freshnessWords(id: QuotaProviderId, fetchedAt: string | null, nowMs: number): string {
  const age = ageMs(fetchedAt, nowMs);
  if (age === null) return "reading time unknown";
  const stale = isStale(id, fetchedAt, nowMs) ? "stale, " : "";
  return age < 60_000 ? `${stale}updated just now` : `${stale}updated ${formatAge(age)} ago`;
}

/** One provider's cell. A provider with no session reading shows `—` and never affects the other. */
export function quotaCell(provider: QuotaProvider | undefined, id: QuotaProviderId, nowMs: number): QuotaCell {
  const name = providerName(id);
  const session = provider?.session ?? null;
  if (session === null) {
    return { id, text: "—", tone: "muted", stale: false, label: `${name}: no quota reading` };
  }
  const fetchedAt = provider?.fetchedAt ?? null;
  const stale = isStale(id, fetchedAt, nowMs);
  const age = ageMs(fetchedAt, nowMs);
  const percent = Math.round(session.usedPercent);
  const base = `${percent}%`;
  return {
    id,
    text: stale && age !== null ? `${base} · ${formatAge(age)} old` : base,
    tone: stale ? "warning" : usedTone(session.usedPercent),
    stale,
    label: `${name}: ${percent} percent used, ${session.window} window, ${freshnessWords(id, fetchedAt, nowMs)}`,
  };
}

/** The providers of the snapshot, in pill order. A provider the file does not have is not shown. */
export function quotaProviders(snapshot: QuotaSnapshot): QuotaProvider[] {
  return sortProviderIds(snapshot.providers.map((provider) => provider.id)).map(
    (id) => snapshot.providers.find((provider) => provider.id === id)!,
  );
}

export function quotaCells(snapshot: QuotaSnapshot, nowMs: number): QuotaCell[] {
  return quotaProviders(snapshot).map((provider) => quotaCell(provider, provider.id, nowMs));
}
