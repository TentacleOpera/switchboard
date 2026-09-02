# A terminal you cannot see keeps streaming, parsing and holding a renderer

## Goal

Stop feeding pty output to terminals that are not in a rendered pane, and resume them from the
gateway's replay ring on reattach — so the cost of the grid scales with what is **on screen**
rather than with every seat the operator has ever opened.

### Problem Analysis

A terminal view, once built, stays fully live for the life of the page even when nothing renders it.
Four costs are paid per such terminal, on every client, continuously:

1. **The WebSocket stays open.** `ws.close()` appears in exactly one place — `destroyTerminalView`
   (`terminals.js`). Nothing else closes a terminal socket, and there is no `visibilitychange`
   handler for terminal sockets anywhere in the file.
2. **The VT parser keeps running.** `flushBatch` guards only on `entry.disposed || !entry.term`
   (`terminals.js:10708`); it never asks whether the container is in the document. So `term.write()`
   parses every frame and mutates buffers nobody is looking at.
3. **A WebGL context stays held.** `liveWebglContexts` is decremented only through the holder's
   `release()`, called from teardown paths. The per-document cap is 12 (`terminals.js:491`), and the
   browser's real cap is per renderer *process*, shared with any pop-out.
4. **The pane's container is detached, not destroyed.** `renderPaneGrid` drops surplus panes and the
   comment is explicit: a removed pane's terminal container "goes with the subtree and is left
   detached … and stays referenced by `terminalsMap`" (`terminals.js:5945-5951`).

**And the existing teardown timer cannot reclaim any of it.** `armDetachTimer` fires after
`DETACH_GRACE_MS` (300000, `terminals.js:483`) but calls `destroyTerminalView` only when the terminal
is **exited** (`terminals.js:509-514`) — deliberately, to preserve xterm scrollback. Worse, the timer
usually never arms at all: `paneAssignments` is padded to `getMaxSlotCount()` (nine) and deliberately
never trimmed, so a terminal parked in slot 5 while the layout is `1` is still *assigned*
(`terminals.js:5960-5964`) and takes the `cancelDetachTimer` branch.

The observable consequence: narrowing a 3x3 to a single pane stops eight renderers from painting but
leaves eight sockets streaming and eight parsers running. On a remote board that is eight redundant
streams over the tunnel; on any board it is eight agent CLIs' worth of parse and buffer churn on the
client's main thread, to render one.

### Root Cause

The view lifecycle was designed to keep xterm scrollback across a view switch, and **preserving the
xterm was conflated with preserving the stream**. They are separable: the gateway already ships a
resume protocol — `?lastSeq=` on the upgrade URL (`terminalWsGateway.ts:1142`), backed by the 256 KB
replay ring — which is what reconnect already uses. That protocol makes the live socket unnecessary
for history; only the *ring* is.

### Non-goals

- **Do not destroy views.** A 3x3 → 1 → 3x3 round trip must stay instant, which is what the padded
  `paneAssignments` protects.
- **Do not narrow `paneAssignments`.** The padding is deliberate and documented; the rendered-slot
  question is answered by slicing at read time, not by trimming the array.
- **Not a fix for the visible pane's latency.** Compression, idle-frame suppression and echo
  quantization are separate plans.
- No new gateway constructor argument or setter — see Both Hosts.

## Metadata

**Topic:** Terminal streams are suspended when no pane renders them
**Complexity:** 6
**Tags:** terminals, performance, webview, standalone, remote

## User Review Required

None. The suspend predicate, the resume path and the gap-reporting behaviour are all specified below.

## Dependencies

None. `?lastSeq=` resume, the replay ring, `replayGap` detection and `writeReplay` all ship today.

`the-grid-renders-agents-not-terminals.md` depends on THIS plan — a status pane is a pane whose
terminal is suspended, so this is the mechanism that feature consumes. This plan is useful on its own
and must not wait for it.

## Both Hosts

`TerminalWsGateway` is constructed at **two** composition roots and both must keep working:

- **standalone** — in-process, `bootstrap.ts:3202`, gated on `ptyReady`
- **extension** — a separate pty-host sidecar, `ptyHost.ts:46`; the terminals page is told where to
  connect via `data-pty-host-origin="ws://127.0.0.1:<port>"` (`TaskViewerProvider.ts`)

`terminals.js` and `terminalWsGateway.ts` are shared by both, so a change *inside* either file
reaches both hosts with no wiring. **That is the reason this plan must not add a constructor argument
or a setter.** Those have two call sites and `ptyHost.ts` is demonstrably the one that gets forgotten:
`setBindPolicy` is wired in `bootstrap.ts:3599` and nowhere in `ptyHost.ts` today.

## Proposed Changes

**1. A rendered-slot predicate (`terminals.js`).**

A terminal is *live* when its name appears in `paneAssignments.slice(0, getSlotCount(effectiveLayout))`
**and** `isRendered(entry.container)`. The slice is the existing precedent — the fit ladder already
does exactly this and its comment states the slice is load-bearing precisely because
`paneAssignments` is padded (`terminals.js:8067`).

**2. Suspend on live → not-live.**

Close `entry.ws` (keeping `entry.lastSeq`), call the renderer holder's `release()`, and stop enqueuing
batches for the entry. **Keep `entry.term` and its buffer** — the xterm is not disposed, so nothing
about view-switch speed changes for the panes that stay rendered.

**3. Resume on not-live → live.**

Reconnect with `?lastSeq=<entry.lastSeq>`, reattach a renderer via `attachRenderer`, and write the
replay through the existing `writeReplay` (which already handles answerback suppression and applies
`pendingModes` at the correct boundary).

**4. Report a gap instead of showing a hole.**

The ring evicts at `MAX_SCROLLBACK_BYTES`, so a long suspension can outlive its own history. The
gateway already computes `replayGap` and the client already tracks `terminalReplayGaps`; surface it on
the pane when a *suspended* reattach missed frames. A silent hole in a pane the operator just
un-suspended is the one regression this plan could introduce, and it is already detectable.

**5. Leave the sidebar and rail unchanged.**

Liveness, badges and the activity light are driven by `fleetList` / `ptyListTerminals` polling and WS
pushes, not by a terminal's own socket. A suspended seat must still show its light — verify, do not
assume.

## Verification Plan

1. Open nine terminals in a 3x3, then switch to layout `1`. Assert eight sockets close: check
   `__sbTerminalStats()` and the gateway's client count for that terminal.
2. Switch back to 3x3. All eight panes repopulate from replay, with scrollback intact and no visible
   reset.
3. Suspend a seat, let it produce more than `MAX_SCROLLBACK_BYTES` of output, then resume. The pane
   reports a replay gap rather than rendering a seamless-looking hole.
4. `bytesWritten` in `__sbTerminalStats()` stops advancing for a suspended entry and resumes after
   reattach.
5. A suspended seat's sidebar activity light, DONE badge and plan strip continue to update.
6. Type into a pane immediately after it resumes; input is delivered, not dropped by
   `notifyInputDropped`.
7. WebGL: suspend eight of nine seats and confirm `liveWebglContexts` falls; resume and confirm the
   panes come back on WebGL rather than silently on canvas (`isWebgl` in stats).
8. **Both hosts:** run 1-4 against `switchboard local` (in-process gateway) and against the VS Code
   extension with its pty-host sidecar. Confirm no new constructor argument or setter was introduced
   at either root.

### Goal Invariants

- Assert `flushBatch` (or its caller) declines to write for an entry outside the rendered slot range.
- Assert `ws.close()` is reachable from a suspend path, not only from `destroyTerminalView`.
- Assert `entry.term` is NOT disposed on suspend — a 3x3 → 1 → 3x3 round trip still needs no rebuild.
- Assert the reconnect on resume carries `lastSeq` > 0 when frames were received before suspension.
- Assert `paneAssignments` is still padded to `getMaxSlotCount()` and is never trimmed by this change.
- Assert no new argument on `new TerminalWsGateway(...)` at either `bootstrap.ts:3202` or `ptyHost.ts:46`.
