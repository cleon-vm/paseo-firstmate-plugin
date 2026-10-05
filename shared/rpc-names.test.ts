import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as files from "./files";
import * as fleet from "./fleet";
import * as quota from "./quota";

/**
 * The daemon's own check (`validateMethod` in Paseo's plugin-process.js): a
 * name it refuses fails `server.handle`, which fails the whole plugin load.
 * No capitals, so `camelCase` names are out.
 */
const DAEMON_METHOD_PATTERN = /^[a-z][a-z0-9._-]*$/;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "patches" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every `defineRpc({ name: "..." })` in the plugin's source, by file. */
function declaredNames(): { file: string; name: string }[] {
  return sources(ROOT).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/defineRpc\(\{\s*name:\s*"([^"]*)"/g)].map((match) => ({
      file: relative(ROOT, path),
      name: match[1]!,
    })),
  );
}

function contractNames(module: Record<string, unknown>): string[] {
  return Object.values(module).flatMap((value) =>
    value && typeof value === "object" && "name" in value && "input" in value && "output" in value
      ? [String((value as { name: unknown }).name)]
      : [],
  );
}

describe("plugin RPC names", () => {
  const declared = declaredNames();

  it("finds the RPCs in the source", () => {
    expect(declared.map((rpc) => rpc.name)).toContain("firstmate.files.read-image");
    expect(declared.length).toBeGreaterThan(20);
  });

  it("are all accepted by the daemon", () => {
    expect(declared.filter((rpc) => !DAEMON_METHOD_PATTERN.test(rpc.name.trim()))).toEqual([]);
  });

  it("are unique", () => {
    const names = declared.map((rpc) => rpc.name.trim());
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  it("include every contract the shared modules export", () => {
    const exported = [...contractNames(files), ...contractNames(fleet), ...contractNames(quota)];
    expect(exported.length).toBeGreaterThan(20);
    expect(exported.filter((name) => !DAEMON_METHOD_PATTERN.test(name))).toEqual([]);
    expect(exported.filter((name) => !declared.some((rpc) => rpc.name === name))).toEqual([]);
  });
});
