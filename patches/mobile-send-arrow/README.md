# Mobile send arrow (local patch to FirstMate 0.4.0)

| Files | Patch file |
| --- | --- |
| `client/keyboard.ts`, `client/web.ts`, `client/chat.test.ts` modified; `client/keyboard.test.ts` new | `mobile-send-arrow.patch` |

Apply after the ten earlier patches. Base commit: `0875773` (current main); the three input files also match the original `7462568` task base. `original/` holds the three changed files before this patch; `modified/` holds all four resulting files. Test snapshots end in `.ts.txt` to keep archival copies out of test discovery; drop `.txt` when restoring them. The package remains **0.4.0**, as already landed on main.

**Problem.** `useKeyboardOverlap` returned zero on web. Android Chrome can shrink the visual viewport for its keyboard while leaving the layout viewport unchanged. The installed Paseo web shell uses full-height, overflow-hidden roots; its viewport meta tag does not request `interactive-widget=resizes-content`. React Native Web's `measureInWindow` reads the element's bounding rectangle. A pane ending at 800 with the visible bottom at 480 therefore retained its composer below the keyboard. The input has fixed height and the actions are in normal flow. This reproduces the browser path, not the phone's exact runtime.

**Change.** Measure the pane against `visualViewport.offsetTop + height` on mount, resize and scroll, using the existing overlap padding. A host-resized pane needs zero padding. Ignore pinch zoom, discard stale measurements, and remove listeners on unmount. Browser globals stay in `client/web.ts`. Native Android/iOS keyboard events and iOS animation retain their existing code. The existing chat effect follows the end only while pinned.

## Validation

Before the fix, two of four regression tests failed: `expected 800 to be less than or equal to 480`, and 0 instead of 240 for an already-open keyboard. All four passed afterward. Extended coverage checks dismissal, panning, host resizing, desktop/no-API fallback, pinch zoom, cleanup, native Android/iOS events, and the real chat's padding and pinned/away scrolling. Native measurements are mocked. Physical Android/iOS layout and tap hit-testing remain unverified. No installed plugin was changed or reloaded.

Use the test-only renderer setup in `patches/chat-input-lag/README.md`, then:

```powershell
npm test -- --exclude 'patches/**'
./node_modules/.bin/tsc.cmd --noEmit --jsx react-jsx --module esnext --moduleResolution bundler --target es2022 --lib es2022 --types node --skipLibCheck client/chat.tsx client/chat.test.ts client/keyboard.ts client/keyboard.test.ts client/web.ts
```

On current main, 1,109 tests pass and one existing test is skipped; the focused TypeScript check passes. No CI workflow exists. Unfiltered tests collect incomplete historical patch copies; the exclusion is required. There is no `tsconfig.json`; use the focused TypeScript command.

Run `sh patches/mobile-send-arrow/check.sh` in Git Bash to apply the patch to its original snapshots and compare every resulting byte with `modified/` and the repository. It retains scratch for inspection; set `TMPDIR` to the intended scratch folder. The affected predecessor checks (`chat-input-lag` and `reveal-in-explorer`) also pass and now follow this patch's original snapshots where appropriate.

## Try on the phone

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
