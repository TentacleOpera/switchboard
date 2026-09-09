# The Terminals Panel Gets Tabs, and tmux Gets One of Its Own

## Goal

Split the Terminals panel into tabs — **Agents** (everything it does today) and **tmux** — and give the
tmux tab the settings, the live session list, and the copyable commands that currently exist only as
knowledge in the operator's head.

One row per team, not one per session. A four-seat team is five tmux sessions — a base plus one view
per seat — and listing all five reads as a leak. The tab shows the team, its seat count, and the one
attach command that is safe to hand a human.

### Problem analysis

tmux seating now works: a team is one session with a window per seat, each seat rendered in its own
board pane. But **every part of using it from outside the board is undiscoverable.**

- **The enable toggle is a bolt-on.** `Enable tmux` was added at the top of the Agents action list,
  above START ALL TEAMS, because there was nowhere else to put it. It is a settings control sitting in
  a column of action buttons.
- **The naming scheme is invisible.** To attach you must already know that a team is
  `lc-<team>-team`, an individual seat is `lc-<terminal>`, and a seat's private view is
  `lc-<team>-team-<role>`. Nothing in the UI says so.
- **The grid needs a five-line recipe.** A plain SSH client shows one seat, because the team is four
  *windows*, not four panes — that is deliberate (see below) but it means a 4-up view has to be
  constructed by hand.
- **Nothing lists what is running.** `tmux ls` is the only way to see which sessions the board owns.

Meanwhile **eleven sibling panels already have tabs** — planning, kanban, project, tickets, design,
setup, database, connections, linear, mission-control, implementation — and `terminals.html` has
**zero** (`grep -c 'data-tab=' src/webview/terminals.html` → 0). The panel has simply outgrown one
view.

#### Why the team is windows and not panes

Worth recording, because it is the constraint every option here has to respect.

A tmux **session has one current window, shared by every attached client.** When each seat's PTY
attached to `session:window`, whichever seat selected last dragged all the others onto its window —
the grid named lead/coder/coder/intern and rendered the same terminal four times.

**Session groups** fix it: grouped sessions share the window *list* but each keeps its own current
window. So the board gets isolation (one view per seat) and `tmux attach -t lc-coding-team` still
shows the whole team with `prefix n` cycling it.

That is why a human attaching sees one seat: **windows buy the board its isolation, panes would buy a
grid, and they pull in opposite directions.** A grid therefore has to be a separate window whose panes
nest-attach to the per-seat views.

#### The grid recipe, verified

```bash
G=lc-coding-team
tmux new-window -d -t $G -n grid "TMUX= tmux attach -t $G-lead"
for w in coder-1 coder-2 intern; do
  tmux split-window -d -t "$G:grid" "TMUX= tmux attach -t $G-$w"
done
tmux select-layout -t "$G:grid" tiled
tmux attach -t "$G:grid"
```

`TMUX=` is load-bearing: tmux refuses to attach from inside itself unless the variable is cleared.
Tested on a scratch socket — four panes, all alive, none dead.

Two caveats to surface in the UI, not bury: nested tmux means two prefixes (`Ctrl-b` reaches the outer
session, `Ctrl-b Ctrl-b` the inner), and closing the grid window detaches those views without killing
the seats.

## Metadata

**Complexity:** 6
**Tags:** ui, feature
**Dependencies:** none

## User Review Required

None.

## Complexity Audit

### Routine
- Adding two tabs to `terminals.html` by copying the inline `shared-tab-bar` / `shared-tab-btn` / `shared-tab-content` idiom from a sibling panel (e.g. `connections.html:82-121, 308-313`). Per repo convention (documented in `tickets.html:30-33`), every panel inlines its own tab CSS; the `shared-tabs.css` shared-stylesheet attempt was never linked by any panel and is not revived here.
- Moving the `#tmux-enabled` toggle (`terminals.html:2854-2858`) out of `.sidebar-ops` into the tmux tab. One existing `change` listener (`terminals.js:643-652`) reads/writes `switchboard.terminal.tmux.enabled` via `getSetting`/`saveSetting` (`terminals.js:1728`, `1752`); the move is a DOM transplant, the listener wiring is unchanged.
- Persisting the active tab the way sibling panels do; Agents is the default so an operator who never opens the tmux tab sees no change.

### Complex / Risky
- **Backend read path is absent in the extension host.** `TaskViewerProvider` (the extension composition root) serves only `ptyListTerminals`, forwarded to the Go PTY host via `_ptyHostVerb` (`TaskViewerProvider.ts:664`). It has **no tmux-listing verb**. The standalone root has `tmuxListPanes` (`bootstrap.ts:3441`) backed by `listTmuxPanes()` (`tmuxBackend.ts:251`), but the extension root has nothing equivalent. The session list and grid button are unreachable in the extension host until a tmux read/exec verb is wired in **both** roots — the standalone-parity trap (verb-reachability audits stay green while a composition-root seam is missing).
- **`#{session_group}` is not queried anywhere.** The plan's base-session identification ("group the rows by `#{session_group}` and mark the member whose name equals the group") has no input today: `tmuxBackend.ts:227` `PANE_FORMAT` captures `pane_id, session_name, window_index, window_name, pane_index, pane_title, pane_current_command, pane_current_path, pane_pid` — no `session_group`. `grep -rn 'session_group' src/` returns nothing. The format must be extended (or a separate `list-sessions -F` query added) before the base session can be identified.
- **No grid-build verb exists in either host.** The standalone tmux verbs are `tmuxListPanes`, `tmuxAdoptPane`, `tmuxReleasePane`, `tmuxClearPane` (`bootstrap.ts:3441-3500`) — all pane-adoption, none window-building. The grid button needs a verb that runs `new-window`/`split-window`/`select-layout` (not `attach` — the board cannot attach; that line is for the human's SSH client) and returns the attach string.
- **Idempotency of the grid recipe is not free.** `tmux new-window -n grid` does not fail if a window named `grid` already exists (tmux permits duplicate window names), so the un-guarded recipe pressed twice yields two `grid` windows. The recipe needs a `tmux has-session`/window-existence guard, the same pattern `goPtyFleetProjection.ts:258` already uses for seats.

## Edge-Case & Dependency Audit

- **Race Conditions:** The session list is a point-in-time read of `tmux list-panes`/`list-sessions`. A seat starting or releasing while the list is open produces stale rows until refresh. Mitigation: refresh on tab focus and on an explicit refresh button; do not poll (polling races team start/stop and burns CPU). The grid-build verb must guard on window existence (see Complex/Risky) so a double-click or a concurrent team-start cannot duplicate the `grid` window.
- **Security:** The grid-build verb executes `tmux new-window`/`split-window`/`select-layout` with a team name derived from the request. The team name reaches a shell command string, so it must be validated against the same naming constraint the seating code uses (`deriveTmuxSessionName`, `lc-<slug>-team`) — never interpolated raw. The verb is RCE-grade and rides the existing `/terminals/verb/` auth rail; it must not accept an arbitrary command body.
- **Side Effects:** Building the `grid` window creates a real tmux window on the team session; closing it detaches the nested views without killing seats (already a documented caveat to surface in the UI). Removing a seat mid-grid leaves a dead pane; the rebuild path kills+recreates the `grid` window rather than patching panes.
- **Dependencies & Conflicts:** tmux absent, or `switchboard.terminal.tmux.enabled` off — the tab explains this plainly rather than rendering an empty list that reads as "no sessions". The tab must not depend on the registry for its session list (the registry records what the board believes; the point is what is true). The existing `tmuxListPanes` verb merges `tmuxFleetService.listActive()` for `adopted`/`role` — that registry-coupled data is fine for the pane-adoption surface but must NOT feed the session list, which is tmux-derived only.

## Dependencies

- none

## Adversarial Synthesis

Key risks: (1) the tmux tab's session list and grid button depend on backend verbs that do not exist in the extension host (`TaskViewerProvider` has no tmux verb) and are incomplete in standalone (`tmuxListPanes` captures no `#{session_group}`), so the feature can pass its own UI checks while being unreachable in VS Code; (2) the base-session identification and the grid idempotency both rest on data/behavior the plan assumes but the code does not yet provide. Mitigations: extend `PANE_FORMAT` with `#{session_group}`; add a `tmuxListSessions` (grouped, tmux-only) verb and a `tmuxBuildGrid` verb, wired in **both** `bootstrap.ts` and `TaskViewerProvider` (diff the two composition roots by hand — the verb-reachability audit will not catch a missing seam); guard the grid recipe with a window-existence check.

## Proposed Changes

### 1. Tabs in the Terminals panel (`src/webview/terminals.html`, `src/webview/terminals.js`)

- **Context:** `terminals.html` currently has zero `data-tab=` attributes. Eleven sibling panels already use tabs. The house pattern is the inline `shared-tab-bar` / `shared-tab-btn` / `shared-tab-content` idiom (copy from `connections.html:82-121` for the CSS and `connections.html:308-317` for the markup).
- **Logic:** Two tabs — **Agents** (the existing view, unchanged and default) and **tmux**. The Agents tab wraps the existing sidebar/ops/terminal-grid; the tmux tab wraps the new controls (sections 2-5).
- **Implementation:** Add the inline tab CSS and a `.shared-tab-bar` with two `.shared-tab-btn[data-tab=agents|tmux]` buttons, plus two `.shared-tab-content` panels. Wire tab switching in `terminals.js` mirroring the sibling pattern. Persist the active tab the way siblings do.
- **Edge cases:** Agents is the default so nothing changes for an operator who never opens the tmux tab.

> **Note (not a supersession — a convention confirmation):** The original plan stated "shared-tabs.css is dead — every panel inlines its tab styles. Copy the idiom from a sibling rather than reviving the shared file." Verified correct against the repo: `tickets.html:30-33` documents this as the repo convention ("the one shared-stylesheet attempt (the dead SHARED_TABS_CSS_URI wiring) was never linked by any panel"), and `connections.html:82-121` inlines its own `.shared-tab-btn` CSS rather than linking `shared-tabs.css`. The shared file is not deleted; it is simply not used here.

### 2. Move the enable toggle into the tmux tab

- **Context:** The toggle is at `terminals.html:2854-2858` inside `.sidebar-ops` (which begins ~line 2846), above START ALL TEAMS (`terminals.html:2861`). Its listener is at `terminals.js:643-652`.
- **Logic:** `Enable tmux` leaves the top of the Agents action list and becomes the first control in the tmux tab. It still reads and writes `switchboard.terminal.tmux.enabled` via the same `getSetting`/`saveSetting` calls (`terminals.js:1728`, `1752`).
- **Edge cases:** The key is absolute (`switchboard.terminal.*`), which `getSetting`/`saveSetting` only accept because the `switchboard.prompts.` prefix lock was removed. Do not reintroduce a prefix.

### 3. Show what is actually running — backend read verb (BOTH hosts)

- **Context:** No `/tmux` HTTP endpoint exists; tmux verbs ride `/terminals/verb/<name>`. The standalone root has `tmuxListPanes` (`bootstrap.ts:3441`) but the extension root (`TaskViewerProvider`) has **no tmux verb at all** — only `ptyListTerminals` forwarded to the Go PTY host. `tmuxBackend.ts:227` `PANE_FORMAT` captures no `#{session_group}`.
- **Logic:** List the board's tmux sessions — the team sessions, their windows, and which seat each per-seat view is pinned to. Read it from tmux, not from the registry: the registry records what the board believes, and the point of this list is to show what is true.
- **Implementation:**
  - **Standalone (`src/standalone/tmuxBackend.ts`, `bootstrap.ts`):** Extend `PANE_FORMAT` (`tmuxBackend.ts:227`) to include `#{session_group}`. Add (or derive from the extended pane list) a grouped session view: rows grouped by `session_group`, each row carrying the group name, the member session names, and a flag marking the member whose `session_name` equals its `session_group` (the base — the only safe attach point). Expose it as a new `tmuxListSessions` verb on `/terminals/verb/` alongside `tmuxListPanes`. Do NOT reuse `tmuxListPanes`'s `adopted`/`role` merge for this list — that is registry data for the adoption surface, not the session list.
  - **Extension (`src/services/TaskViewerProvider.ts`):** Add the matching `tmuxListSessions` verb arm. The extension host runs tmux locally (the Go PTY host shells out to tmux via the seat startup command, `goPtyFleetProjection.ts:258-261`), so the verb shells out to `tmux list-panes -a -F` / `tmux list-sessions -F` directly — it does NOT route through the Go PTY host (which has no listing verb and would create the asymmetry the parity rule forbids). Wire it on the same `/terminals/verb/` rail the standalone arm uses.
- **Edge cases:** tmux absent, or the setting off — say so plainly rather than rendering an empty list that looks like "no sessions". Identifying the base: group by `#{session_group}` and mark the member whose name equals the group. Do not pattern-match `-lead` / `-coder-1` suffixes; the suffix is derived from a window slug and a role fallback (`goPtyFleetProjection.ts:248-250`), so it is not a reliable key.

### 4. Copyable commands — the TEAM command only

- **Context:** Rendered in the tmux tab from the live `tmuxListSessions` result (section 3).
- **Logic:** Copy buttons for: attach to a team, the grid recipe (section 5), kill a session. Rendered with the real names of what is running, not placeholders.
- **Do NOT offer a per-seat attach command.** A seat's view session is the session a board pane is attached to, and `status` is a session option with no per-client override. Two consequences follow, and both argue for hiding the views:
  - Attaching to a view shares its current-window pointer with that pane, so paging the window list changes what the board pane displays until you page back.
  - The view sessions are created with `status off` (`goPtyFleetProjection.ts:270`), precisely so the board panes carry no duplicate navigation. A human attaching to one gets no window list at all, which is the worst of both.

  The base session — the one whose `session_name` equals its `session_group` — has no board pane on it and keeps its strip. That is the only attach point a human should be handed.
- **Rationale:** the naming scheme is unguessable, but publishing all of it invites the operator into the two sessions that misbehave when they arrive. Publish the team, keep the views internal.
- **Edge cases:** If the base session cannot be identified (e.g. `session_group` empty because the session predates grouping), show the team attach with a note rather than guessing a seat.

### 5. A grid button — backend build verb (BOTH hosts)

- **Context:** No grid-build verb exists in either host. The standalone tmux verbs are pane-adoption only (`bootstrap.ts:3441-3500`).
- **Logic:** One button per team that builds the dashboard window from the recipe above, then shows the attach command. This is the "auto-create the grid window" idea; a button is better than doing it on every team start, because the window costs nothing when unused but is noise when unwanted.
- **Implementation:** Add a `tmuxBuildGrid` verb on `/terminals/verb/` in **both** `bootstrap.ts` (standalone) and `TaskViewerProvider.ts` (extension). The verb runs `tmux new-window` / `tmux split-window` / `tmux select-layout` for the panes — it does NOT run `tmux attach` (the board cannot attach; that line is returned as the copyable string for the human's SSH client). The team name is validated against `deriveTmuxSessionName` semantics before interpolation into any tmux command string.
- **Edge cases:** Idempotent — guard with a window-existence check (`tmux has-session -t <team>:grid` / `list-windows -F '#{window_name}'`), the same guard pattern `goPtyFleetProjection.ts:258` uses for seats; a `grid` window that already exists is reused (killed and rebuilt, not duplicated — `tmux new-window -n grid` permits duplicate names, so a naive re-run makes two). Removing a seat leaves a dead pane; rebuild rather than patch.

## Verification Plan

### Automated Tests
- The Terminals panel renders two tabs; Agents is default and its existing controls are unchanged.
- The enable toggle appears once, in the tmux tab, and still round-trips `switchboard.terminal.tmux.enabled`.
- With tmux off, the tab explains that rather than showing an empty session list.
- The grid button is idempotent — pressing it twice yields one `grid` window (guarded, not duplicated).
- `tmuxListSessions` returns rows grouped by `session_group` with the base member flagged, in **both** the standalone and extension hosts.
- `tmuxBuildGrid` is wired in **both** `bootstrap.ts` and `TaskViewerProvider.ts` (manual composition-root diff — the verb-reachability audit does not cover this).

### Goal Invariants
- Nothing about the Agents tab changes for an operator who ignores tmux.
- Every command shown is copy-paste runnable against the sessions that actually exist.
- The panel never shows a session list derived from the registry rather than from tmux.
- The `#tmux-enabled` toggle is **absent** from the Agents `.sidebar-ops` action list (negative) and **present** once in the tmux tab (positive) — the goal moves it, so the move is asserted both ways.
- `tmuxListSessions` and `tmuxBuildGrid` are resolvable on `/terminals/verb/` in **both** hosts (positive), and absent from the `/kanban/verb/` rail (negative — tmux verbs are `/terminals/verb/` only, per `bootstrap.ts:3437`).

### Manual
- Start a team, open the tmux tab, copy the team attach command, run it in an SSH client, confirm it lands on that team.
- Press the grid button, attach, confirm four live panes.
- Repeat the grid button press; confirm still one `grid` window (idempotency).
- Repeat the session-list and grid-button checks in **both** the VS Code extension host and the standalone/npx host.

## Outstanding Questions

- **[user]** This plan covers two independently-shippable phases — Phase A (tabs + toggle move, pure UI, no backend) and Phase B (session list + copyable commands + grid button, requiring new tmux verbs in both hosts). Splitting into two plan files (or promoting to a feature via `create-feature-from-plans`) would let Phase A ship immediately while Phase B's backend parity work is scoped separately. Proceeding on the assumption that the plan is kept as one and strengthened in place; the split is the user's call.
- **[user]** In the extension host, the new `tmuxListSessions`/`tmuxBuildGrid` verbs shell out to the local `tmux` binary directly (the Go PTY host has no listing verb and routing through it would break parity). Proceeding on the assumption that direct local tmux invocation is acceptable in the extension host, matching how the standalone host's `listTmuxPanes` already operates.

---

## Completion Summary

Implemented both phases. Phase A: split the Terminals panel into Agents (default, unchanged) and tmux tabs via the inlined `shared-tab-bar`/`shared-tab-btn`/`shared-tab-content` idiom (terminals.html), moved the `#tmux-enabled` toggle out of `.sidebar-ops` into the tmux tab, and wired tab switching + persistence (`terminals.activeTab`) in terminals.js with the bar hidden in solo/kanban/team-scoped modes. Phase B: extended `PANE_FORMAT` with `#{session_group}` and added `listTmuxSessions` (grouped, base-flagged, registry-free) plus `buildTmuxGrid` (idempotent via window-existence guard, team-name validated against the `deriveTmuxSessionName` charset) in tmuxBackend.ts; wired `tmuxListSessions` and `tmuxBuildGrid` verbs on `/terminals/verb/` in BOTH bootstrap.ts (standalone, gated on `tmuxReady`) and TaskViewerProvider.ts (extension, shells out to local tmux directly before the `ptyHostReady` guard, mirroring standalone). The tmux tab renders one row per team with copyable attach/kill commands and a grid button that builds the 4-up window and copies the attach command. Per-seat views are not offered as attach targets (status off + shared current-window pointer). Compilation and tests skipped per directive.

