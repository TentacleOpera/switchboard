# The Terminals Panel Gets Tabs, and tmux Gets One of Its Own

## Goal

Split the Terminals panel into tabs — **Agents** (everything it does today) and **tmux** — and give the
tmux tab the settings, the live session list, and the copyable commands that currently exist only as
knowledge in the operator's head.

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

**Complexity:** 4
**Tags:** terminals, tmux, ui
**Dependencies:** none

## User Review Required

None.

## Proposed Changes

### 1. Tabs in the Terminals panel (`src/webview/terminals.html`, `terminals.js`)

- **Logic:** Two tabs — **Agents** (the existing view, unchanged and default) and **tmux**. Follow the
  house pattern from the eleven panels that already have tabs: `data-tab` attributes and the panel's
  own inline tab CSS.
- **Implementation:** `shared-tabs.css` is dead — every panel inlines its tab styles. Copy the idiom
  from a sibling rather than reviving the shared file.
- **Edge cases:** The Agents tab must be the default so nothing changes for an operator who never
  opens the tmux tab. Persist the active tab the way sibling panels do.

### 2. Move the enable toggle into the tmux tab

- **Logic:** `Enable tmux` leaves the top of the Agents action list and becomes the first control in
  the tmux tab. It still reads and writes `switchboard.terminal.tmux.enabled`.
- **Edge cases:** The key is absolute (`switchboard.terminal.*`), which `getSetting`/`saveSetting` only
  accept because the `switchboard.prompts.` prefix lock was removed. Do not reintroduce a prefix.

### 3. Show what is actually running

- **Logic:** List the board's tmux sessions — the team sessions, their windows, and which seat each
  per-seat view is pinned to. Read it from tmux, not from the registry: the registry records what the
  board believes, and the point of this list is to show what is true.
- **Edge cases:** tmux absent, or the setting off — say so plainly rather than rendering an empty list
  that looks like "no sessions".

### 4. Copyable commands, with the naming scheme stated

- **Logic:** Copy buttons for: attach to a team, attach to one seat, the grid recipe above, kill a
  session. Each rendered with the real names of what is running, not placeholders — the operator
  should never have to derive `lc-<team>-team-<role>` themselves.
- **Rationale:** The scheme is the thing nobody can guess. Showing real commands documents it.

### 5. A grid button

- **Logic:** One button per team that builds the dashboard window from the recipe above, then shows the
  attach command. This is the "auto-create the grid window" idea; a button is better than doing it on
  every team start, because the window costs nothing when unused but is noise when unwanted.
- **Edge cases:** Idempotent — a `grid` window that already exists is reused, not duplicated. Removing
  a seat leaves a dead pane; rebuild rather than patch.

## Verification Plan

### Automated Tests
- The Terminals panel renders two tabs; Agents is default and its existing controls are unchanged.
- The enable toggle appears once, in the tmux tab, and still round-trips
  `switchboard.terminal.tmux.enabled`.
- With tmux off, the tab explains that rather than showing an empty session list.
- The grid button is idempotent — pressing it twice yields one `grid` window.

### Goal Invariants
- Nothing about the Agents tab changes for an operator who ignores tmux.
- Every command shown is copy-paste runnable against the sessions that actually exist.
- The panel never shows a session list derived from the registry rather than from tmux.

### Manual
- Start a team, open the tmux tab, copy the team attach command, run it in an SSH client, confirm it
  lands on that team.
- Press the grid button, attach, confirm four live panes.

## Outstanding Questions

- None.
