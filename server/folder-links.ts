/**
 * Folder links: any local folder named in the board's text can be clicked open in the file manager of the
 * machine the daemon runs on. Unlike data links (`./data-links`) these are not confined to the home, so the
 * action is deliberately narrow:
 *
 * - Only a folder is ever opened. A file, a missing path, a device path or a UNC path is refused, and nothing
 *   is run: the file manager is shown a directory and nothing else (`revealCommand`, no shell).
 * - The path is normalized and resolved to its real target (symlinks and junctions followed), and that real
 *   path is what is checked against the deny list and what is shown. `..`, relative and drive-less paths are
 *   refused outright rather than normalized.
 * - Credential locations (`DEFAULT_FOLDER_DENY`, plus the patterns in the settings) are never linked, whether
 *   the path names them or only leads to them through a link.
 * - A click re-checks everything; what was shown as a link at render time is not trusted.
 *
 * A drive or filesystem root is allowed: a click on `C:\` only opens that folder.
 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { MAX_FILE_PATH_LENGTH, type LinkAction } from "../shared/files";
import { findDataPaths, openDataPath } from "./data-links";
import { revealCommand, startDetached, type RevealDeps } from "./reveal";

/**
 * Folder names (or runs of names, `/`-separated) whose contents are never linked, wherever they sit in the
 * path. Segments match case-insensitively and may use `*` as a wildcard. The settings add to this list.
 */
export const DEFAULT_FOLDER_DENY: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".git",
  ".password-store",
  ".config/gcloud",
  ".config/gh",
  ".mozilla",
  ".thunderbird",
  ".config/google-chrome",
  ".config/chromium",
  ".config/microsoft-edge",
  ".config/BraveSoftware",
  "Google/Chrome",
  "Chromium",
  "BraveSoftware",
  "Microsoft/Edge",
  "Mozilla/Firefox",
  "Microsoft/Credentials",
  "Microsoft/Protect",
  "Microsoft/Vault",
  "Library/Keychains",
  "Library/Safari",
  "Application Support/Firefox",
  "Application Support/Google/Chrome",
  "Application Support/BraveSoftware",
  "Application Support/Microsoft Edge",
];

export interface FolderLinkSettings {
  /** The `folderLinks` setting. */
  enabled: boolean;
  /** The `folderLinkDeny` setting: patterns added to `DEFAULT_FOLDER_DENY`. */
  deny: readonly string[];
}

/** What a folder check needs from the machine; the defaults are the real one. */
export interface FolderDeps {
  /** For tests: judge paths as this platform writes them. Real file access is always the host's. */
  platform?: NodeJS.Platform;
  homeDirectory?: string | undefined;
}

/** A folder the check vouches for: `path` is its real, normalized location. */
export interface FolderTarget {
  path: string;
  absolute: string;
}

function patternSegments(pattern: string): string[] {
  return pattern
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "")
    .map((part) => part.toLowerCase());
}

function segmentMatches(pattern: string, segment: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === segment;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(segment);
}

/** Whether `path` is, or lies inside, a folder the deny patterns name. */
export function isDeniedFolder(path: string, extra: readonly string[] = []): boolean {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part !== "").map((part) => part.toLowerCase());
  return [...DEFAULT_FOLDER_DENY, ...extra].some((pattern) => {
    const wanted = patternSegments(pattern);
    if (wanted.length === 0 || wanted.length > parts.length) return false;
    for (let at = 0; at + wanted.length <= parts.length; at += 1) {
      if (wanted.every((segment, index) => segmentMatches(segment, parts[at + index] ?? ""))) return true;
    }
    return false;
  });
}

/** The characters Windows reserves in a name; `:` is only allowed after the drive letter. */
const RESERVED = /[<>"|?*\u0000-\u001f]/;

/**
 * The absolute, lexically clean form of `candidate`, or null when it is not a path to link at all: empty,
 * too long, relative or drive-less, a device or UNC path, `~user`, anything with `..` in it. `~` is
 * expanded against the daemon's own home directory.
 */
export function cleanFolderPath(candidate: string, deps: FolderDeps = {}): string | null {
  const platform = deps.platform ?? process.platform;
  const text = candidate.trim();
  if (text === "" || text.length > MAX_FILE_PATH_LENGTH || RESERVED.test(text)) return null;
  // `\\server\share`, `//server/share`, `\\.\device` and `\\?\path`: UNC and device paths are never linked.
  if (/^[\\/]{2}/.test(text)) return null;
  let path = text;
  if (/^~(?:[\\/]|$)/.test(path)) path = (platform === "win32" ? win32 : posix).join(deps.homeDirectory ?? homedir(), path.slice(1));
  else if (path.startsWith("~")) return null;
  const windows = platform === "win32";
  if (windows ? !/^[A-Za-z]:[\\/]/.test(path) : !path.startsWith("/")) return null;
  const rest = windows ? path.slice(2) : path;
  if (windows && rest.includes(":")) return null;
  if (rest.split(/[\\/]/).includes("..")) return null;
  return windows ? path.replace(/\//g, "\\").replace(/\\{2,}/g, "\\") : path.replace(/\/{2,}/g, "/");
}

/**
 * The folder `candidate` names, or null. Never throws: a missing path, a file, a device, a refused location
 * and a disabled setting all leave the text unlinked.
 */
export async function folderTarget(
  candidate: string,
  settings: FolderLinkSettings,
  deps: FolderDeps = {},
): Promise<FolderTarget | null> {
  if (!settings.enabled) return null;
  const clean = cleanFolderPath(candidate, deps);
  if (clean === null || isDeniedFolder(clean, settings.deny)) return null;
  try {
    const real = await realpath(clean);
    // A link or junction that leads to a UNC or device path is not followed there.
    if (/^[\\/]{2}/.test(real)) return null;
    // The real target is what is shown, so it is what the deny list sees too.
    if (isDeniedFolder(real, settings.deny)) return null;
    if (!(await stat(real)).isDirectory()) return null;
    return { path: real, absolute: real };
  } catch {
    return null;
  }
}

/** Data paths keep their own, narrower rules; anything else is a candidate folder. */
export const isDataCandidate = (path: string): boolean => /^(?:\.\/)?data[\\/]/.test(path.trim());

/** What the board may link among `paths`: data paths as before, existing folders when the setting allows. */
export async function findLinkPaths(
  home: string,
  paths: readonly string[],
  settings: FolderLinkSettings,
  deps: Pick<FolderDeps, "homeDirectory"> = {},
) {
  const data = await findDataPaths(home, paths.filter(isDataCandidate));
  const others = paths.filter((path) => !isDataCandidate(path));
  const folders = await Promise.all(others.map((path) => folderTarget(path, settings, deps)));
  return {
    paths: {
      ...Object.fromEntries(Object.entries(data.paths).map(([path, target]) => [path, { ...target, action: "data" as const }])),
      ...Object.fromEntries(others.flatMap((path, index) => {
        const target = folders[index];
        return target === null || target === undefined ? [] : [[path, { path: target.path, kind: "dir" as const, action: "folder" as const }]];
      })),
    },
  };
}

/** The refusal for a click that no longer names a linkable thing. */
const REFUSED = { path: null, kind: null, view: false } as const;

/**
 * A click. `action` is the kind of link that was shown and is checked as that kind and no other: a `folder`
 * click can only ever open a directory the folder rules accept, and a `data` click only what `data/` holds.
 */
export async function openLinkPath(
  home: string,
  input: { path: string; revealFile: boolean; action: LinkAction },
  settings: FolderLinkSettings,
  deps: Pick<FolderDeps, "homeDirectory"> & RevealDeps = {},
) {
  if (input.action === "data") return openDataPath(home, input.path, input.revealFile, deps);
  // A folder click never takes the data route, even for a path that looks like one.
  if (isDataCandidate(input.path)) return REFUSED;
  const target = await folderTarget(input.path, settings, { homeDirectory: deps.homeDirectory });
  if (target === null) return REFUSED;
  await startDetached(revealCommand(target.absolute, "dir", deps.platform, deps.env), deps.spawner);
  return { path: target.path, kind: "dir" as const, view: false };
}
