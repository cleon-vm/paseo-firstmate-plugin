# Steer box click (local patch to FirstMate 0.4.0)

Fixes the steer box on a board card disappearing. The whole card was one pressable that toggled open and closed, and the steer box sat inside it, so a click in the box (to place the cursor, refocus or select text) bubbled up to the card and folded it, taking the box with it. The typed text survived and came back on reopening, which made it look random. Upstream FirstMate 0.3.4 still has the same card structure. Upstream 0.4.0 split the card into an outer `View` and a pressable, but only to keep its new Answer box out of the pressable; the action buttons and the steer, relaunch and end box are still inside it, and its own `AGENTS.md` notes that a click in them folds the card on a compact web layout.

Now only the card's header (title, chips, summary, report, timing line) is pressable. The action buttons and the steer, relaunch and end box are siblings of it inside a plain `View` that carries the card's border and padding, so a press in them never reaches the toggle. Layout, spacing, the `cardMemory` behaviour and every other press are unchanged.

## Changed
- Modified: `client/card.tsx` (the crew actions and the draft box moved out of upstream's pressable into a sibling `View`, one new `below` style)
- New: `client/card.test.ts` (6 tests)

`original/` holds stock `client/card.tsx` as shipped in 0.4.0; `modified/` holds both files.

**Re-cut on 0.3.4.** First cut on 0.2.1. Upstream 0.3.3 moved the card's styles to its type scale (`FONT_SIZE.body` for the title, `caption` for meta lines, `small` for the report, link and prompt), and the hunk that adds the `header` style had the old numeric sizes as context, so the old patch failed at `card.tsx:115`. The edit was redone on upstream's card, keeping upstream's sizes: the header wrapper and the outer `View` are unchanged from the 0.2.1 cut, and the new `header` style (`gap: 6`) has no text size of its own.

**Re-cut on 0.4.0.** Upstream 0.4.0 rewrote the card's root the same way this patch did (a `View` holding a pressable, with a `press` style carrying the padding), adds a row of `(actions: …)` buttons under the captain's call and an Answer box below the pressable, and takes a new required `toMate` prop. `git merge-file` conflicted in five hunks, so the edit was redone by hand on upstream's card: the opener, Steer, Interrupt, Relaunch and End buttons and the draft box sit in a new `below` view after the pressable (the card's horizontal and bottom padding, `gap: 6`); the backlog info line stays in the header, as before. The pressable's bottom padding drops to 6 when that view is open, as upstream does for the Answer box, and the view's own bottom padding drops to 6 when the Answer box follows it. The `(actions: …)` buttons stay inside the header, as upstream has them: each is its own pressable, which takes the click. `client/card.test.ts` passes `toMate: null`, which draws neither the buttons nor the Answer box; its six tests pass, and against stock 0.4.0 `card.tsx` the two that check the box and buttons sit outside the header fail. The new layout was not looked at in Paseo.

## Reapply after an npm update overwrites the plugin
From a shell in the installed plugin directory (`$P`, see `LOCAL-CHANGES.md`), checking first:
```
git -c core.autocrlf=false apply -p2 --directory=. --check <this-repo>/patches/steer-box-click/steer-box-click.patch
git -c core.autocrlf=false apply -p2 --directory=. <this-repo>/patches/steer-box-click/steer-box-click.patch
```
No other patch touches `client/card.tsx`, so this applies in any order. `.gitattributes` pins this folder to LF. If the update changed `card.tsx` and the check fails, copy `modified/client/card.tsx` over it only if upstream did not otherwise change the file, or redo the edit by hand: keep the title row through the timing line (and the backlog info row) in the `Pressable` with `onPress={() => setExpanded(!expanded)}`, and move the crew actions and the draft box out of it, into a `View` after it. Then `paseo plugin reload firstmate`.

## Restore
Copy `original/client/card.tsx` back into `$P`, delete `client/card.test.ts` if present, reload.

## Verify the patch
From the repository root: `sh patches/steer-box-click/check.sh`. It applies the patch to a copy of `original/`, checks the result is byte-identical to `modified/`, and that both files match the repository root (line endings ignored). Prints `ok: ...` and exits 0, or names each differing file and exits 1. The scratch copy is kept for inspection.

## Checks
`npm test -- --exclude 'patches/**'` runs `client/card.test.ts`, which renders the real `CrewCard` with `react-test-renderer` (installed without saving, as in `patches/chat-input-lag/README.md`). It models a click as reaching the nearest pressable at or above the target, as react-native-web does. Against stock `card.tsx` (0.2.1, and again 0.3.4), the "press inside the box and its buttons" and "nothing above the box handles presses or keys" tests fail; with the patch all six pass. The tests cover: header toggles, box and buttons are outside the header, a press in the box keeps it open, a refresh with the same or newer data keeps the box, its node and its text, and Send posts the text. Real DOM bubbling was reproduced separately with react-dom and react-native-web; the card was not driven inside the Paseo window.
