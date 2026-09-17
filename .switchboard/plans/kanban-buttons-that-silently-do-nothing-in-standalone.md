# Ten Kanban Buttons Reach an Unbridged Command in Standalone — One Reverts the Work It Just Did

## Goal

Every kanban control must either **work** on the standalone host or be **visibly unavailable**. Today
ten of them dispatch a VS Code command that standalone never registered; the shim returns `undefined`
without throwing, so the arms report success, one counts failures as successes, and one reads the
`undefined` as "restore failed" and rolls back the database changes it had already committed.

### Problem analysis

**The verb audit is green, as always.** All 72 message types `src/webview/kanban.html` posts have a
handler in `src/services` or `src/standalone`. Nothing is unreachable. The divergence is one layer
down, exactly where `CLAUDE.md` says to look.

**The mechanism.** Provider arms reach the host through the `commands` seam. `vscodeShim`'s
`executeCommand` (`src/standalone/vscodeShim.ts:560-566`) is a deliberate dead end that warns once per
id and returns `undefined`:

```
[headless] command 'X' is not bridged — the calling arm's side effect did not happen
```

Its own comment states the hazard: *"VscodeHostCommands swallows exceptions and returns undefined, so
without this line an arm whose whole payoff is a command succeeds silently."* The warning diagnoses;
it does not stop the arm from returning `{ success: true }`.

**Measured, 2026-09-17.** `bootstrap.ts` registers **21** ids into `switchboardCommandRegistry`.
`KanbanProvider` dispatches **15**. **Ten are unbridged:**

| webview message | command | what actually happens in standalone |
| :--- | :--- | :--- |
| `uncompleteCard` | `restorePlanFromKanban` + `kanbanBackwardMove` | **Self-reverts.** See below. |
| `recoverSelected` | `restorePlanFromKanban` | Counts every plan as recovered, toasts *"↩ Recovered N plan(s)"*, restores none. |
| `batchDispatchLow` | `batchDispatchLow` | Whole arm body is the command. Returns `success: true`. Nothing dispatched. |
| `recoverAll` | `restorePlanFromKanban` | Never reaches it — confirm gate cancels first (below). |
| `createPlan` | `initiatePlan` | `createIfMissing()` runs, then nothing. Returns `success: true`. |
| `codeMapSelected` | `analystMapFromKanban` | Never reaches it — confirm gate cancels first. |
| `setPairProgrammingMode` | `setPairProgrammingModeFromKanban` | Mode persists locally; `TaskViewerProvider` never learns it, so pairing never engages. |
| `completePlan` | `completePlanFromKanban` | Completion itself lands (DB writes precede the call); the command's side effect does not. |
| `moveSelected` / `moveAll` | `kanbanForwardMove` | Conditional — the `else` arm only. See below. |
| `ready` | `fullSync` | Fires on every panel open. Needs a decision, not necessarily a fix. |

**The worst one actively undoes correct work.** `uncompleteCard`
(`KanbanProvider.ts:13335-13356`) writes the card's new column, cascades the feature, schedules the
plan-state write — and then:

```ts
const ok = await this._seams().commands.executeCommand<boolean>('switchboard.restorePlanFromKanban', planId, workspaceRoot);
if (ok) { … successCount++; }
else { /* Rollback DB changes if restore failed */ await db.updateStatus(sessionId, 'completed'); … }
```

`undefined` is falsy, so standalone always takes the rollback branch. The card un-completes, then
immediately re-completes. The operator sees a button that flickers and does nothing, and the
rollback is *correct code* reading a missing bridge as a failed restore. Nothing is logged as an
error.

**Two of them are confirm gates, which this repo bans outright.** `recoverAll`
(`:12155`) and `codeMapConfirm` (`:13827`) gate on
`this._seams().ui.showWarningMessage(msg, 'Recover', 'Cancel')`. The headless implementation is
`async () => undefined` (`hostServices.ts:397`, `vscodeShim.ts:206`), so `confirm !== 'Recover'` is
always true and the arm returns *"Cancelled"* every time. These are the modal `showWarningMessage`
confirms `CLAUDE.md` prohibits — *"Delete buttons delete immediately… no modal
`showWarningMessage`"* — and they are dead in the host that ships. **Delete the gates; do not port
them.** That fixes the ban violation and the dead button in one edit.

**`moveSelected` / `moveAll` are a narrower case, not a broken move.** The command sits in the `else`
arm at `:12468` and `:12597`; the primary path is `dispatchConfiguredKanbanColumnAction`. The gap
opens only when the column's `dragDropMode` is not `'prompt'` and `_boardMoveCliTriggersEnabled` is
false. Card movement works; one configuration of it silently does not.

**`ready` → `fullSync` may be redundant rather than missing.** Its comment reads *"Initial load:
trigger full file→DB sync to ensure DB is populated."* `bootstrap.ts` registers no `fullSync` and
starts no equivalent, but plans reach the standalone board through the plan watcher, which is a
file→DB path of its own. This one needs a decision — bridge it, or record that the watcher supersedes
it — not a reflex fix.

**The correct pattern already exists in this very file.** `addCoderTerminal` (`:13955-13965`) is the
eleventh dispatch site and is *not* on the list above, because someone handled it:

> *"this arm exists so the button is not a dead click on the extension host; standalone reports
> `terminalCreateAvailable: false` and disables it."*

`kanban.html:4415` renders that `+` disabled with the tooltip *"Creating terminals requires a terminal
host (unavailable here)."* That is the shape every arm below should take when bridging is not
wanted: **a capability flag and a disabled control**, never a live button over a dead command.

## Metadata

**Complexity:** 4
**Tags:** standalone, kanban, divergence, command-bridge, silent-failure, bugfix
**Scope:** `bootstrap.ts`'s command registration block, the affected `KanbanProvider` arms, and the
capability flags `kanban.html` already reads. The extension host is not the target — it is being
removed, and every one of these works there today.

## Dependencies

**Subset of `feature_plan_20260811160001_audit-command-seam-62-unbridged-commands-swallowed`
(Planned).** That card owns the mechanism across the whole codebase — *"196 call sites, 77 distinct
command ids, 11 registered in standalone"* — and owns making an unbridged command **fail loudly**
instead of returning `undefined`, plus the ratchet that stops the dead count growing. This plan is
the **kanban slice**: which operator-facing buttons are affected, what each one actually does when
the command is missing, and bridge-or-disable per arm. It adds consequence analysis the audit does
not carry; it must not re-implement the audit's ratchet.

**Its headline numbers have drifted again.** Measured 2026-09-17: `bootstrap.ts` registers **21**
ids, not 11. The audit's own superseded block already records one such re-measure; this is a second.
The ratchet it proposes is the fix for that drift, which is another reason this plan should not
carry its own.

**Sibling:** `board-toggles-render-from-client-defaults-because-resync-is-a-second-list` — same
shape, different channel: a missing signal read as a confident value.

## Proposed Changes

### 1. Stop `uncompleteCard` reverting itself

Fix this first and separately — it is the only arm that destroys correct work. Either bridge
`restorePlanFromKanban` in standalone, or make the rollback branch fire on an explicit failure rather
than on a falsy return. **`undefined` must not mean "it failed"** when it also means "nobody
answered"; distinguishing the two is the repo's fallback rule applied to a command result.

### 2. Decide bridge-or-disable for each remaining arm

Per arm, one of two outcomes — never a third:

- **Bridge it** — register the id in `bootstrap.ts` alongside the 21 already there, with the standalone
  implementation of that behaviour.
- **Disable it** — report a capability flag in the board payload and have `kanban.html` render the
  control disabled with a reason, exactly as `terminalCreateAvailable` does for the coder `+`.

Arms whose entire body is the command (`batchDispatchLow`, `createPlan`) must stop returning
`{ success: true }` either way. An arm that did nothing must not claim it did.

### 3. Fix the false success in `recoverSelected` / `recoverAll`

`recovered++` runs after an await that neither throws nor reports, so the count is the loop length
and the toast is fiction. Count actual restores, and surface the failure when there are none.

### 4. Delete the two confirm gates

`recoverAll` (`:12155`) and `codeMapConfirm` (`:13827`). Banned by `CLAUDE.md`, and dead in
standalone. Remove the gate; the action runs immediately.

### 5. Feed the audit's ratchet, do not build a second one

The command-seam audit owns the drift gate. This plan supplies what that gate needs for the kanban
surface: for each id here, the classification (bridged / disabled-with-flag) and, where disabled, the
capability flag name. No separate contract test — two ratchets on one seam is the two-lists problem
this plan exists to clean up.

## Verification Plan

### Automated

- Every id `KanbanProvider` dispatches is registered in `bootstrap.ts` or classified by the audit's
  allowlist; each disabled-with-flag id names the capability flag that disables its control.
- `uncompleteCard` on standalone leaves the card un-completed — assert the final DB state, not the
  return value.
- `recoverSelected` with nothing restorable reports zero recovered and does not toast a success.
- `batchDispatchLow` and `createPlan` do not return `success: true` when their command is unbridged.
- No `showWarningMessage` call in `KanbanProvider` passes choice items.
- Run `npm run compile-tests` before any `test:contract:*` script — contract suites run against `out/`.

### Goal invariants

- No kanban control is both clickable and incapable.
- No arm reports success for work a missing bridge prevented.
- A `undefined` command result is never read as a business failure.

### Manual

On the standalone host with the board's stdout visible, click each control in the table. The terminal
prints one `[headless] command … is not bridged` line per unbridged id, first use only — that log is
the ground truth for this plan and should fall silent when it is done.

## Outstanding Questions

- **[user]** `ready` → `fullSync`: bridge it, or record that the plan watcher supersedes the file→DB
  sync on standalone and drop the call? Proceeding on the assumption that the watcher covers it and
  the call is extension-only, but this is a data-integrity path and worth an explicit answer.
- **[user]** For arms chosen as "disable rather than bridge", the board payload needs a capability
  flag per control. `terminalCreateAvailable` sets the precedent for one; naming four or five more
  invites a single `capabilities: {}` object instead. Proceeding with one object rather than one flag
  per button.
