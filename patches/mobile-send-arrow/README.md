# Mobile send arrow (local patch to FirstMate 0.4.0)

| Files | Patch file |
| --- | --- |
| `client/keyboard.ts`, `client/web.ts`, `client/chat.tsx`, `client/files.tsx`, `client/chat.test.ts` modified; `client/keyboard.test.ts` new | `mobile-send-arrow.patch` |

Apply after the ten earlier patches. Base commit: `0875773`; the input files also match the original `7462568` task base. `original/` holds the five changed files before this patch (`chat.tsx` as chat input lag leaves it, `files.tsx` as reveal in explorer leaves it); `modified/` holds all six resulting files. Test snapshots end in `.ts.txt` to keep archival copies out of test discovery; drop `.txt` when restoring them. The package remains **0.4.0**, as already landed on main.

**Problem.** `useKeyboardOverlap` returned zero on web. Android Chrome can shrink the visual viewport for its keyboard while leaving the layout viewport unchanged. The installed Paseo web shell uses full-height, overflow-hidden roots; its viewport meta tag does not request `interactive-widget=resizes-content`. React Native Web's `measureInWindow` reads the element's bounding rectangle. A pane ending at 800 with the visible bottom at 480 therefore retained its composer below the keyboard. The input has fixed height and the actions are in normal flow. This reproduces the browser path, not the phone's exact runtime.

**Change.** Measure the pane against `visualViewport.offsetTop + height` on mount, resize and scroll, using the existing overlap padding. A host-resized pane needs zero padding. Ignore pinch zoom, discard stale measurements, and remove listeners on unmount. Browser globals stay in `client/web.ts`. Native Android/iOS keyboard events and iOS animation retain their existing code. The existing chat effect follows the end only while pinned.

**Android app (second fix).** The web change did not help the Paseo Android app, which does not run the web path. The app evaluates a plugin's client bundle in Hermes and hands it its own `react-native` (`packages/app/src/plugins/evaluate.ts` in Paseo's source), so `Platform.OS` is `"android"` and the native `keyboardDidShow` branch runs. The app is new-architecture and edge-to-edge (`app.config.js`: `newArchEnabled`, `edgeToEdgeEnabled`, `softwareKeyboardLayoutMode: "resize"`, under `react-native-keyboard-controller`'s `KeyboardProvider`). In React Native 0.81.5 the two numbers the overlap subtracts have different origins. `measureInWindow` adds the root's viewport offset, which `ReactSurfaceView` sets to the root's screen position minus the top of the visible window frame, so it counts from below the status bar. `keyboardDidShow`'s `screenY` is the visible frame's bottom in screen coordinates. The overlap therefore came out one status-bar height short, and the bottom of the composer, where Send sits (`alignItems: "flex-end"`), stayed under the keyboard. The fix adds `StatusBar.currentHeight` to the measured bottom on Android only, the same correction Paseo's own tooltip, context menu and menu overlay apply to measured positions. iOS, desktop and the web path are unchanged. This is read from source; it has not been tried on a device.

**Android keyboard height (third fix).** After the second fix Send was clear at first, then cut off again once the keyboard's suggestion strip appeared. From React Native 0.81.5's `ReactRootView` (`CustomGlobalLayoutListener.checkForKeyboardEvents`), on Android 11 (API 30) and later `keyboardDidShow` and `keyboardDidHide` fire only when the IME's visibility flips; an open keyboard growing or shrinking (suggestion strip, emoji panel, another keyboard) emits nothing. Only the pre-11 path re-emits `keyboardDidShow` on a height change. `keyboardDidChangeFrame` is never emitted on Android, `Keyboard.metrics()` only caches the last `keyboardDidShow`, `Dimensions` changes only on rotation, and the pane's own layout does not change, because the edge-to-edge app does not resize the window for the keyboard. Paseo's keyboard library (`react-native-keyboard-controller` 1.21.12, not importable by plugins) does detect resizes (`KeyboardAnimationCallback.onApplyWindowInsets` and `onStart`) and emits `KeyboardController::keyboardDidShow` with the new height through React Native's `RCTDeviceEventEmitter`, which a plugin reaches as `DeviceEventEmitter`. Its heights include the navigation bar in this edge-to-edge app, unlike React Native's, so the hook uses only the *change* between two of its reports to move the keyboard's last known top, then measures the pane again. React Native's own event still sets the top whenever the keyboard opens. This listener is used only on Android 11 and later, so older versions are not counted twice. If a future host drops the library or renames the event, nothing arrives and behaviour falls back to the second fix. Separately, the pane's `onLayout` now measures again against the last keyboard edge (web and native), and a measurement landing after the keyboard closed is discarded. iOS keeps `keyboardWillChangeFrame`. This is read from source; it has not been tried on a device.

## Validation

Before the fix, two of four regression tests failed: `expected 800 to be less than or equal to 480`, and 0 instead of 240 for an already-open keyboard. All four passed afterward. Extended coverage checks dismissal, panning, host resizing, desktop/no-API fallback, pinch zoom, cleanup, native Android/iOS events, and the real chat's padding and pinned/away scrolling. Native measurements are mocked. Physical Android/iOS layout and tap hit-testing remain unverified. No installed plugin was changed or reloaded.

For the Android app fix, a test mounts the hook as `android` with a 40-dp status bar, a pane ending at 840 on screen and the keyboard at 520. Without the fix it failed with `expected 560 to be less than or equal to 520` (the composer ended 40 dp under the keyboard); with it, the overlap is 320 and all eight keyboard tests pass.

For the third fix, run against the second fix's hook (adapted only to the new return shape), six keyboard tests failed, including `expected 520 to be less than or equal to 472`: with a 40-dp status bar and the keyboard at 520, a 48-dp suggestion strip left the composer's bottom, where Send sits, 48 dp under the keyboard. The others were `expected 320 to be 220` (no layout re-measure, on Android, iOS and web), `expected 320 to be +0` (a late measurement after the keyboard closed) and the Android unsubscribe count. With the fix all fourteen keyboard tests pass, including a pre-Android-11 test that keeps React Native's own resize events.

Use the test-only renderer setup in `patches/chat-input-lag/README.md`, then:

```powershell
npm test -- --exclude 'patches/**'
./node_modules/.bin/tsc.cmd --noEmit --jsx react-jsx --module esnext --moduleResolution bundler --target es2022 --lib es2022 --types node --skipLibCheck client/chat.tsx client/chat.test.ts client/keyboard.ts client/keyboard.test.ts client/web.ts client/files.tsx
```

With the Android keyboard-height fix, 1,116 tests pass and one existing test is skipped; the focused TypeScript check (now also with `client/files.tsx`) passes. No CI workflow exists. Unfiltered tests collect incomplete historical patch copies; the exclusion is required. There is no `tsconfig.json`; use the focused TypeScript command.

Run `sh patches/mobile-send-arrow/check.sh` in Git Bash to apply the patch to its original snapshots and compare every resulting byte with `modified/` and the repository. It retains scratch for inspection; set `TMPDIR` to the intended scratch folder. The affected predecessor checks (`chat-input-lag` and `reveal-in-explorer`) also pass and now follow this patch's original snapshots where appropriate, including `chat.tsx` and `files.tsx`. From a CRLF Windows checkout several older checks fail on line endings; run them on a `git archive HEAD` export.

## Try on the phone

In the Paseo Android app, with this branch installed and FirstMate reloaded, open the FirstMate chat, tap the composer and type several lines. Send should sit fully above the keyboard, with a little padding, and one tap should send. Dismiss and reopen the keyboard; switch keyboards (for example to emoji) and check Send is still clear. A gap of a status bar's height above the keyboard would mean the correction is too large on that phone; Send still under the keyboard would mean `StatusBar.currentHeight` reads zero there.

For the third fix, watch the suggestion strip. Tap the composer before typing, then type a word so the strip appears above the keys, and clear it again: Send should move up and down with the keyboard's top each time and stay fully visible and tappable. Also try the emoji panel, the clipboard or one-handed mode if the keyboard offers them. A gap the height of the strip that remains after it disappears, or Send hidden by exactly the strip, means the library's events are not reaching the plugin on that phone.

In a separate test installation of this branch, open FirstMate in Android Chrome or its installed web app, focus the composer and type several lines. Confirm Send and Attach remain above the keyboard and tappable; send a message. Dismiss and reopen the keyboard. Reopen it while scrolled up: the reading position should remain. Opening it at the end should retain the latest reply. Check desktop and iOS when available. Native-app behavior needs device confirmation because this reproduction exercises web.

## Reapply and undo

After the ten earlier patches, from the plugin directory (plain paths):

```text
git -c core.autocrlf=false apply --check <repo>/patches/mobile-send-arrow/mobile-send-arrow.patch
git -c core.autocrlf=false apply <repo>/patches/mobile-send-arrow/mobile-send-arrow.patch
```

To undo, reverse before chat input lag:

```text
git -c core.autocrlf=false apply --reverse --check <repo>/patches/mobile-send-arrow/mobile-send-arrow.patch
git -c core.autocrlf=false apply --reverse <repo>/patches/mobile-send-arrow/mobile-send-arrow.patch
```

Compare future upstream files with `original/` before reapplying. Reload only in an authorized installation. No stored data changes.
