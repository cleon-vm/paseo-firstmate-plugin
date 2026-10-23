import { describe, expect, it } from "vitest";

import { dataMentions, isLocalPath, pathMentions } from "./data-paths";

const paths = (source: string) => pathMentions(source).map((mention) => mention.path);

describe("pathMentions", () => {
  it("finds Windows, POSIX and ~ paths in prose, with trailing punctuation dropped", () => {
    expect(paths("Open C:\\projects\\demo, then C:/projects/demo/build. Also /home/user/projects/demo: and ~/Downloads!"))
      .toEqual(["C:\\projects\\demo", "C:/projects/demo/build", "/home/user/projects/demo", "~/Downloads"]);
    expect(paths("Did you see C:\\projects\\demo?")).toEqual(["C:\\projects\\demo"]);
  });

  it("finds a drive root and a ~ folder", () => {
    expect(paths("the drive C:\\ and ~\\Documents")).toEqual(["C:\\", "~\\Documents"]);
  });

  it("keeps spaces only inside backticks or quotes, and drops the quotes from the link", () => {
    const source = 'Run in `C:\\my projects\\demo app` or "/home/user/my projects" or \'~/My Files\'; plain C:\\my projects\\x ends at the space';
    const found = pathMentions(source);
    expect(found.map((mention) => mention.path)).toEqual([
      "C:\\my projects\\demo app", "/home/user/my projects", "~/My Files", "C:\\my",
    ]);
    expect(found.slice(0, 3).map((mention) => source.slice(mention.start, mention.start + mention.text.length)))
      .toEqual(["C:\\my projects\\demo app", "/home/user/my projects", "~/My Files"]);
  });

  it("strips a line suffix from the path but keeps it in the shown text", () => {
    expect(pathMentions("see C:\\projects\\demo\\a.ts:12:3")).toEqual([
      { start: 4, text: "C:\\projects\\demo\\a.ts:12:3", path: "C:\\projects\\demo\\a.ts" },
    ]);
  });

  it("stops at brackets, commas and emphasis marks", () => {
    expect(paths("(C:\\projects\\demo) [/home/user/a], **C:\\projects\\b** <~/c>")).toEqual(["C:\\projects\\demo", "/home/user/a", "C:\\projects\\b", "~/c"]);
  });

  it.each([
    "https://host/projects/demo", "http://host/a", "file://host/share", "\\\\server\\share\\x", "//server/share/x",
    "and/or the 1/2 split of 2026/10/23", "src/app/main.ts", "data:text/plain", "word:/not-a-drive", "a lone / slash",
    "x=C:y", "12:30 and 5:/",
  ])("does not link %j", (text) => {
    expect(paths(text)).toEqual([]);
  });

  it("finds a path after an option's equals sign, as in --dir=/home/user/x", () => {
    expect(paths("--dir=/home/user/x --out=C:\\out")).toEqual(["/home/user/x", "C:\\out"]);
  });

  it("keeps data paths exactly as before, alongside folder paths", () => {
    expect(paths("See data/task/report.md:12, `data/a folder/` and data\\task in C:\\projects\\demo")).toEqual([
      "data/task/report.md", "data/a folder/", "data\\task", "C:\\projects\\demo",
    ]);
    const source = 'See data/task/report.md:12, `data/a folder/` and data\\task. https://host/data/task';
    expect(pathMentions(source)).toEqual(dataMentions(source));
  });

  it("does not split an absolute path at a data folder inside it, and prefers the earlier, longer one", () => {
    expect(paths("C:\\projects\\data\\task and /home/user/data/task")).toEqual(["C:\\projects\\data\\task", "/home/user/data/task"]);
    expect(paths("`C:\\my data\\x`")).toEqual(["C:\\my data\\x"]);
  });
});

describe("isLocalPath", () => {
  it.each(["C:\\x", "c:/x", "~/x", "~\\x", "/x", "data/x", "./data/x", "data\\x"])("recognizes %s", (text) => {
    expect(isLocalPath(text)).toBe(true);
  });
  it.each(["x", "//host/x", "\\\\host\\x", "https://x", "~user", "a/b", "/ x", ""])("rejects %j", (text) => {
    expect(isLocalPath(text)).toBe(false);
  });
});
