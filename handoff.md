# Mobile drawer swipe issue handoff

## Status

Unresolved as of July 23, 2026.

The user confirmed that the issue still persists after commit
`a4a5ee3434515c67f9e69ee62ea58187f2285068` (`Fix mobile drawer gestures over
chat`). The exposed little sidebar sliver can be dragged successfully, but a
normal drag beginning in the affected chat content still does not open the
sidebar, no matter how far it is pulled.

This document records the problem and prior attempts. No additional fix was
made while preparing this handoff.

## User-reported behavior

- Earlier user reporting identified the problem on mobile when thinking mode
  was off; that observation is retained here for comparison.
- In the updated report, the issue occurs after messaging with thinking mode
  enabled as well.
- Swiping normally from affected chat content does not open or close the
  conversation-history drawer as intended, even with a very long drag.
- Dragging the exposed little sidebar sliver does work, but this is only an
  edge workaround and not normal swipe-anywhere behavior.
- During the failed gesture, the conversation window visibly jiggles left and
  right.
- The message/composer bar fixed at the bottom does not move with the
  conversation window.
- Holding or beginning the gesture at the edge can make the drawer open
  properly, but that is only a workaround. Normal left/right swiping should
  work.

## Expected behavior

- A horizontal swipe in the supported chat area should progressively move the
  history drawer and settle it open or closed.
- The conversation viewport should not rubber-band or jiggle independently of
  the fixed composer.
- The user should not have to hold the screen edge to activate the drawer.
- Vertical transcript scrolling and interactions inside the composer should
  continue to work normally.

## Relevant implementation

The drawer gesture state and pointer handlers are in `app/page.tsx`:

- `DRAWER_DIRECTION_LOCK_PX`
- `DRAWER_OPEN_THRESHOLD`
- `DRAWER_GESTURE_IGNORE_SELECTOR`
- `beginDrawerGesture`
- `updateDrawerGesture`
- `cancelDrawerGesture`
- `finishDrawerGesture`
- `drawerGestureRef`
- `drawerProgressRef`
- `drawerDragProgress`

The handlers are attached to:

- `.chat-area`
- `.sidebar`
- `.sidebar-scrim`

Important behavior in the current implementation:

- Only touch pointer events participate.
- Gesture direction is initially pending and locks after 8 px.
- `preventDefault()` and pointer capture happen only after the gesture locks as
  horizontal.
- Drawer progress is calculated from horizontal distance divided by sidebar
  width.
- The drawer settles using a 25% progress threshold.
- Composer and other interactive targets are excluded through
  `DRAWER_GESTURE_IGNORE_SELECTOR`.

Relevant mobile layout styles are in `app/globals.css`:

- `.app-shell`
- `.chat-area`
- `.transcript`
- `.sidebar`
- `.sidebar-scrim`
- `.composer-wrap`

The composer uses `position: fixed` on mobile. This explains why the composer
can remain stationary while the conversation region visibly jiggles, but it
does not explain what is producing the unwanted conversation movement.

## Attempts that did not resolve the issue

### `105cfc2ea35c74831079cc99ff1fe6c982e875f3` — Fix mobile drawer swipe overscroll

Commit `105cfc2ea35c74831079cc99ff1fe6c982e875f3` added:

- `overflow-x: clip` to `.app-shell`
- `overscroll-behavior-x: none` to `.chat-area`
- `overscroll-behavior-x: none` to `.transcript`
- `touch-action: pan-y` to the mobile `.sidebar` and `.sidebar-scrim`
- source-level test assertions for those declarations

It also refactored the repeated scrim class check into a local `isScrim`
variable without intentionally changing gesture behavior.

The assumption was that native horizontal overscroll/rubber-banding was
competing with the JavaScript drawer gesture. The user subsequently confirmed
that the symptom remains, so that assumption or the selected containment
targets were incomplete.

### `a4a5ee3434515c67f9e69ee62ea58187f2285068` — Fix mobile drawer gestures over chat

This follow-up attempted to make gestures over rendered assistant content
reachable and less likely to be stolen by nested interactions. It:

- restricted handling to the primary touch pointer and prevented overlapping
  drawer gestures;
- captured the pointer on the reasoning summary or the current gesture
  target, released it on completion/cancel/lost capture, and explicitly
  abandoned vertical gestures;
- allowed reasoning-summary drags while suppressing the click that can follow
  a horizontal drag;
- added Markdown code-block, table, and KaTeX targets to the ignore selector;
- added `touch-action` declarations for the transcript, reasoning content,
  and horizontally scrollable rendered content; and
- added source-level assertions covering pointer capture, click suppression,
  gesture abandonment, and those styles.

The latest user retest shows that this attempt also did not resolve normal
swiping from chat content. The successful exposed-sliver drag should not be
treated as evidence that swipe-anywhere activation works.

An earlier draft considered limiting drawer opening to a 36 px left-edge
region. That change was deliberately removed before commit because it would
make the user's current edge workaround mandatory and conflict with the
expected swipe-anywhere behavior.

## Validation already performed

The prior attempt passed:

- `npm run lint` with one pre-existing `react-hooks/exhaustive-deps` warning at
  `app/page.tsx:413`
- `npm run build`
- `node --test tests/rendered-html.test.mjs` (13 tests)

These checks do not reproduce real pointer sequences or mobile browser gesture
arbitration. The drawer test in `tests/rendered-html.test.mjs` only inspects
source and CSS with regular expressions.

After `a4a5ee3`, the same automated checks still passed: `npm run lint` (one
pre-existing `react-hooks/exhaustive-deps` warning at `app/page.tsx:420`),
`npm run build`, and `node --test tests/rendered-html.test.mjs` (13 tests).
They validate source/build invariants but do not reproduce the affected device
gesture, so their success does not contradict the user's report.

Per repository instructions, no browser or screenshot verification was
performed.

## Suggested investigation areas

These are leads, not confirmed causes:

1. Determine which element is actually moving during the jiggle by inspecting
   computed transforms, scroll offsets, visual viewport movement, and drawer
   progress during a real affected gesture.
2. Check whether pointer events are cancelled or never reach
   `updateDrawerGesture` when thinking mode is off.
3. Compare the rendered message subtree and event targets for thinking-on and
   thinking-off assistant responses, especially the conditional waiting and
   reasoning blocks in `app/page.tsx`.
4. Investigate whether waiting for the 8 px direction lock before calling
   `preventDefault()` and `setPointerCapture()` allows the browser or a nested
   scroll container to claim the gesture first.
5. Verify whether `touch-action: pan-y` on `.chat-area` and `.message-pair`
   behaves consistently on the affected device/browser and whether a child
   element overrides gesture arbitration.
6. Add gesture-level tests that exercise pointer down, move, up, cancel,
   direction locking, pointer capture, progress, and settle behavior. The
   existing regex test cannot detect an inverted or unreachable gesture path.
7. Preserve normal swipe-anywhere opening unless product intent is explicitly
   changed. Do not treat edge-only activation as the desired fix.

## Repository state at handoff

- Branch: `main`
- Last attempted-fix commit:
  `a4a5ee3434515c67f9e69ee62ea58187f2285068`
- User instruction for this handoff: document the persistent problem; do not
  attempt another fix.
