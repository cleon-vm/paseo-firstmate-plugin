/**
 * How far the on-screen keyboard covers a view, so the view can pad itself
 * clear of it.
 *
 * Paseo moves its own composer with `react-native-keyboard-controller`, which
 * is not among the modules a plugin may import, and a plugin surface is not
 * resized when the keyboard opens — so the chat's composer disappeared under
 * it. React Native's `KeyboardAvoidingView` is importable but measures itself
 * against its parent, which inside the host's screen needs an offset nobody
 * here can know. This measures the view in window coordinates instead, the
 * same space the keyboard's frame is reported in, so the overlap is exact
 * wherever the host puts the surface.
 *
 * The padding sits inside the view, so it does not change the frame being
 * measured; there is no feedback loop. Where the platform resizes the window
 * for the keyboard itself, the overlap measures as zero and nothing is added.
 * On the web, the visual viewport supplies the visible bottom instead: mobile
 * browsers can shrink it for the keyboard without resizing the layout viewport.
 * The view's own layout handler measures again against the last keyboard edge,
 * in case the host moves or resizes the view while the keyboard is open.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  DeviceEventEmitter,
  Keyboard,
  LayoutAnimation,
  Platform,
  StatusBar,
  type KeyboardEvent,
  type View,
} from "react-native";
import { trackViewportBottom } from "./web";

export interface KeyboardOverlap {
  /** How far the keyboard covers the view, to pad away. */
  overlap: number;
  /** The view's `onLayout`: measures again against the keyboard's last edge. */
  onLayout: () => void;
}

export function useKeyboardOverlap(target: RefObject<View | null>): KeyboardOverlap {
  const [overlap, setOverlap] = useState(0);
  const remeasure = useRef(() => {});
  const [onLayout] = useState(() => () => remeasure.current());

  useEffect(() => {
    if (Platform.OS === "web") {
      let revision = 0;
      let bottom = Infinity;
      function measure(): void {
        const current = ++revision;
        target.current?.measureInWindow((_x, y, _width, height) => {
          if (current === revision) setOverlap(Math.max(0, Math.round(y + height - bottom)));
        });
      }
      remeasure.current = measure;
      const stop = trackViewportBottom((next) => {
        bottom = next;
        measure();
      });
      return () => {
        revision++;
        remeasure.current = () => {};
        stop();
      };
    }
    const ios = Platform.OS === "ios";

    /** Moves with the keyboard on iOS, as its own views do; Android just snaps. */
    function animate(event: KeyboardEvent): void {
      if (!ios || !(event.duration > 0)) return;
      LayoutAnimation.configureNext({
        duration: event.duration,
        update: { duration: event.duration, type: LayoutAnimation.Types.keyboard },
      });
    }

    // Android measures from below the status bar but reports the keyboard's top
    // from the top of the screen; Paseo's own overlays add the same offset.
    const top = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;

    let revision = 0;
    /** The keyboard's top on screen while it is open. */
    let edge: number | null = null;
    /** The last open-keyboard height Paseo's keyboard library reported (Android). */
    let resized: number | undefined;

    function measure(event?: KeyboardEvent): void {
      const current = ++revision;
      const screenY = edge;
      if (screenY === null) return;
      target.current?.measureInWindow((_x, y, _width, height) => {
        if (current !== revision) return;
        const next = Math.max(0, Math.round(top + y + height - screenY));
        if (event) animate(event);
        setOverlap(next);
      });
    }

    function onChange(event: KeyboardEvent): void {
      edge = event.endCoordinates.screenY;
      measure(event);
    }

    function onHide(event: KeyboardEvent): void {
      revision++;
      edge = null;
      resized = undefined;
      animate(event);
      setOverlap(0);
    }

    // iOS announces every frame change before it happens, show and hide
    // included; Android only reports after the fact.
    const subscriptions = ios
      ? [Keyboard.addListener("keyboardWillChangeFrame", onChange), Keyboard.addListener("keyboardWillHide", onHide)]
      : [Keyboard.addListener("keyboardDidShow", onChange), Keyboard.addListener("keyboardDidHide", onHide)];

    // From Android 11, React Native reports only the keyboard opening and
    // closing, not an open keyboard changing height: its suggestion strip
    // appearing, an emoji panel. Paseo's keyboard library reports those on the
    // same event bus, but counts its heights from another bottom (the
    // navigation bar included), so only the change in its height moves the edge.
    if (Platform.OS === "android" && Number(Platform.Version) >= 30) {
      subscriptions.push(
        DeviceEventEmitter.addListener("KeyboardController::keyboardDidShow", (event?: { height?: unknown }) => {
          const previous = resized;
          resized = typeof event?.height === "number" ? event.height : undefined;
          if (previous === undefined || resized === undefined || edge === null || resized === previous) return;
          edge -= resized - previous;
          measure();
        }),
        DeviceEventEmitter.addListener("KeyboardController::keyboardDidHide", () => {
          resized = undefined;
        }),
      );
    }

    remeasure.current = () => measure();
    return () => {
      revision++;
      remeasure.current = () => {};
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [target]);

  return { overlap, onLayout };
}
