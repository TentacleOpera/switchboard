# Board Toggles Render From Client Defaults, Because the Resync Snapshot Is a Second Hand-Written List

## Goal

A freshly loaded board panel must show the state the host actually holds. Today the connect-time
snapshot carries a hand-written subset of the pushes the refresh path sends, and every toggle the
subset misses renders from an optimistic client-side default — so the UI says ON while the host
routes OFF.

### Problem analysis

**Measured on the live board, 2026-09-17.** A browser client connecting to
`ws://localhost:7777/ws?panel=kanban` receives one `__resync` frame carrying exactly seven messages:

```
updateColumns · updateWorkspaceSelection · cliTriggersState · updateBoard
updateAutobanConfig · updatePairProgrammingMode · switchboardThemeNameSetting
```

Listening for a further 20 s on the same connection produced no other push.

**The refresh path sends more than that.** `KanbanProvider` (`~:2806-2825`) posts, in one run:

```
cliTriggersState · _postOverrideState() · _postFeatureWorkflowModeState()
dynamicComplexityRoutingState · allowUnknownComplexityAutoMoveState · collapseCodersState
```

Only `cliTriggersState` — the first line of that block — is also in the snapshot. The five that
follow it are not.

**The cause is two hand-maintained lists of "what a panel needs to know."**
`getFullStateMessages` (`KanbanProvider.ts:1558-1740`) builds the snapshot as a literal array of six
message objects. The refresh path builds its own sequence of `postMessage` calls. Nothing derives one
from the other and no test compares them, so a push added to the refresh path is simply absent from
the snapshot — silently, because both halves work in isolation and the gap only shows on a fresh
connection.

**The client turns a missing push into a confident wrong answer.** `src/webview/kanban.html:2995-3004`:

```js
let cliTriggersEnabled = true;
let dynamicComplexityRoutingEnabled = true;
let allowUnknownComplexityAutoMove = true;
let collapseCodersEnabled = true;
```

Each renders its toggle immediately (`:4286` for the routing button). The handler at `:7859-7860` is
`dynamicComplexityRoutingEnabled = msg.enabled !== false`, so an absent, malformed or partial push
also reads as ON. There is no "not yet known" state: **a default and a configured value are
indistinguishable**, on a read that decides routing. That is the failure mode named in the repo's
fallback rule, in the place it costs most.

**Live proof of the disagreement.** On this board every store says the feature is off —
`config.kanban.dynamicComplexityRoutingEnabled = 'false'`, `project_config` empty,
`standalone-state.json` holds no such key — and the host has only that one database open (verified
through `/proc/<pid>/fd`). The code default is `true` (`KanbanProvider.ts:610-613`). The operator's UI
shows the toggle **ON**. The router is off; the button says on.

**It also inverts the operator's next click.** `:8643` does
`dynamicComplexityRoutingEnabled = !dynamicComplexityRoutingEnabled` and posts the result. From a
falsely-ON toggle, clicking "off" posts `enabled: false` — the value it already had — and turning the
feature on takes two clicks, the first of which appears to turn it off. A control that lies about
state does not merely mislead; it sends the wrong command.

**Scope: this is a class, not a toggle.** Every state in that tail block has the same shape —
`_postOverrideState`, `_postFeatureWorkflowModeState`, `allowUnknownComplexityAutoMoveState`,
`collapseCodersState`. Fixing only `dynamicComplexityRoutingState` leaves four known instances and
the mechanism that produces the next one.

## Metadata

**Complexity:** 3
**Tags:** wshub, resync, kanban, webview, fallback-rule, standalone, bugfix
**Scope:** `KanbanProvider.getFullStateMessages` and the refresh push path, `wsHub`'s resync frame,
and the toggle initialisation in `src/webview/kanban.html`. Shared code that the standalone host
wires — the extension host is not the audit target and is being removed.

## Dependencies

None. Independent of the teams work.

## Proposed Changes

### 1. One list, not two

The snapshot and the refresh path must emit the **same set** of state messages. Derive them from one
declaration — a single table of `{ type, build(scope) }` that the refresh path iterates and the
snapshot renders — rather than a literal array in one place and a run of `postMessage` calls in the
other. A new board-state push then joins both by construction.

Board data (`updateBoard`, `updateColumns`) stays where it is; this is about the *settings* pushes
that follow it, which are cheap, small, and exactly the ones a panel cannot recompute.

### 2. A toggle renders "unknown", never an optimistic default

Initialise each toggle-backing variable to `undefined`/`null`, not `true`, and render a neutral or
disabled control until the host answers. A control the operator can click before its state is known
is a control that sends a command derived from a guess.

Replace `msg.enabled !== false` with an explicit boolean read that treats a missing or non-boolean
field as **unknown** rather than as ON, so a partial push cannot silently mean enabled.

Presentation defaults elsewhere are fine and stay — this rule is for controls that **write back**.
The test is the repo's: a wrong value here silently changes behaviour.

### 3. A contract test that compares the two emitters

Assert that the set of message `type`s produced by the refresh path is a subset of the snapshot's.
This is the gate that does not exist today and whose absence is why the divergence survived: both
halves pass their own tests, and only a fresh connection sees the gap.

Run `npm run compile-tests` before any `test:contract:*` script — contract suites run against `out/`.

### 4. Reconcile this board's stored value

Separately from the bug: `kanban.dynamicComplexityRoutingEnabled` is stored `false` on the reference
board while the shipped default is `true`. Once the toggle tells the truth the operator can set it
deliberately. **Do not "fix" the row as part of this plan** — the point is that the UI should have
shown its real value all along.

## Verification Plan

### Automated

- Connect a client to the hub and assert the `__resync` payload contains every settings push type the
  refresh path emits, by comparing the two emitters rather than against a hardcoded list.
- With `kanban.dynamicComplexityRoutingEnabled = false` stored, a freshly connected panel receives
  `dynamicComplexityRoutingState { enabled: false }` in its snapshot.
- A toggle whose state has not arrived renders neither ON nor OFF and does not post on click.
- A push carrying a missing or non-boolean `enabled` leaves the toggle unknown; it does not read ON.

### Goal invariants

- A panel never displays a toggle state the host did not send.
- No control writes back a value derived from a client-side default.
- Adding a board-state push reaches both the snapshot and the refresh path without a second edit.

### Manual

With routing stored `false`, hard-reload the board. The toggle reads OFF immediately — not ON, and
not ON-then-corrected. Click once: routing turns on, and the stored value becomes `true`.

## Outstanding Questions

- **[user]** Change 2 makes a not-yet-known toggle non-interactive for the moment before the snapshot
  lands. On loopback that is imperceptible; over a tailnet on a slow link it is briefly visible.
  Proceeding on the assumption that a briefly-disabled control beats a confidently-wrong one.
