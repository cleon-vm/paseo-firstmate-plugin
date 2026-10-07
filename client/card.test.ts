import { createElement, type ElementType } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginTheme } from "@getpaseo/plugin";
import type { AgentSummary, FleetCard } from "../shared/fleet";

// The daemon and native host are boundaries; the card, its buttons and its
// memory are real. A fake TextInput stands in for the host's.
const host = vi.hoisted(() => ({
  toast: { error: vi.fn(), show: vi.fn() },
  rpc: vi.fn().mockResolvedValue({}),
}));

vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator",
  Platform: { OS: "web", select: (options: { default: unknown }) => options.default },
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Icon: "Icon", TextInput: "TextInput", useToast: () => host.toast,
}));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => host.rpc, openExternalUrl: vi.fn() }));

import { CrewCard } from "./card";

const theme = { colors: {
  foreground: "#eee", foregroundMuted: "#aaa", surface0: "#111", surface1: "#222",
  border: "#555", accent: "#08f", accentForeground: "#fff", statusDanger: "#f00",
  statusWarning: "#fa0", statusSuccess: "#0f0",
} } as unknown as PluginTheme;
const Pressable = "Pressable" as ElementType;
const InputHost = "TextInput" as ElementType;

const agent: AgentSummary = {
  id: "agent-1", workspaceId: null, title: "alpha", provider: "codex", model: null,
  status: "idle", cwd: "/work", pendingPermissions: 0, requiresAttention: false,
  lastError: null, updatedAt: "2026-01-01T00:00:00Z", labels: {},
};
let sequence = 0;
// Card keys are remembered per module, so each test gets its own.
function makeCard(): () => FleetCard {
  const key = `agent:card-test-${sequence++}`;
  return () => ({
    key, column: "in-progress" as FleetCard["column"], taskId: "T1", title: "Alpha task",
    project: "proj", kind: null, backlog: null, agent: { ...agent }, report: null, url: null,
  });
}

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  host.rpc.mockClear();
});

function mount(card: FleetCard): void {
  const element = createElement(CrewCard, { card, theme, compact: false, opener: null, onChanged: () => {} });
  act(() => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
const labelled = (matches: (label: string) => boolean) =>
  renderer!.root.findAll(
    (node) => node.type === Pressable && typeof node.props.accessibilityLabel === "string" && matches(node.props.accessibilityLabel),
  )[0]!;
const header = () => labelled((label) => label.endsWith(" actions"));
const button = (label: string) => labelled((found) => found === label);
const box = () => renderer!.root.findAllByType(InputHost);
const isOpen = () => header().props.accessibilityState.expanded as boolean;
const ancestors = (node: ReactTestInstance) => {
  const chain: ReactTestInstance[] = [];
  for (let up = node.parent; up !== null; up = up.parent) chain.push(up);
  return chain;
};
/** A click reaches the nearest pressable at or above the target, which stops it (as react-native-web does). */
function click(target: ReactTestInstance): void {
  const pressable = [target, ...ancestors(target)].find((node) => node.type === Pressable && node.props.onPress);
  if (pressable) act(() => pressable.props.onPress());
}
function openSteerBox(card: FleetCard): void {
  mount(card);
  click(header());
  click(button("Steer"));
  act(() => box()[0]!.props.onChangeText("please rebase first"));
}

describe("CrewCard steer box", () => {
  it("opens and closes on a press of the header, and only there", () => {
    mount(makeCard()());
    expect(isOpen()).toBe(false);
    click(header());
    expect(isOpen()).toBe(true);
    click(renderer!.root.findByProps({ children: "Alpha task" }));
    expect(isOpen()).toBe(false);
  });

  it("keeps the box open on a press inside it, and on its buttons", () => {
    openSteerBox(makeCard()());
    expect(box()).toHaveLength(1);
    // The actions and the box are not inside the pressable header.
    expect(ancestors(box()[0]!)).not.toContain(header());
    for (const label of ["Steer", "Interrupt", "Relaunch", "End", "Send", "Cancel"]) {
      expect(ancestors(button(label))).not.toContain(header());
    }
    click(box()[0]!);
    expect(isOpen()).toBe(true);
    expect(box()[0]!.props.value).toBe("please rebase first");
    // Pressing a button runs only that button's action.
    click(button("Relaunch"));
    expect(isOpen()).toBe(true);
    expect(box()[0]!.props.value).toBe("");
  });

  it("closes only through the header, which hides the box and keeps the text", () => {
    openSteerBox(makeCard()());
    click(header());
    expect(isOpen()).toBe(false);
    expect(box()).toHaveLength(0);
    click(header());
    expect(box()[0]!.props.value).toBe("please rebase first");
  });

  it("keeps the box, the text and the node through a refresh with the same data", () => {
    const card = makeCard();
    openSteerBox(card());
    const before = box()[0]!;
    mount(card());
    mount({ ...card(), agent: { ...agent, updatedAt: "2026-01-01T00:00:05Z" } });
    expect(isOpen()).toBe(true);
    expect(box()).toHaveLength(1);
    expect(box()[0]!.props.value).toBe("please rebase first");
    expect(box()[0]).toBe(before);
  });

  it("leaves Enter and Space to the box: nothing above it handles keys or presses", () => {
    openSteerBox(makeCard()());
    const above = ancestors(box()[0]!).filter((node) => typeof node.type === "string");
    for (const node of above) {
      for (const prop of ["onPress", "onKeyDown", "onKeyUp", "onKeyPress", "onClick"]) {
        expect(node.props[prop], `${String(node.type)} ${prop}`).toBeUndefined();
      }
    }
    // Typing a newline and a space is the box's own change, with the card still open.
    act(() => box()[0]!.props.onChangeText("line one\nand a space "));
    expect(isOpen()).toBe(true);
    expect(box()[0]!.props.value).toBe("line one\nand a space ");
  });

  it("sends the typed text and closes the box", async () => {
    openSteerBox(makeCard()());
    await act(async () => { click(button("Send")); });
    expect(host.rpc).toHaveBeenCalledWith({ agentId: "agent-1", text: "please rebase first" });
    expect(box()).toHaveLength(0);
  });
});
