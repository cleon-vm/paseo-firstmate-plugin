import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KeyboardEvent, View } from "react-native";
import { DeviceEventEmitter, Keyboard, LayoutAnimation, Platform, StatusBar } from "react-native";

vi.mock("react-native", () => ({
  Platform: { OS: "web", Version: 34 },
  StatusBar: { currentHeight: 0 },
  Keyboard: { addListener: vi.fn() },
  DeviceEventEmitter: { addListener: vi.fn() },
  LayoutAnimation: { configureNext: vi.fn(), Types: { keyboard: "keyboard" } },
}));

import { useKeyboardOverlap } from "./keyboard";

let renderer: ReactTestRenderer | undefined;
let overlap = 0;
let layout = () => {};
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
  ({ overlap, onLayout: layout } = useKeyboardOverlap(target));
  return null;
}
async function mount() {
  await act(async () => { renderer = create(createElement(Probe)); });
}
/** Native keyboard listeners, React Native's and Paseo's keyboard library's, by event name. */
const nativeListeners = new Map<string, (event: unknown) => void>();
const remove = vi.fn();
function emit(name: string, event: unknown) {
  return act(async () => nativeListeners.get(name)?.(event));
}
/** React Native's keyboard event with the keyboard's top on screen. */
function frame(screenY: number) {
  return { duration: 0, endCoordinates: { screenY } } as KeyboardEvent;
}
async function change(height: number, offsetTop = 0, type: "resize" | "scroll" = "resize") {
  await act(async () => {
    Object.assign(viewport, { height, offsetTop });
    listeners[type].forEach((listener) => listener());
  });
}

beforeEach(() => {
  Platform.OS = "web";
  Object.assign(Platform, { Version: 34 });
  nativeListeners.clear();
  remove.mockClear();
  for (const emitter of [Keyboard, DeviceEventEmitter]) {
    vi.mocked(emitter.addListener).mockImplementation(((name: string, callback: (event: unknown) => void) => {
      nativeListeners.set(name, callback);
      return { remove };
    }) as never);
  }
  StatusBar.currentHeight = 0;
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
  // Android also stops listening to Paseo's keyboard library.
  expect(remove).toHaveBeenCalledTimes(platform === "ios" ? 2 : 4);
});

it("lifts the composer clear of the keyboard in the Android app, below a status bar", async () => {
  // Edge-to-edge app: measureInWindow counts from below the 40-dp status bar,
  // while keyboardDidShow reports the keyboard's top from the top of the screen.
  Platform.OS = "android";
  StatusBar.currentHeight = 40;
  await mount();
  // The pane ends at 800 below the status bar, 840 on screen; the keyboard starts at 520 on screen.
  const event = { duration: 0, endCoordinates: { screenY: 520 } } as KeyboardEvent;
  await act(async () => nativeListeners.get("keyboardDidShow")!(event));
  // The whole composer, Send at its bottom, ends at or above the keyboard.
  expect(40 + paneBottom - overlap).toBeLessThanOrEqual(520);
  expect(overlap).toBe(320);
});

it("keeps Send above an open Android keyboard as its suggestion strip comes and goes", async () => {
  // From Android 11 React Native reports only opening and closing; Paseo's
  // keyboard library reports every height, counted with the 48-dp navigation bar.
  Platform.OS = "android";
  StatusBar.currentHeight = 40;
  await mount();
  await emit("keyboardDidShow", frame(520));
  await emit("KeyboardController::keyboardDidShow", { height: 368 });
  expect(overlap).toBe(320);
  // The suggestion strip adds 48 dp on top of the open keyboard.
  await emit("KeyboardController::keyboardDidShow", { height: 416 });
  expect(40 + paneBottom - overlap).toBeLessThanOrEqual(472);
  expect(overlap).toBe(368);
  await emit("KeyboardController::keyboardDidShow", { height: 368 });
  expect(overlap).toBe(320);
  await emit("KeyboardController::keyboardDidHide", { height: 0 });
  await emit("keyboardDidHide", frame(1000));
  expect(overlap).toBe(0);
  // Reopened taller: React Native's own report already has the new top.
  await emit("KeyboardController::keyboardDidShow", { height: 416 });
  await emit("keyboardDidShow", frame(472));
  expect(overlap).toBe(368);
  await emit("KeyboardController::keyboardDidShow", { height: 368 });
  expect(overlap).toBe(320);
});

it("leaves height changes to React Native before Android 11, which reports them itself", async () => {
  Platform.OS = "android";
  Object.assign(Platform, { Version: 29 });
  await mount();
  expect(nativeListeners.has("KeyboardController::keyboardDidShow")).toBe(false);
  await emit("keyboardDidShow", frame(480));
  await emit("keyboardDidShow", frame(432));
  expect(overlap).toBe(368);
});

it.each(["android", "ios", "web"] as const)("measures %s again when the pane moves under an open keyboard", async (platform) => {
  Platform.OS = platform;
  await mount();
  if (platform === "web") await change(480);
  else await emit(platform === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow", frame(480));
  expect(overlap).toBe(320);
  paneBottom = 700;
  await act(async () => layout());
  expect(overlap).toBe(220);
  if (platform === "web") await change(800);
  else await emit(platform === "ios" ? "keyboardWillHide" : "keyboardDidHide", frame(800));
  await act(async () => layout());
  expect(overlap).toBe(0);
});

it("drops a measurement that lands after the Android keyboard closed", async () => {
  Platform.OS = "android";
  let pending: (() => void) | undefined;
  const measure = target.current!.measureInWindow;
  target.current!.measureInWindow = (callback) => { pending = () => callback(0, 100, 400, paneBottom - 100); };
  try {
    await mount();
    await emit("keyboardDidShow", frame(480));
    await emit("keyboardDidHide", frame(800));
    await act(async () => pending!());
    expect(overlap).toBe(0);
  } finally {
    target.current!.measureInWindow = measure;
  }
});
