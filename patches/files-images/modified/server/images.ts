/**
 * Images in the home, read for the Files view and the Markdown preview (see
 * `shared/images.ts` for how they are drawn).
 *
 * An image is confined exactly as a text file is: its path goes through
 * `resolveInHome`, so nothing outside the home — through `..`, an absolute
 * path or a symlink — is read. A Markdown image's target is first turned into
 * the paths it could mean (`imageCandidates`), each of which `findFiles`
 * checks the same way, and the one found is then read through
 * `resolveInHome` again.
 */
import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { imageTypeOf, isUrlTarget, MAX_IMAGE_BYTES } from "../shared/images";
import { findFiles, resolveInHome } from "./files";

/** The raster type the first bytes say a file is, whatever its extension, or null. SVG is text and has no signature. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (signature: readonly number[], at = 0) => signature.every((byte, index) => bytes[at + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export interface HomeImage {
  path: string;
  mimeType: string;
  data: string | null;
  tooLarge: boolean;
  size: number;
  modifiedMs: number;
}

/**
 * An image in the home as base64, or its size alone when it is over the cap.
 * Its type is the one its bytes say, so a JPEG saved as `.png` still draws,
 * and a `.png` holding anything else is never called an SVG.
 */
export async function readImageFile(home: string, path: string, maxBytes = MAX_IMAGE_BYTES): Promise<HomeImage> {
  const { absolute, relative: rel } = await resolveInHome(home, path);
  const byExtension = imageTypeOf(rel);
  if (byExtension === null) throw new Error(`"${rel}" is not an image the Files view shows.`);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`"${rel}" is not a file.`);
  const base = { path: rel, mimeType: byExtension, size: info.size, modifiedMs: Math.floor(info.mtimeMs) };
  if (info.size > maxBytes) return { ...base, data: null, tooLarge: true };
  const bytes = await readFile(absolute);
  // Grown since the stat: the cap is on what is sent.
  if (bytes.length > maxBytes) return { ...base, size: bytes.length, data: null, tooLarge: true };
  return { ...base, mimeType: sniffImageType(bytes) ?? byExtension, data: bytes.toString("base64"), tooLarge: false };
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/**
 * The paths a Markdown image's `target`, written in the file at `from`
 * (home-relative), could mean, most likely first: beside the Markdown file,
 * then from the home itself. An absolute path — a drive letter, `\\server`,
 * `/…` — and `~/…`, the user's home folder, are kept absolute, and count only
 * if they land inside the first mate's home; `/…` is also tried from that
 * home, as a site root would be. A URL of any kind is no path, so it has none.
 * These are candidates only: nothing here decides what is inside the home.
 */
export function imageCandidates(target: string, from: string, userHome: string = homedir()): string[] {
  let raw = target.trim();
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1).trim();
  if (raw === "" || isUrlTarget(raw)) return [];
  const spellings = [raw];
  try {
    const decoded = decodeURI(raw);
    if (decoded !== raw) spellings.push(decoded);
  } catch {
    // Not percent-encoded after all.
  }
  const found: string[] = [];
  for (const spelling of spellings) {
    if (/^~[\\/]/.test(spelling)) {
      found.push(join(userHome, spelling.slice(2)));
    } else if (/^[a-zA-Z]:[\\/]/.test(spelling) || /^[\\/]{2}/.test(spelling)) {
      found.push(spelling);
    } else if (/^[\\/]/.test(spelling)) {
      found.push(spelling, spelling.replace(/^[\\/]+/, ""));
    } else {
      const relative = spelling.replace(/\\/g, "/");
      const dir = parentOf(from.replace(/\\/g, "/"));
      found.push(dir === "" ? relative : `${dir}/${relative}`, relative);
    }
  }
  return [...new Set(found)];
}

/** The home-relative path of the image a Markdown file at `from` names as `target`, or null when it names none in the home. */
export async function findMarkdownImage(home: string, target: string, from: string): Promise<string | null> {
  const candidates = imageCandidates(target, from).filter((candidate) => imageTypeOf(candidate) !== null);
  if (candidates.length === 0) return null;
  const files = await findFiles(home, candidates);
  for (const candidate of candidates) {
    const path = files[candidate];
    if (path !== undefined) return path;
  }
  return null;
}

/** What `firstmate.files.read-image` answers: the image at `path`, or the one a Markdown file at `relativeTo` names. */
export async function readHomeImageFile(home: string, input: { path: string; relativeTo?: string | undefined }): Promise<HomeImage> {
  if (input.relativeTo === undefined) return readImageFile(home, input.path);
  const found = await findMarkdownImage(home, input.path, input.relativeTo);
  if (found === null) throw new Error(`"${input.path}" is not an image in the first mate's home.`);
  return readImageFile(home, found);
}
