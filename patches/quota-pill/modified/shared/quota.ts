/**
 * The quota pill beside the chat's buttons: the contract between the daemon,
 * which reads Usage Monitor's saved readings, and the chat, which draws them,
 * plus the pure rules for what the pill says. Percentages are USED, never
 * remaining. Nothing here carries a credential; the daemon hands over only the
 * percent, the window's name, when it resets and when it was read.
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const QUOTA_PROVIDERS = ["codex", "claude"] as const;
export type QuotaProviderId = (typeof QUOTA_PROVIDERS)[number];

/** Past this age a reading is shown as stale, with its age. Claude's source is polled slowly on purpose. */
export const STALE_AFTER_MS: Record<QuotaProviderId, number> = {
  codex: 10 * 60 * 1000,
  claude: 45 * 60 * 1000,
};

export const QuotaWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  window: z.string(),
  resetsAt: z.string().nullable(),
});

export const QuotaProviderSchema = z.object({
  id: z.enum(QUOTA_PROVIDERS),
  session: QuotaWindowSchema.nullable(),
  weekly: QuotaWindowSchema.nullable(),
  fetchedAt: z.string().nullable(),
});

export const QuotaSnapshotSchema = z.object({
  /** `unavailable` is a missing, oversized or malformed file; a provider absent from a good file is just empty. */
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

const FULL: Record<QuotaProviderId, string> = { codex: "Codex", claude: "Claude" };

export function providerName(id: QuotaProviderId): string {
  return FULL[id];
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
  return age !== null && age > STALE_AFTER_MS[id];
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
  const name = FULL[id];
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

export function quotaCells(snapshot: QuotaSnapshot, nowMs: number): QuotaCell[] {
  return QUOTA_PROVIDERS.map((id) =>
    quotaCell(
      snapshot.providers.find((provider) => provider.id === id),
      id,
      nowMs,
    ),
  );
}
