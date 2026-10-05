/** The file open in the Files view. Pure, so the save bookkeeping is testable. */
export type OpenFile =
  | { kind: "text"; path: string; modifiedMs: number; saved: string; draft: string }
  /** View-only; `data` is the file as base64, drawn from a data URI (`shared/images.ts`). */
  | { kind: "image"; path: string; modifiedMs: number; mimeType: string; size: number; data: string }
  | { kind: "unreadable"; path: string; reason: "binary" | "tooLarge" | "imageTooLarge"; size: number };

/** An image as `firstmate.files.read-image` answers it, opened: shown, or too large to be. */
export function openedImage(result: {
  path: string;
  mimeType: string;
  data: string | null;
  size: number;
  modifiedMs: number;
}): OpenFile {
  if (result.data === null) return { kind: "unreadable", path: result.path, reason: "imageTooLarge", size: result.size };
  return {
    kind: "image",
    path: result.path,
    modifiedMs: result.modifiedMs,
    mimeType: result.mimeType,
    size: result.size,
    data: result.data,
  };
}

/**
 * The open file once `content` has been saved to `path` at `modifiedMs`. The
 * editor stays editable while a save is in flight, so the draft is kept as it
 * is now, not as it was sent — anything typed meanwhile stays, and stays
 * unsaved. A different file opened meanwhile is left alone.
 */
export function markSaved(
  current: OpenFile | null,
  saved: { path: string; content: string; modifiedMs: number },
): OpenFile | null {
  if (current?.kind !== "text" || current.path !== saved.path) return current;
  return { ...current, modifiedMs: saved.modifiedMs, saved: saved.content };
}

/** Whether the open file has text its last save did not include. */
export function isDirty(file: OpenFile | null): boolean {
  return file?.kind === "text" && file.draft !== file.saved;
}
