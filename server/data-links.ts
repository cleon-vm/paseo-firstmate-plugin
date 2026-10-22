import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { imageTypeOf } from "../shared/images";
import { readTextFile, resolveInHome } from "./files";
import { revealCommand, startDetached, type RevealDeps } from "./reveal";

/** Existing targets must stay inside both the home and its physical data directory. */
export async function dataTarget(home: string, candidate: string) {
  try {
    const path = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path.startsWith("data/") || path.split("/").includes("..") || path.includes(":")) return null;
    const resolved = await resolveInHome(home, path);
    const root = await realpath(home);
    const data = join(root, "data");
    // A data directory redirected outside the home must not become a trusted root.
    const realData = await realpath(data);
    if (relative(data, realData) !== "") return null;
    const absolute = await realpath(resolved.absolute);
    const inside = relative(realData, absolute);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
    const info = await stat(absolute);
    if (!info.isFile() && !info.isDirectory()) return null;
    // Return the checked physical path, so an alias is not followed again by the viewer.
    return {
      path: relative(root, absolute).replace(/\\/g, "/"),
      absolute,
      kind: info.isDirectory() ? "dir" as const : "file" as const,
    };
  } catch {
    return null;
  }
}

export async function findDataPaths(home: string, paths: readonly string[]) {
  const targets = await Promise.all(paths.map((path) => dataTarget(home, path)));
  return {
    paths: Object.fromEntries(paths.flatMap((path, index) => {
      const target = targets[index];
      return target === null || target === undefined ? [] : [[path, { path: target.path, kind: target.kind }]];
    })),
  };
}

/** Recheck on every click; folders are opened, files are viewed or safely revealed, never executed. */
export async function openDataPath(home: string, path: string, revealFile: boolean, deps: RevealDeps = {}) {
  const target = await dataTarget(home, path);
  if (target === null) return { path: null, kind: null, view: false };
  // The Files viewer handles text and supported images. Other binaries (including
  // executables) and oversized text are selected in their folder instead.
  const view =
    target.kind === "file" && !revealFile &&
    (imageTypeOf(target.path) !== null || (await readTextFile(home, target.path)).content !== null);
  if (!view) {
    await startDetached(revealCommand(target.absolute, target.kind, deps.platform, deps.env), deps.spawner);
  }
  return { path: target.path, kind: target.kind, view };
}
