/**
 * Images in the first mate's home, for the Files view and the Markdown
 * preview: which files are shown as images, how large they may be, and the
 * data URI they are drawn from.
 *
 * Every image is drawn by `Image` from a base64 data URI, SVG included. An SVG
 * is never put into the page as markup: loaded as an image, a browser draws it
 * without running its scripts, loading anything it links to, or letting it
 * handle events, so an SVG the first mate — or a clone under `projects/` —
 * happens to contain can do no more than a PNG can.
 */

/** Larger images are listed but not shown: the RPC carries the whole file, as base64. */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const SVG_TYPE = "image/svg+xml";

const IMAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: SVG_TYPE,
};

/** The image type the Files view shows `path` as, by its extension, or null when it is not one. Either slash separates. */
export function imageTypeOf(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * What an `Image` draws: a data URI, base64 always — never `utf8,` with the
 * file's own text in it, so not even an SVG's markup appears in the URI.
 */
export function imageDataUri(mimeType: string, base64: string): string {
  if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error(`"${mimeType}" is not an image type.`);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Image data is not base64.");
  return `data:${mimeType};base64,${base64}`;
}

/** A URL scheme — but not a Windows drive letter, which is a path. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const DRIVE = /^[a-zA-Z]:([\\/]|$)/;

/** Whether a Markdown image's target is a URL rather than a path: http(s), data, file or any other scheme. Never fetched. */
export function isUrlTarget(target: string): boolean {
  const trimmed = target.trim();
  return SCHEME.test(trimmed) && !DRIVE.test(trimmed);
}

/** Whether a Markdown image's target is a web address, which the preview shows as a link, not an image. */
export function isWebTarget(target: string): boolean {
  return /^https?:\/\//i.test(target.trim());
}
