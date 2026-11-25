import { createElement, type ElementType } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginTheme } from "@getpaseo/plugin";
import type { WatchSummary } from "../shared/fleet";

// The host's components and RPCs are boundaries; the board and the watch list are real.
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", ActivityIndicator: "ActivityIndicator",
  Platform: { OS: "web", select: (options: { default: unknown }) => options.default },
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Icon: "Icon", TextInput: "TextInput", useToast: () => ({ error: vi.fn(), show: vi.fn() }),
}));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => vi.fn().mockResolvedValue({}), openExternalUrl: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));

import { Board } from "./board";
import { COLUMN_IDS } from "../shared/fleet";
import { WATCHES_CARD, watchTrouble } from "./format";

const theme = { colors: {
  foreground: "#eee", foregroundMuted: "#aaa", surface0: "#111", surface1: "#222", surface2: "#333",
  border: "#555", accent: "#08f", accentForeground: "#fff", statusDanger: "#f00",
  statusWarning: "#fa0", statusSuccess: "#0f0",
} } as unknown as PluginTheme;
const Pressable = "Pressable" as ElementType;

function watch(name: string, extra: Partial<WatchSummary> = {}): WatchSummary {
  return {
    name, schedule: "*/5 * * * *", enabled: true, invalid: null, running: false, lastRunAt: null,
    lastResult: "silent", lastOutput: null, lastOutputAt: null, lastError: null, builtIn: false, outdated: false,
    ...extra,
  };
}
const watches = [watch("ci.sh"), watch("prs.sh", { lastResult: "failed", lastError: "exit 1" })];

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

function mount(collapsed: readonly string[], compact: boolean, onToggleColumn = vi.fn()) {
  const element = createElement(Board, {
    cards: [], order: [...COLUMN_IDS], collapsed, theme, compact, suggestions: [],
    toMate: { send: vi.fn(), sending: false } as never, onRemoveSuggestion: vi.fn(),
    watches, onOpenFile: vi.fn(), onWatch: vi.fn(), onToggleColumn, onReorder: vi.fn(), onChanged: vi.fn(),
  });
  act(() => {
    renderer = create(element);
  });
  return onToggleColumn;
}
const toggle = () =>
  renderer!.root.findAll(
    (node) => node.type === Pressable && /^(Fold|Unfold) Watches/.test(String(node.props.accessibilityLabel)),
  );
const watchRows = () =>
  renderer!.root.findAll((node) => node.type === Pressable && String(node.props.accessibilityLabel).startsWith("Open "));

describe("the Watches card folds", () => {
  for (const compact of [false, true]) {
    const layout = compact ? "on a phone" : "on a wide board";

    it(`shows its watches and a Fold button ${layout}`, () => {
      const onToggle = mount([], compact);
      expect(watchRows()).toHaveLength(2);
      const [button] = toggle();
      expect(button!.props.accessibilityState).toEqual({ expanded: true });
      act(() => button!.props.onPress());
      expect(onToggle).toHaveBeenCalledWith(WATCHES_CARD);
    });

    it(`folded, hides its watches but keeps the count and trouble ${layout}`, () => {
      const onToggle = mount([WATCHES_CARD], compact);
      expect(watchRows()).toHaveLength(0);
      const [button] = toggle();
      expect(button!.props.accessibilityState).toEqual({ expanded: false });
      expect(button!.props.accessibilityLabel).toBe("Unfold Watches, 2 watches, 1 failing");
      const texts = renderer!.root.findAllByType("Text" as ElementType).map((node) => node.props.children);
      expect(texts).toContain(2);
      act(() => button!.props.onPress());
      expect(onToggle).toHaveBeenCalledWith(WATCHES_CARD);
    });
  }
});

describe("watchTrouble", () => {
  it("counts switched-on watches that failed or cannot run", () => {
    expect(
      watchTrouble([
        watch("a"),
        watch("b", { lastResult: "failed" }),
        watch("c", { invalid: "no schedule", lastResult: "invalid" }),
        watch("d", { lastResult: "failed", enabled: false }),
      ]),
    ).toBe(2);
  });
});
