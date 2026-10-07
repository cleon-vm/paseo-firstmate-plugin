# Steer box click (local patch to FirstMate 0.2.1)

Fixes the steer box on a board card disappearing. The whole card was one pressable that toggled open and closed, and the steer box sat inside it, so a click in the box (to place the cursor, refocus or select text) bubbled up to the card and folded it, taking the box with it. The typed text survived and came back on reopening, which made it look random. Upstream FirstMate 0.3.2 has the same card code.

Now only the card's header (title, chips, summary, report, timing line) is pressable. The action buttons and the steer, relaunch and end box are siblings of it inside a plain `View` that carries the card's border and padding, so a press in them never reaches the toggle. Layout, spacing, the `cardMemory` behaviour and every other press are unchanged.

## Changed
- Modified: `client/card.tsx` (outer `View`, header `Pressable`, one new `header` style)
- New: `client/card.test.ts` (6 tests)

`original/` holds stock `client/card.tsx` as shipped in 0.2.1; `modified/` holds both files.

## Reapply after an npm update overwrites the plugin
From a shell in the installed plugin directory (`$P`, see `LOCAL-CHANGES.md`), checking first:
```
git -c core.autocrlf=false apply -p2 --directory=. --check <this-repo>/patches/steer-box-click/steer-box-click.patch
git -c core.autocrlf=false apply -p2 --directory=. <this-repo>/patches/steer-box-click/steer-box-click.patch
```
No other patch touches `client/card.tsx`, so this applies in any order. `.gitattributes` pins this folder to LF. If the update changed `card.tsx` and the check fails, copy `modified/client/card.tsx` over it only if upstream did not otherwise change the file, or redo the edit by hand: wrap the card in a `View` with `styles.card`, and put the title row through the timing line (and the backlog info row) in a `Pressable` with `onPress={() => setExpanded(!expanded)}`; the actions and the draft box stay outside it. Then `paseo plugin reload firstmate`.

## Restore
Copy `original/client/card.tsx` back into `$P`, delete `client/card.test.ts` if present, reload.

## Verify the patch
From the repository root: `sh patches/steer-box-click/check.sh`. It applies the patch to a copy of `original/`, checks the result is byte-identical to `modified/`, and that both files match the repository root (line endings ignored). Prints `ok: ...` and exits 0, or names each differing file and exits 1.

## Checks
`npm test -- --exclude 'patches/**'` runs `client/card.test.ts`, which renders the real `CrewCard` with `react-test-renderer` (installed without saving, as in `patches/chat-input-lag/README.md`). It models a click as reaching the nearest pressable at or above the target, as react-native-web does. Against stock `card.tsx`, the "press inside the box and its buttons" and "nothing above the box handles presses or keys" tests fail; with the patch all six pass. The tests cover: header toggles, box and buttons are outside the header, a press in the box keeps it open, a refresh with the same or newer data keeps the box, its node and its text, and Send posts the text. Real DOM bubbling was reproduced separately with react-dom and react-native-web; the card was not driven inside the Paseo window.
