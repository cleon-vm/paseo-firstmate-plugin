import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { dataTarget, findDataPaths, openDataPath } from "./data-links";
import { explorerArgument, type Spawner } from "./reveal";

let home: string;
let outer: string;
beforeAll(async () => {
  outer = await realpath(await mkdtemp(join(tmpdir(), "data-links-")));
  home = join(outer, "home");
  await mkdir(join(home, "data", "a folder"), { recursive: true });
  await mkdir(join(home, "private"));
  await writeFile(join(home, "data", "a folder", "report.md"), "# Report");
  await writeFile(join(home, "data", "run.cmd"), "echo MUST_NOT_RUN");
  await writeFile(join(home, "data", "app.exe"), Buffer.from([77, 90, 0]));
  await writeFile(join(home, "private", "secret.md"), "outside data");
});

describe("data links", () => {
  it("resolves files, folders and Windows separators against the supplied home", async () => {
    expect(await dataTarget(home, "data/a folder/report.md")).toMatchObject({ path: "data/a folder/report.md", kind: "file" });
    expect(await dataTarget(home, "data\\a folder\\")).toMatchObject({ kind: "dir" });
    expect(await dataTarget(home, "./data/a folder")).toMatchObject({ kind: "dir" });
    expect(await dataTarget(home, "data/")).toMatchObject({ path: "data", kind: "dir" });
  });

  it.each(["../data/run.cmd", "data/../private/secret.md", "data/a folder/../../private/secret.md", "data/./../data/run.cmd", "data\\..\\private\\secret.md", "C:\\Windows\\x", "/etc/passwd", "private/secret.md", "data/run.cmd:stream", "data/missing"])("leaves %s inert", async (path) => {
    expect(await dataTarget(home, path)).toBeNull();
  });

  it("rejects junction escapes outside data, even when still inside home", async () => {
    await symlink(join(home, "private"), join(home, "data", "escape"), "junction");
    await symlink(outer, join(home, "data", "outside"), "junction");
    expect(await dataTarget(home, "data/escape/secret.md")).toBeNull();
    expect(await dataTarget(home, "data/outside")).toBeNull();
    await symlink(join(home, "data", "a folder"), join(home, "data", "alias"), "junction");
    expect(await dataTarget(home, "data/alias/report.md")).toMatchObject({ path: "data/a folder/report.md" });
  });

  it("rejects a redirected data root", async () => {
    const redirected = join(outer, "redirected");
    await mkdir(redirected);
    await symlink(join(home, "data"), join(redirected, "data"), "junction");
    expect(await dataTarget(redirected, "data/run.cmd")).toBeNull();
  });

  it("finds existing data targets, silently omitting missing and unsafe paths", async () => {
    expect(await findDataPaths(home, ["data/a folder", "data/run.cmd", "data/missing", "data/../private/secret.md"])).toEqual({ paths: {
      "data/a folder": { path: "data/a folder", kind: "dir" },
      "data/run.cmd": { path: "data/run.cmd", kind: "file" },
    } });
  });

  it("opens scripts as text; rechecks missing and escaping clicks", async () => {
    const spawner = vi.fn<Spawner>();
    expect(await openDataPath(home, "data/run.cmd", false, { spawner })).toEqual({ path: "data/run.cmd", kind: "file", view: true });
    for (const path of ["data/missing", "data/../private/secret.md", "data/escape/secret.md"]) {
      expect(await openDataPath(home, path, true, { spawner })).toEqual({ path: null, kind: null, view: false });
    }
    expect(spawner).not.toHaveBeenCalled();
  });

  it("opens folders and reveals standalone files via the file manager, never a file handler", async () => {
    const spawner = vi.fn<Spawner>(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    await openDataPath(home, "data/a folder", false, { platform: "win32", spawner });
    await openDataPath(home, "data/run.cmd", true, { platform: "win32", spawner });
    expect(await openDataPath(home, "data/app.exe", false, { platform: "win32", spawner })).toEqual({ path: "data/app.exe", kind: "file", view: false });
    expect(spawner.mock.calls[0]?.[0]).toMatch(/explorer\.exe$/);
    expect(spawner.mock.calls[0]?.[1]).toEqual([explorerArgument(join(home, "data", "a folder"))]);
    expect(spawner.mock.calls[1]?.[1]).toEqual([`/select,${explorerArgument(join(home, "data", "run.cmd"))}`]);
    expect(spawner.mock.calls[2]?.[1]).toEqual([`/select,${explorerArgument(join(home, "data", "app.exe"))}`]);
    expect(spawner.mock.calls[1]?.[2]).toMatchObject({ shell: false });
  });
});
