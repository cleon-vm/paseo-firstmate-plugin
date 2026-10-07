import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginTheme } from "@getpaseo/plugin";
import type { QuotaSnapshot } from "../shared/quota";

// The daemon read and the native host are boundaries; the pill and its rules are real.
const host = vi.hoisted(() => ({ snapshot: undefined as unknown, isError: false }));

vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", Image: "Image",
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => async () => host.snapshot }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: host.snapshot, isError: host.isError, refetch: async () => {}, dataUpdatedAt: 0 }),
}));

import { QuotaPill } from "./quota-pill";

const theme = {
  colors: {
    foreground: "#fff", foregroundMuted: "#999", border: "#333", surface1: "#111",
    statusWarning: "#fa0", statusDanger: "#f00",
  },
} as unknown as PluginTheme;

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  host.snapshot = undefined;
  host.isError = false;
});

function render(snapshot: QuotaSnapshot): ReactTestRenderer {
  host.snapshot = snapshot;
  act(() => {
    renderer = create(createElement(QuotaPill, { theme }));
  });
  return renderer!;
}

function texts(root: ReactTestInstance): string[] {
  return root.findAll((node) => (node.type as unknown) === "Text").map((node) =>
    node.children.map((child) => (typeof child === "string" ? child : "")).join(""),
  );
}

const reading = (id: string, percent: number) => ({
  id,
  session: { usedPercent: percent, window: "Session", resetsAt: null },
  weekly: null,
  fetchedAt: new Date().toISOString(),
});

describe("QuotaPill", () => {
  it("shows every provider in the snapshot, known first, with a fallback icon for unknown ones", () => {
    const tree = render({ state: "ok", providers: [reading("opencode-go", 12), reading("codex", 76), reading("constructor", 5)] });
    const pill = tree.root.findByProps({ accessibilityRole: "button" });
    expect(texts(pill).filter((text) => text !== " · ")).toEqual(["76%", "C", "5%", "O", "12%"]);
    expect(pill.findAll((node) => (node.type as unknown) === "Image")).toHaveLength(1);
    expect(pill.props.accessibilityLabel).toContain("Opencode Go: 12 percent used");
    expect(pill.props.accessibilityLabel).not.toContain("Claude");

    act(() => pill.props.onPress());
    expect(texts(tree.root)).toEqual(expect.arrayContaining(["Codex", "Constructor", "Opencode Go"]));
    expect(texts(tree.root)).not.toContain("Claude");
  });

  it("does not render a provider the snapshot does not have", () => {
    const tree = render({ state: "ok", providers: [reading("claude", 61)] });
    const pill = tree.root.findByProps({ accessibilityRole: "button" });
    expect(texts(pill)).toEqual(["61%"]);
    expect(pill.props.accessibilityLabel).not.toContain("Codex");
  });

  it("says unavailable for an unavailable snapshot and a dash for an empty one", () => {
    expect(texts(render({ state: "unavailable", providers: [] }).root)).toEqual(["Quota unavailable"]);
    act(() => renderer?.unmount());
    expect(texts(render({ state: "ok", providers: [] }).root)).toEqual(["Quota —"]);
  });
});
