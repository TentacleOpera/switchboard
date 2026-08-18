# Team Action Bar: Bulk Lifecycle and Roster Order

## Goal
Put the team-wide verbs an operator actually reaches for into the team cockpit's header: clear the whole team, close the whole team, restart missing members, and reorder the roster. Every one of these is currently a per-terminal chore repeated N times, or impossible.

### The problem, and the root cause
The panel has exactly two bulk verbs and both are fleet-wide. `clearAllTerminals` (`src/webview/terminals.js:7299`) POSTs `ptyClearAllTerminals` with an empty body — every terminal, no filter. `openAllTerminals` is the same shape. There is no scoped variant of either.

Scoping them was never possible because nothing could enumerate a team (see the team-identity plan). The pieces to compose from already exist and are per-terminal: `ptyClearTerminal` and `ptyCloseTerminal` are live verbs in both hosts (`src/standalone/ptyHost.ts:166`, `src/standalone/bootstrap.ts:1514`), and the sidebar row already wires clear (`terminals.js:2354`) and close (`terminals.js:2312`) to them one terminal at a time.

Roster order is a subtler gap. The group record carries an `order` array, written at spawn from `[headName, ...childNames]` (`src/services/teamWiring.ts:1035`) and honoured by the seating path — but **nothing can edit it**. The order a team seats in is therefore whatever order `spawnDelegates` happened to create children in, permanently. The sidebar sorts by `compareTerminals` (`terminals.js:3253`) instead, which orders by role tier and numeric suffix, so what the operator sees and what the grid seats disagree by construction.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, ui, ux, feature

## Dependencies
- **Team identity foundation** — enumerating members and knowing the head.
- **Team cockpit** — the header this bar lives in.

## Approach

### 1. Compose, do not add backend verbs
Build each bulk action client-side by iterating the team's `members` and calling the existing per-terminal verb. Reasons to prefer this over a `names[]` filter on `ptyClearAllTerminals`:
- The verb surface is implemented twice (extension host and standalone `bootstrap.ts`) plus mirrored in `TaskViewerProvider`'s verb interception (`TaskViewerProvider.ts:450`). One new parameter is three coordinated edits and a compatibility question for older panels; a client-side loop is none.
- Per-terminal results give per-member error reporting for free — "cleared 3 of 4, `coder-2` did not respond" instead of one opaque failure.

Bound the fan-out: issue at most 4 concurrent calls and report progress, so a nine-member team does not open nine simultaneous requests.

### 2. The actions
- **CLEAR TEAM** — `/clear` to every member. Reuse `withClearingFeedback` (`terminals.js:7325`) for the disable-and-relabel treatment so it matches the existing clear buttons.
- **CLEAR MEMBERS** — same, excluding the head. The head usually holds the orchestration context an operator does *not* want to lose; this is the verb they'll reach for most.
- **CLOSE TEAM** — end every member's process. Executes **immediately on click, with no confirmation dialog of any kind** — per CLAUDE.md this is non-negotiable, and `window.confirm()` is additionally a silent no-op in a VS Code webview, which would make the button do literally nothing. Offer undo-by-restart via the toast instead (`showPaneToast` already has an undo affordance, `terminals.html:2027`).
- **RESTART MISSING** — for a team whose members have partly exited, re-spawn only the dead ones from the definition's roster. Reuse the definition's member specs rather than cloning terminal names, so a restarted member gets its configured role, count, `label` and `startupCommand`.
- **CLEAR BADGES** — acknowledge every member's completion light at once. Cheap, and it is the natural counterpart to the aggregate done-light on the rail.

### 3. Roster order, editable
- Render the sidebar's team member list in `order` sequence (the team cockpit plan already specifies this).
- Make rows drag-to-reorder. On drop, write the new `order` back onto the group record via the existing `terminals.groups` save path, then re-seat.
- Preserve the head's position as authored — do not force it to index 0. If the operator wants the lead in the middle pane of a 1x3, that is a legitimate arrangement. Head-ness comes from the `head` field now, not from position (that is exactly why the field was added).
- `order` must stay a subset relationship with `members`: reordering never adds or drops names. Write it by permuting the existing array, never by rebuilding from the DOM, so a stale row cannot inject a dead name.

### 4. Where the bar lives
In the team cockpit header beside the icon and name. Buttons, not a menu — these are frequent actions and the whole complaint being answered is that they take too many clicks. Destructive and non-destructive actions get visually distinct treatment (the codebase already has `is-teal` for affirmative and a readonly/red state var, `terminals.html:1852`), but no confirm gates on either.

## Edge cases
- **Member exited.** Clear and close skip it silently; restart includes it. Do not report "failed" for a terminal that is legitimately dead.
- **Head exited, members alive.** All verbs still work. CLEAR MEMBERS with no live head is just CLEAR TEAM.
- **Member renamed mid-action.** The loop resolves names once at click. A rename landing mid-fan-out yields one miss; report it rather than retrying blindly.
- **Team re-spawned during a bulk action.** `wireSpawnedTeam` upserts `members` and `order` and treats the fresh spawn as the whole truth (`teamWiring.ts:1052`). An in-flight bulk action may therefore target a name no longer in the roster. Re-read the group at the start of each action and operate on that snapshot.
- **Reorder while a re-spawn is writing.** The `terminals.groups` save path is CAS-guarded by `baseIds` (`terminals.js:1494`) and the backend serialises through `mutateTerminalGroups` (`teamWiring.ts:156`). Let the guard reject the stale write and re-read; do not force it.
- **A definition that no longer exists.** RESTART MISSING has nothing to restart from. Disable it with a tooltip naming why, rather than failing on click.

## Verification Plan
1. `npm run compile` — clean.
2. Unit: the fan-out helper — respects the concurrency cap, aggregates per-member results, and reports partial success accurately.
3. Unit: CLEAR MEMBERS excludes exactly the `head` name and nothing else, including when the head sits mid-`order`.
4. Unit: reorder produces a permutation of the existing `order` — never adds, never drops, never reorders `members`.
5. Unit: RESTART MISSING computes the dead set from live status, not from `order` length.
6. **Grep assertion in CI:** no `confirm(`, `window.confirm(`, or `showWarningMessage` introduced anywhere in the touched files. CLAUDE.md records that a confirm gate previously broke the kanban delete-plan button outright; pin it rather than trusting review.
7. Manual, installed VSIX: 4-member team. CLEAR TEAM → all four show a cleared context. CLEAR MEMBERS → head's context intact, three cleared.
8. Manual: CLOSE TEAM ends all four immediately on one click, with no dialog. Toast offers restart; restart brings back the full roster with correct roles.
9. Manual: kill two members externally, then RESTART MISSING → exactly those two return, with their configured startup commands.
10. Manual: drag the roster into a new order, close and reopen the team window, confirm the order persisted and the grid seats in it. Confirm the main cockpit's group tab seats in the same new order.
11. Regression: fleet-wide CLEAR ALL still clears everything, including non-team terminals.
