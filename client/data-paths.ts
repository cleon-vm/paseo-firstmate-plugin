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
