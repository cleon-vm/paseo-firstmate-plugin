/**
 * Reads Usage Monitor's saved last-good readings, `$PASEO_HOME/usage-limits/last-readings.json`,
 * for the chat's quota pill. Read-only and local: no credential file is opened
 * and no vendor endpoint is called. The file is another plugin's cache, so it
 * is validated strictly and only the percent, window name, reset time and
 * read time leave this module. Anything malformed makes the whole snapshot
 * `unavailable` rather than showing a guess.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { QUOTA_PROVIDERS, type QuotaProvider, type QuotaSnapshot, type QuotaWindow } from "../shared/quota";
import { paseoHome } from "./data-dir";

const SUPPORTED_VERSION = 1;
/** The real file is a few kilobytes; anything past this is not it. */
export const MAX_FILE_BYTES = 256 * 1024;
/** A reading dated further ahead than this is a broken clock or file, not a reading. */
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_LABEL = 40;

const UNAVAILABLE: QuotaSnapshot = { state: "unavailable", providers: [] };

export function quotaFilePath(): string {
  return join(paseoHome(), "usage-limits", "last-readings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function label(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_LABEL) : null;
}

function quotaWindow(reading: unknown): QuotaWindow | null {
  if (!isRecord(reading) || reading.kind !== "quota") return null;
  const percent = reading.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const window = isRecord(reading.window) ? reading.window : {};
  return {
    usedPercent: percent,
    window: label(window.label) ?? label(reading.label) ?? "quota",
    resetsAt: isoOrNull(window.resetsAt),
  };
}

function provider(id: QuotaProvider["id"], entry: unknown, nowMs: number): QuotaProvider {
  const empty: QuotaProvider = { id, session: null, weekly: null, fetchedAt: null };
  if (!isRecord(entry) || !Array.isArray(entry.readings)) return empty;
  const fetchedAt = isoOrNull(entry.fetchedAt);
  if (fetchedAt === null || Date.parse(fetchedAt) - nowMs > MAX_FUTURE_MS) return empty;
  const readings: unknown[] = entry.readings;
  const find = (readingId: string) =>
    quotaWindow(readings.find((reading) => isRecord(reading) && reading.id === readingId));
  return { id, session: find("session"), weekly: find("weekly"), fetchedAt };
}

/** Pure: the file's text to the snapshot the chat draws. */
export function parseQuotaFile(text: string, nowMs: number): QuotaSnapshot {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return UNAVAILABLE;
  }
  if (!isRecord(document) || document.version !== SUPPORTED_VERSION || !isRecord(document.providers)) {
    return UNAVAILABLE;
  }
  const providers = document.providers;
  return {
    state: "ok",
    providers: QUOTA_PROVIDERS.map((id) =>
      provider(id, Object.hasOwn(providers, id) ? providers[id] : undefined, nowMs),
    ),
  };
}

export async function readQuotaSnapshot(
  path: string = quotaFilePath(),
  nowMs: number = Date.now(),
): Promise<QuotaSnapshot> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return UNAVAILABLE;
    return parseQuotaFile(await readFile(path, "utf8"), nowMs);
  } catch {
    return UNAVAILABLE;
  }
}
