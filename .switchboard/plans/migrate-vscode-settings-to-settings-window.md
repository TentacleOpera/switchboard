# Stage 4 — Migrate VS Code Settings to the Settings Window

kanbanColumn: CREATED

## Goal

96 configuration keys are contributed to VS Code's settings UI via `package.json`. An extension that
is no longer the host cannot own them. Most should move to the settings window and its store. Keep
in `package.json` only what VS Code genuinely needs — how to find or launch the host. Every key that
moves needs a migration that reads the old value once, per the shipped-state rule.

### Problem analysis

**~4,000 installs have these settings configured.** Silently losing them is worse than any UI gain.
The migration must read each VS Code setting once, write it to the settings window's store, and
never read it again. A sentinel in the settings window's store records that the migration has run.

**The settings window plan is at `kanbanColumn: CREATED`.** Its write path (`POST /settings`,
`POST /pair`, `DELETE /pair`) was deleted during review and has not been re-delivered. This stage
cannot ship until that plan delivers a durable write surface.

## Metadata

- **Complexity:** 6
- **Tags:** refactor, ux

## User Review Required

None.

## Complexity Audit

### Routine

- Classifying each of the 96 keys as "stays in VS Code" (host discovery/launch only — estimated 2-5 keys) or "moves to the settings window" (~91 keys).
- Reading each VS Code setting once via `vscode.workspace.getConfiguration('switchboard')` and writing it to the settings window's store.

### Complex / Risky

- **Settings migration read window:** the migration reads each VS Code setting once and writes it to the settings window's store. If the user changes a VS Code setting after the migration runs but before the settings window is authoritative, the change is lost. The migration must run once on first launch after upgrade and record that it has run.
- **96 keys to classify and migrate.** Each must be individually classified — some are host behavior (move), some are VS Code-specific (stay), some may be deprecated (drop with migration). This is a cataloging effort, not a code change.
- **Blocked on the settings window plan.** The settings window plan (`settings-window-and-the-write-path-review-deleted.md`) is at `kanbanColumn: CREATED` with its write path un-delivered. This stage cannot start until that plan ships.

## Edge-Case & Dependency Audit

### Race Conditions

1. **Settings migration read window:** the migration reads each VS Code setting once and writes it to the settings window's store. If the user changes a VS Code setting after the migration runs but before the settings window is authoritative, the change is lost. The migration must run once on first launch after upgrade and record that it has run (a sentinel in the settings window's store, not in VS Code config — which may be uninstalled).

### Security

- No security implications. Settings are configuration values, not credentials. (Credentials are in `SecretStorage`, handled separately.)

### Side Effects

2. **~4,000 installs have these settings set.** Silently losing them is worse than any UI gain. The migration must be automatic and transparent — no manual step for the user.
3. **The settings window must be authoritative after migration.** Once the migration has run, the extension reads settings from the host's HTTP API, not from `vscode.workspace.getConfiguration()`. A setting changed in the settings window must reach the host; a setting changed in VS Code (if the key is still in `package.json`) must be ignored after migration.

### Dependencies & Conflicts

4. **Blocked on the settings window plan.** `settings-window-and-the-write-path-review-deleted.md` is at `kanbanColumn: CREATED`. Its write path was deleted during review and has not been re-delivered. This stage cannot ship until that plan delivers a durable write surface.
5. **Stage 2 must land first.** The extension must have stopped being a host before it makes sense to move settings to the host's settings window.

## Dependencies

- `settings-window-and-the-write-path-review-deleted.md` — must deliver a durable settings write surface before this stage can ship. Currently at CREATED with write path un-delivered.
- Stage 2 (extension stops being a host) — must land first. Same feature.

## Adversarial Synthesis

Key risks: the settings window plan is not delivered (this stage is blocked), and the migration read window can lose settings changed after migration. Mitigations: gate this stage on the settings window plan's delivery; run migration once with a sentinel to prevent re-running.

## Proposed Changes

### `package.json` (contributes.configuration)

- **Context:** 96 configuration keys under `switchboard.*` are contributed to VS Code's settings UI.
- **Logic:** Classify each key:
  - **Stays in VS Code** (estimated 2-5 keys): host URL/port, host binary path, auto-start preference. These are VS Code-specific because they tell the extension how to find or launch the host.
  - **Moves to settings window** (~91 keys): all host behavior settings — terminal, kanban, planner, theme, activity light, plan scanner, etc. These belong to the host, not the extension.
  - **Deprecated/dropped** (if any): keys that no longer have a reader. Migrate the value to the settings window (if a reader exists there) or drop it (if no reader exists anywhere).
- **Implementation:** Remove the moved keys from `package.json`'s `contributes.configuration.properties`. Keep only the stay keys.
- **Edge Cases:** Removing a key from `package.json` does not delete it from users' `settings.json` — the value persists but is ignored. The migration reads it before the key is removed from `package.json` (or on the first launch after the key is removed, while the value still exists in `settings.json`).

### `src/extension.ts` (migration on activation)

- **Context:** The extension's activation handler runs on first launch after upgrade.
- **Logic:** On activation, check the sentinel in the settings window's store. If the migration has not run:
  1. Read each of the ~91 moved keys from `vscode.workspace.getConfiguration('switchboard')`.
  2. Write each value to the settings window's store via the host's HTTP API (`POST /settings` or equivalent — depends on the settings window plan's delivery).
  3. Write the sentinel to the settings window's store.
  4. Log the migration (count of keys migrated, any keys that were unset).
- **Implementation:** A `migrateVsCodeSettings()` function called once during activation, gated on the sentinel.
- **Edge Cases:** If the host is not running, defer the migration until the host is available. If a key is unset in VS Code (user never configured it), skip it — do not write a default to the settings window (that would be a fallback indistinguishable from a configured value, violating the fallback rule).

### `src/extension.ts` (settings reads after migration)

- **Context:** After migration, the extension reads settings from the host's HTTP API, not from `vscode.workspace.getConfiguration()`.
- **Logic:** Replace `vscode.workspace.getConfiguration('switchboard').get(...)` calls with HTTP calls to the host's settings endpoint (`GET /settings` or equivalent).
- **Implementation:** A settings reader abstraction that fetches from the host. For the 2-5 keys that stay in VS Code, keep using `vscode.workspace.getConfiguration()`.
- **Edge Cases:** If the host is unreachable, the settings reader returns an explicit "unavailable" — not a fallback default.

## Verification Plan

### Automated Tests

> NOTE: Per the dispatching directive, compilation and automated tests are not executed in this
> review pass. The checks below remain written down for the implementer to run.

1. `npm run compile` — typecheck passes after Stage 4.
2. `npm test` — existing test suite passes.
3. `package.json`'s `contributes.configuration.properties` contains only the 2-5 host-discovery keys (not the 91 moved keys).

### Goal Invariants

- Assert `package.json`'s `contributes.configuration.properties` contains no more than 5 keys (only host discovery/launch).
- Assert the migration sentinel is written to the settings window's store after migration runs.
- Assert the migration does not re-run after the sentinel is set.

### Manual Verification

1. An upgrade from the current release leaves board data untouched.
2. Every migrated setting carries its previous value to the settings window.
3. The sidebar works on first launch with no manual step.
4. A setting changed in the settings window reaches the host.
5. A setting changed in VS Code (for a moved key) is ignored after migration.

## Outstanding Questions

- **[user]** This stage is blocked on the settings window plan (`settings-window-and-the-write-path-review-deleted.md`) delivering a durable write surface. Proceeding on the assumption that the settings window plan will be delivered before this stage starts — but it is currently at `kanbanColumn: CREATED` with the write path un-delivered.
