# The Fleet Tab Blanks on a Half-Dead Host, Hides Its Own Staleness, and Loses Hop History on Restart

## Goal

The Fleet tab must distinguish "the board is unreachable" from "the pty host is down", must show how old its data is, and must not be the only record of why a hop fired.

### Problem analysis

Three reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. One surface, and the first two compound: the tab hides the information that would explain what it is showing.

> **Superseded:** The original triage cited `src/webview/shell.js` and `src/webview/shell.html` throughout.
> **Reason:** The Fleet tab logic has since been relocated. `refreshFleetTab`, `renderFleetOffline`, and the `dock-fleet-content` element now live in `src/webview/dock.js` and `src/webview/dock.html`. Every line reference below is updated to the current location; a coder following the original paths opens `shell.js` and finds nothing.
> **Replaced with:** All references below target `src/webview/dock.js`, `src/webview/dock.html`, and `src/services/TaskViewerProvider.ts` at their current line numbers.

## Metadata

- **Complexity:** 4
- **Tags:** shell, fleet, hops, bugfix
- **Project:** switchboard

## User Review Required

None. Change 3 is a schema addition and is the largest of the three.

## Complexity Audit

### Routine
- Changes 1 and 2 are render-layer fixes in `src/webview/dock.js` — per-source degradation and rendering an already-served `evaluatedAt` field.
- The 60s poll interval is confirmed at dock.js:501 (`60000`).

### Complex / Risky
- **Change 3 is a schema addition with a write/read path.** A new `hop_history` table in `KanbanDatabase.ts`, a write alongside the in-memory `_hopFeed`/`_hopLastReasons` updates in `TaskViewerProvider.ts`, and a read path so history survives restart. A table that is written but never read survives restart but is useless — the read path is mandatory, not optional. This is the largest change and can land independently of the other two.
- **Per-source degradation must not hide the hop reasons.** `renderFleetOffline` (dock.js:539-545) writes the hop-reason spans then hides `dock-fleet-content` — the div those spans live inside (dock.html:450 wraps :470/:477/:484). The fix must degrade per source without writing into a container it then hides.

## Edge-Case & Dependency Audit

**Race Conditions:** The 60s poll (dock.js:494-501) means the tab can be a minute stale. Rendering `evaluatedAt` (Change 2) shows the operator how stale, but the value itself only advances on each poll — a tab left on a hidden document does not refresh (dock.js:498 gates on `!document.hidden`). This is correct: no refresh while hidden, but the displayed age must reflect that.

**Security:** None. Hop reasons and feed entries are operator-facing diagnostics, not user input or privileged state.

**Side Effects:** Change 3 adds a migration. Per the users & migrations rule, hop history has only ever existed in unreleased dev work (in-memory only), so this is a clean break — no migration of existing data, no compat shim. Take the next free migration version at implementation time; do not reserve one.

**Dependencies & Conflicts:**
- Change 3 (schema) is independent of Changes 1 and 2 (render) and can land first or last.
- No other subtask in this feature touches `dock.js`, `dock.html`, or the hop-state path in `TaskViewerProvider.ts`, so there is no cross-subtask file conflict.

## Dependencies

- `sess_20260904_fleet_tab_relocation` — The Fleet tab moved from `shell.js`/`shell.html` to `dock.js`/`dock.html`. This plan targets the current location; no dependency on the relocation itself, only on knowing where the code is.

## Adversarial Synthesis

Key risks: (1) every file reference in the original plan pointed at `shell.js`/`shell.html`, which no longer contain the Fleet tab — a coder following the original plan finds nothing, the #1 defect; (2) `renderFleetOffline` writes hop-reason spans into `dock-fleet-content` then hides that same container, so the offline message is false in the case that matters (board up, pty host down) and the reasons it writes are invisible; (3) Change 3 was a "schema addition" with no schema, no columns, no retention policy, and no read path — a sketch, not a plan. Mitigations: all references retargeted to `dock.js`/`dock.html`; per-source degradation that does not hide the reasons; a concrete `hop_history` table schema with a retention policy and a mandatory read path.

## Proposed Changes

### 1. A live board with a dead pty host reports the board unreachable

`refreshFleetTab` (`dock.js:515-537`) has a single guard:

```js
if (!termRes || termRes.status !== 200 || !hopRes || hopRes.status !== 200) { renderFleetOffline(); return; }
```

Both `ptyListTerminals` and `getHopState` must return 200 or the tab renders nothing (dock.js:528-530).

`renderFleetOffline` (dock.js:539-545) then sets the three hop-reason spans (`dockHopPlanReason`/`dockHopCodeReason`/`dockHopReviewReason`) and hides `dock-fleet-content` — **the div those spans live inside** (`dock.html:450` wraps `:470`/`:477`/`:484`). So the reasons it just wrote are hidden by the same function, and the operator is left with "No running Switchboard instance reachable for this workspace." (`dock.html:448`).

That message is false in the case that matters: the board is running, the pty host is not.

**Fix.** Degrade per source rather than all-or-nothing:
- If `ptyListTerminals` fails but `getHopState` succeeds (or vice versa), render whichever source is available and show a per-source "unavailable" marker for the dead one — do not blank the whole tab.
- Do not write into a container you are about to hide. The hop-reason spans live inside `dock-fleet-content`; if you hide `dock-fleet-content`, the reasons are invisible. Either move the offline reasons outside `dock-fleet-content`, or render the degraded state inside `dock-fleet-content` (keeping it visible) with the dead source marked.
- When the board is up but the pty host is down, the message must say the pty host is down, not that the board is unreachable.

### 2. `evaluatedAt` is served and never rendered

`getHopState` returns `getHopFullState` verbatim (`TaskViewerProvider.ts:4217-4238` verb dispatch; `getHopFullState` at `:28966`), which carries `evaluatedAt` (`:28971`). `grep -c evaluatedAt src/webview/dock.js` returns 0 — the field is served and never rendered anywhere.

With a 60-second poll (dock.js:501), the tab can be a minute stale with nothing on screen saying so — and staleness is exactly what an operator needs to know when deciding whether a hop has stalled.

**Fix.** Render `evaluatedAt` in the Fleet tab as a "data age" / "last evaluated" indicator that updates as the poll runs. The value is already in the `getHopState` response; this is a render-layer change in `dock.js`.

### 3. Hop reasons and the feed die with the process

`_hopLastReasons` and `_hopFeed` are plain instance fields capped at 50 entries (`TaskViewerProvider.ts:2161` `_hopLastReasons`, `:2169` `_hopFeed`, cap at `:28886-28887`). No hop table exists in `KanbanDatabase.ts` (confirmed — no `hop_history` / `hop_reasons` table in the schema).

So the only record of why a hop fired or stopped is in memory, capped, and gone on restart. Anyone asking "why did this hop run last night" has no answer.

**Fix.** A schema addition rather than a render fix, which is why it is the largest of the three and can land independently. Take the next free migration version at implementation time; do not reserve one. Clean break — hop history has only ever existed in unreleased in-memory state, so no data migration.

**Schema** — add a `hop_history` table to `KanbanDatabase.ts`:

| column | type | notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | the feed entry id (matches `_hopFeed` entry id) |
| `timestamp` | INTEGER | ms epoch (matches `_hopFeed` entry timestamp) |
| `workspace_id` | TEXT | workspace scope |
| `hop_name` | TEXT | which hop: `plan` / `code` / `review` (or the hop kind) |
| `kind` | TEXT | `dispatch` / `finish` (matches `_hopFeed` kind) |
| `reason` | TEXT | the hop reason text (matches `_hopLastReasons` value) |

**Retention.** The in-memory cap was 50; the DB must retain more. Prune on write to a hard cap of N rows per workspace (e.g. 1000) AND a time-based TTL (e.g. 30 days), whichever binds first — so verification's "longer than 50 entries" holds and the table does not grow unbounded.

**Write path.** Alongside the in-memory `_hopFeed.unshift` / `_hopLastReasons` update in `TaskViewerProvider.ts` (around `:28885`), write a `hop_history` row. The in-memory cap stays for the live feed; the DB is the durable record.

**Read path (mandatory).** Add a read so history survives restart *and is queryable* — extend `getHopFullState` (or add a verb) to return recent `hop_history` rows for the workspace, and render them in the Fleet tab. A table that is written but never read survives restart but is useless; the read path is part of this change, not a follow-up.

## Verification Plan

### Automated Tests
- Add a test asserting the `hop_history` migration creates the table and that a write followed by a restart (re-open) reads back the entries — count exceeds 50 (the old in-memory cap).
- Add a test asserting the read path returns recent `hop_history` rows for a workspace.

### Goal Invariants
- Assert `renderFleetOffline` does not hide the hop-reason spans it writes (the spans remain visible in the degraded state), and that a dead pty host with a live board reports the pty host down — not "board unreachable".
- Assert `evaluatedAt` is rendered in the Fleet tab (a "data age" element exists and is populated from the `getHopState` response).
- Assert `hop_history` rows survive a restart and can be read back for a period longer than 50 entries.

### Manual Tests
1. Stop the pty host with the board running. The Fleet tab reports the pty host down and still renders board-derived state; it does not claim the board is unreachable.
2. The hop reason spans are visible in the degraded state, not written into a hidden container.
3. The tab shows how old its data is, and the value moves as the poll runs.
4. Hop reasons survive a restart and can be read back for a period longer than 50 entries.
