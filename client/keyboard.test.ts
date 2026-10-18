import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KeyboardEvent, View } from "react-native";
import { Keyboard, LayoutAnimation, Platform } from "react-native";

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  Keyboard: { addListener: vi.fn() },
  LayoutAnimation: { configureNext: vi.fn(), Types: { keyboard: "keyboard" } },
}));

import { useKeyboardOverlap } from "./keyboard";

let renderer: ReactTestRenderer | undefined;
let overlap = 0;
let paneBottom = 800;
const listeners = { resize: new Set<() => void>(), scroll: new Set<() => void>() };
const viewport = {
  height: 800, offsetTop: 0, scale: 1,
  addEventListener: (type: "resize" | "scroll", listener: () => void) => listeners[type].add(listener),
  removeEventListener: (type: "resize" | "scroll", listener: () => void) => listeners[type].delete(listener),
};
const target = { current: {
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
    callback(0, 100, 400, paneBottom - 100),
} } as RefObject<View>;

function Probe() {
  overlap = useKeyboardOverlap(target);
  return null;
}
async function mount() {
  await act(async () => { renderer = create(createElement(Probe)); });
}
async function change(height: number, offsetTop = 0, type: "resize" | "scroll" = "resize") {
  await act(async () => {
    Object.assign(viewport, { height, offsetTop });
    listeners[type].forEach((listener) => listener());
  });
}

beforeEach(() => {
  Platform.OS = "web";
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("visualViewport", viewport);
  Object.assign(viewport, { height: 800, offsetTop: 0, scale: 1 });
  paneBottom = 800;
  overlap = 0;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("keeps the composer bottom above an Android browser keyboard", async () => {
  await mount();
  expect(overlap).toBe(0);
  await change(480);
  // Both stacked actions end at or above the composer's bottom.
  expect(paneBottom - overlap).toBeLessThanOrEqual(viewport.height);
  expect(overlap).toBe(320);
  await change(800);
  expect(overlap).toBe(0);
});

it("does not double-count a host that already resizes the pane", async () => {
  await mount();
  paneBottom = 480;
  await change(480);
  expect(overlap).toBe(0);
});

it("accounts for browser panning and an already open keyboard on mount", async () => {
  Object.assign(viewport, { height: 480, offsetTop: 80 });
  await mount();
  expect(overlap).toBe(240);
  await change(480, 120, "scroll");
  expect(overlap).toBe(200);
});

it("leaves desktop and browsers without VisualViewport alone and removes listeners", async () => {
  await mount();
  expect(overlap).toBe(0);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(listeners.resize.size).toBe(0);
  expect(listeners.scroll.size).toBe(0);
  vi.stubGlobal("visualViewport", undefined);
  await mount();
  expect(overlap).toBe(0);
});

it("does not move the composer for pinch zoom", async () => {
  await mount();
  viewport.scale = 2;
  await change(400);
  expect(overlap).toBe(0);
});

it.each(["android", "ios"] as const)("preserves %s native keyboard events", async (platform) => {
  Platform.OS = platform;
  const nativeListeners = new Map<string, (event: KeyboardEvent) => void>();
  const remove = vi.fn();
  vi.mocked(Keyboard.addListener).mockImplementation((name, callback) => {
    nativeListeners.set(name, callback);
    return { remove } as unknown as ReturnType<typeof Keyboard.addListener>;
  });
  vi.mocked(LayoutAnimation.configureNext).mockClear();
  await mount();
  expect(listeners.resize.size).toBe(0);
  const event = { duration: 250, endCoordinates: { screenY: 480 } } as KeyboardEvent;
  await act(async () => nativeListeners.get(platform === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow")!(event));
  expect(overlap).toBe(320);
  expect(LayoutAnimation.configureNext).toHaveBeenCalledTimes(platform === "ios" ? 1 : 0);
  await act(async () => nativeListeners.get(platform === "ios" ? "keyboardWillHide" : "keyboardDidHide")!(event));
  expect(overlap).toBe(0);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(remove).toHaveBeenCalledTimes(2);
});
