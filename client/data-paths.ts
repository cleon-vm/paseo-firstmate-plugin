/** Plain, quoted and inline-code data paths, preserving all surrounding text. */
export function dataMentions(source: string): Array<{ start: number; text: string; path: string }> {
  const found: Array<{ start: number; text: string; path: string }> = [];
  const pattern = /`((?:\.\/)?data[\\/][^`\n]*)`|"((?:\.\/)?data[\\/][^"\n]*)"|'((?:\.\/)?data[\\/][^'\n]*)'|(?:\.\/)?data[\\/][^\s()[\]{}<>"'`*,;]*/g;
  for (const match of source.matchAll(pattern)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    const text = quoted ?? match[0].replace(/[.:!?]+$/, "");
    const start = match.index + (quoted === undefined ? 0 : 1);
    // Do not turn a suffix of an absolute path, URL or another word into a home path.
    if (start > 0 && /[\w/\\:.-]/.test(source[start - (quoted === undefined ? 1 : 2)] ?? "")) continue;
    found.push({ start, text, path: text.replace(/(?::\d+){1,2}$/, "") });
  }
  return found;
}

/** A path that starts at a drive (`C:\`, `C:/`), at the home (`~/`) or at the root (`/name`). Not UNC: `\\host` and `//host` stay text. */
const ABSOLUTE_START = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|\/(?=[^\\/\s]))`;
const ABSOLUTE_PATTERN = new RegExp(
  String.raw`\`(${ABSOLUTE_START}[^\`\n]*)\`|"(${ABSOLUTE_START}[^"\n]*)"|'(${ABSOLUTE_START}[^'\n]*)'|${ABSOLUTE_START}[^\s()[\]{}<>"'\`*,;|?]*`,
  "g",
);

/** Whether `text` is, from its first character, a data path or an absolute or home path. */
export function isLocalPath(text: string): boolean {
  return /^(?:(?:\.\/)?data[\\/]|[A-Za-z]:[\\/]|~[\\/]|\/[^\\/\s])/.test(text);
}

function absoluteMentions(source: string): Array<{ start: number; text: string; path: string }> {
  const found: Array<{ start: number; text: string; path: string }> = [];
  for (const match of source.matchAll(ABSOLUTE_PATTERN)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    const text = quoted ?? match[0].replace(/[.:!?]+$/, "");
    const start = match.index + (quoted === undefined ? 0 : 1);
    // Not the tail of a word, URL or longer path (`http://host/a`, `a/b`, `x:/y`).
    if (start > 0 && /[\w/\\:.-]/.test(source[start - (quoted === undefined ? 1 : 2)] ?? "")) continue;
    found.push({ start, text, path: text.replace(/(?::\d+){1,2}$/, "") });
  }
  return found;
}

/**
 * Every path the board's text can link: `data/` paths and absolute, `~` and drive paths, in order, with no
 * two overlapping (the longer, earlier one wins). Whether each is a real, linkable folder is the daemon's
 * to say; this only finds what could be.
 */
export function pathMentions(source: string): Array<{ start: number; text: string; path: string }> {
  const all = [...absoluteMentions(source), ...dataMentions(source)].sort((a, b) => a.start - b.start || b.text.length - a.text.length);
  const kept: typeof all = [];
  let end = 0;
  for (const mention of all) {
    if (mention.start < end) continue;
    kept.push(mention);
    end = mention.start + mention.text.length;
  }
  return kept;
}
