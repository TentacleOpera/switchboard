# SQL Write Guardrail — Prevent Agents from Writing to kanban.db Directly

## Goal

Close four layers of the bypass that lets agents write to `kanban.db` directly via `sqlite3` (without `-readonly`), which silently corrupts board state because the extension's in-memory sql.js copy overwrites external writes on the next `_persist()` cycle. The fix makes direct DB writes impossible for Claude Code agents (allowlist), deters other agents (skill warnings), and makes bypass visible when it slips through (extension warning).

## Metadata

**Complexity:** 4
**Tags:** backend, security, reliability, refactor
**Project:** Browser Switchboard

## User Review Required

No user review required — the changes are defense-in-depth guardrails with well-understood scope. The allowlist narrowing is the only change that could break existing agent workflows, and it only blocks non-readonly sqlite3 (which no legitimate skill uses).

## Complexity Audit

### Routine
- Adding `-readonly` to sqlite3 commands in skill documentation files
- Adding guardrail warning text to skill files
- Auditing `move-card.js` fallback gating (confirmed correct — no change needed)
- The `ClaudeCodeMirrorService` allowlist change is a single-string replacement

### Complex / Risky
- The allowlist glob pattern `Bash(sqlite3 -readonly *)` must correctly match legitimate query commands — if the glob doesn't match, all sqlite3 queries are blocked (denial-of-service on query skills)
- The extension-level warning in `_reloadIfStale` must coexist with the existing `showInformationMessage` in `_initialize` (line 6702) without confusing dual notifications
- The throttle mechanism needs careful state management (static, per-DB-path) to work correctly in multi-IDE scenarios
- Both `.agents/skills/` and `.claude/skills/` directories contain separate copies of every skill file — both must be updated or the fix is incomplete for Claude Code agents

## Problem

Agents with shell access can write to `kanban.db` directly via `sqlite3` (without `-readonly`). This bypasses every piece of extension logic: event dispatch, feature cascade, integration sync, the move↔dispatch coupling. The behavior contracts say "the extension is the sole `kanban.db` writer," but nothing enforces it — and agents take the shortcut when the API path is inconvenient.

The extension uses `sql.js` (SQLite compiled to WASM) — it loads the DB into memory, mutates it, and writes it back via `_persist()`. When an external process writes to `kanban.db`, `_reloadIfStale` (KanbanDatabase.ts:6595) detects the mtime change, flushes the extension's in-memory copy to disk (overwriting the external write), and reloads. **External writes are silently discarded** — the agent's changes vanish without warning, and the agent may make decisions based on stale state.

Multiple gaps enable this:

1. `create-feature-from-plans` skill uses `sqlite3` without `-readonly` for SELECT queries — normalizes non-readonly access
2. `ClaudeCodeMirrorService` allowlists `Bash(sqlite3 *)` — any sqlite3 command is permitted
3. `_reloadIfStale` detects external writes but only logs a console message — no user-visible warning
4. No skill explicitly forbids direct DB writes with enough force to override an agent's instinct to take shortcuts

## Root Cause

There is no single root cause — this is a defense-in-depth gap with multiple layers missing. The fix requires closing each layer.

## Proposed Changes

### Layer 1 — Skill cleanup: eliminate non-readonly sqlite3 from all skills

> **Critical:** Both `.agents/skills/` and `.claude/skills/` directories contain separate copies of every skill file (not symlinks — verified). Claude Code reads from `.claude/skills/`. Both copies MUST be updated or the fix is invisible to the host that needs it most.

**`create-feature-from-plans` skill** (`.agents/skills/create-feature-from-plans/SKILL.md` lines 37, 77, 84 **and** `.claude/skills/create-feature-from-plans/SKILL.md` lines 42, 82, 89):
- Change all `sqlite3 {{WORKSPACE_ROOT}}/.switchboard/kanban.db` to `sqlite3 -readonly "{{WORKSPACE_ROOT}}/.switchboard/kanban.db"`
- Add a note at the top of the Prerequisites section: "All sqlite3 queries in this skill are READ-ONLY. Never run sqlite3 without `-readonly` on kanban.db — the extension's in-memory copy will silently overwrite your changes."

**`query-switchboard-kanban` skill** (`.agents/skills/query-switchboard-kanban/SKILL.md` and `.claude/skills/query-switchboard-kanban/SKILL.md`):
- Already uses `sqlite3 -readonly` — no change needed. Verified both copies.

**`query_switchboard_kanban.md`** (`.agents/skills/query_switchboard_kanban.md`):
- Already uses `sqlite3 -readonly` — no change needed. Verified.

**`query-kanban-plans` skill** (`.agents/skills/query-kanban-plans/SKILL.md` and `.claude/skills/query-kanban-plans/SKILL.md`):
- Does not use `sqlite3` at all (uses the API via curl). No change needed. Verified.

**`improve-feature` skill** (`.agents/skills/improve-feature/SKILL.md` **and** `.claude/skills/improve-feature/SKILL.md`):
- Add a prominent guardrail box: "NEVER write to kanban.db directly via sqlite3, INSERT, UPDATE, or DELETE. The extension uses sql.js (in-memory WASM SQLite) and will silently overwrite external writes on the next `_persist()` cycle. All card moves go through `move-card.js` (local) or the provider API (remote)."

**`rearrange-feature` skill** (`.agents/skills/rearrange-feature/SKILL.md` **and** `.claude/skills/rearrange-feature/SKILL.md`):
- Already says "Never write `kanban.db` or `kanban-state-*.md` directly" (line 59). Strengthen by adding the "silent overwrite" explanation.

**`switchboard-contracts` skill** (`.agents/skills/switchboard-contracts/SKILL.md` **and** `.claude/skills/switchboard-contracts/SKILL.md`):
- Contract #7 (line 68) already says "the extension is the sole `kanban.db` writer." Add the mechanism: "The extension uses sql.js (in-memory WASM SQLite) and persists on a debounce. External writes to kanban.db are detected by `_reloadIfStale` (mtime check) and silently overwritten — the external write is lost. This is by design: the in-memory copy is the source of truth."

### Layer 2 — ClaudeCodeMirrorService allowlist narrowing

**`ClaudeCodeMirrorService.ts`** (src/services/ClaudeCodeMirrorService.ts:280):
- Change `'Bash(sqlite3 *)'` to `'Bash(sqlite3 -readonly *)'` in `SWITCHBOARD_ALLOW_ENTRIES`
- This prevents Claude Code agents from running sqlite3 without `-readonly`
- The query skills all use `-readonly`, so this won't break legitimate queries
- If an agent needs a non-readonly sqlite3 (it shouldn't), it will be blocked and forced to use the API

**Risk:** Claude Code's permission system uses glob matching. Verify that `Bash(sqlite3 -readonly *)` correctly matches commands like `sqlite3 -readonly "$DB_PATH" "SELECT ..."`. If the glob doesn't match because of the flag ordering, test and adjust the pattern. Fallback pattern if needed: `Bash(sqlite3 -readonly*)` (no space before `*`).

### Layer 3 — Extension-level external-write warning

**`KanbanDatabase._reloadIfStale`** (src/services/KanbanDatabase.ts:6595):
- Currently logs: `[KanbanDatabase] External modification detected (mtime X → Y). Reloading from disk.` (line 6621)
- Enhance to fire a VS Code warning notification when an external write is detected:
  - "Switchboard detected an external write to kanban.db. The extension's in-memory state has been preserved and the external write was discarded. If an agent wrote to the database directly, use the API (move-card.js / POST /kanban/move) instead."
  - Use `vscode.window.showWarningMessage` — per the project rule "NEVER add confirmation dialogs," this must be a dismissible warning, NOT a modal. `showWarningMessage` with no buttons (just the dismiss "OK") is fine — it's informational, not a confirm gate.
  - Use the same lazy-require pattern as the existing notification in `_initialize` (line 6702): `const vscode = require('vscode'); vscode.window.showWarningMessage(...)` wrapped in try/catch to handle non-extension-host contexts.

**Existing notification acknowledgment:** `KanbanDatabase._initialize()` (line 6702) already shows a `vscode.window.showInformationMessage` when it detects an external modification during initialization (cloud-sync scenario). The new warning in `_reloadIfStale` is for runtime detection (while the extension is running). These are different code paths:
  - `_initialize` — fires once at startup if the DB was modified while the extension was closed. Informational, cloud-sync wording.
  - `_reloadIfStale` — fires during runtime when an external process writes while the extension is active. Warning, agent-write wording.
  The dual-path is intentional: startup-time and runtime detections serve different diagnostic purposes. Document this in a code comment.

**Throttle:** Add a static `Map<dbPath, lastWarningMs>` on `KanbanDatabase` to throttle warnings — max one warning per 30 seconds per DB path. This is static (not per-instance) so multi-IDE scenarios don't double-fire: the first instance to detect the write fires the warning, and the throttle prevents the second instance from firing within the 30-second window.

**Consideration:** The warning fires for ALL external writes, including legitimate ones (another IDE instance, the `move-card.js` direct DB fallback when the extension isn't running). Since `_reloadIfStale` only fires when the extension IS running (it's called from `ensureReady`), the `move-card.js` direct fallback won't trigger it (that path only runs when the extension is NOT reachable). Multi-IDE scenarios are rare and the warning is informational, so this is acceptable.

### Layer 4 — move-card.js direct DB fallback audit

**`move-card.js`** (`.agents/skills/kanban_operations/move-card.js`):
- The direct DB fallback (Path 2, line 132) uses `KanbanDatabase.forWorkspace()` — it creates a separate in-memory instance and calls `_persist()`. This is safe when the extension is NOT running (no conflict).
- When the extension IS running, the API path (Path 1) is used and the fallback never fires (line 184-191: if the extension is reachable but the move fails, the script exits with FAILED — it does NOT fall back to direct DB).
- No change needed. The fallback is correctly gated. Verified.

## Edge-Case & Dependency Audit

1. **Multi-IDE workspace:** Two VS Code windows open on the same workspace. Both have `KanbanDatabase` instances. When one writes, the other's `_reloadIfStale` detects the mtime change and reloads. The warning would fire in the second IDE. This is correct — the second IDE should know about the external write. The static throttle (per-DB-path) prevents double-firing across instances.

2. **`move-card.js` direct fallback while extension is starting up.** If the extension is in the process of starting (port file exists but `/health` fails), `move-card.js` will fall back to direct DB. When the extension finishes starting, its `_reloadIfStale` will detect the external write and reload. The warning fires. This is correct — the user should know the fallback was used.

3. **Claude Code allowlist pattern matching.** `Bash(sqlite3 -readonly *)` must match `sqlite3 -readonly "/path/to/kanban.db" "SELECT ..."`. Claude Code's permission system uses glob patterns where `*` matches any string. This should work, but verify with a test. If it doesn't match, try `Bash(sqlite3 -readonly*)` (no space before `*`).

4. **Other agents (Devin, Cursor, etc.).** The ClaudeCodeMirrorService allowlist only applies to Claude Code. Devin and other terminal-based agents have no allowlist restriction. For these, the skill-level warnings (Layer 1) and the extension-level warning (Layer 3) are the only guards. This is acceptable — the skill warnings are forceful, and the extension warning makes the problem visible.

5. **`query-kanban-plans` skill.** Verified: does not use `sqlite3` at all (uses the API via curl). No change needed.

6. **Skills that use `node` to run kanban_operations scripts.** The `Bash(node *)` allowlist entry allows running `move-card.js` etc. These scripts use the `KanbanDatabase` class (not raw sqlite3), so they're safe. No change needed.

7. **`.claude/skills/` copies.** All skill files exist as separate copies (not symlinks) in `.claude/skills/`. Claude Code reads from `.claude/skills/`. Both copies must be updated for every skill change in Layer 1. Verified: `.claude/skills/create-feature-from-plans/SKILL.md` has the same sqlite3-without-readonly issue at lines 42, 82, 89.

8. **Dual notification paths.** `_initialize` (line 6702) shows an information message for startup-time external modification detection. `_reloadIfStale` (line 6595) will show a warning for runtime detection. These are different scenarios (startup vs runtime) and different severities (info vs warning). The dual-path is intentional and documented in the code comment.

## Dependencies

- None — this is a self-contained set of guardrails. No other plan or feature must land first. Logically, the companion auto-column plan (eliminating the need for manual card moves) should land first to remove the motivation for direct DB writes, but there is no hard technical dependency.

## Adversarial Synthesis

Key risks: (1) the allowlist glob `Bash(sqlite3 -readonly *)` might not match legitimate query commands, blocking all sqlite3 access — mitigated by a fallback pattern and a verification test; (2) `.claude/skills/` copies of skill files are separate from `.agents/skills/` copies and must both be updated — added explicitly to every Layer 1 item; (3) dual notification paths (`_initialize` info + `_reloadIfStale` warning) could confuse users — mitigated by different severities and a documenting code comment; (4) the static throttle must be per-DB-path to handle multi-IDE correctly — specified in the implementation guidance.

## Verification Plan

1. **Skill audit:** Grep all skills (both `.agents/skills/` and `.claude/skills/`) for `sqlite3` without `-readonly`. Confirm zero matches after the fix.
2. **Claude Code allowlist test:** In a Claude Code session, attempt to run `sqlite3 kanban.db "UPDATE plans SET ..."` — verify it's blocked by the allowlist. Then run `sqlite3 -readonly kanban.db "SELECT ..."` — verify it's allowed.
3. **External write warning test:** With the extension running, run `sqlite3 kanban.db "UPDATE plans SET kanban_column='COMPLETED' WHERE plan_id='test'"` from a terminal. Verify:
   - The VS Code warning notification appears
   - The extension's in-memory state is preserved (the card is NOT in COMPLETED)
   - The warning is throttled (run it again immediately — no second warning)
4. **`create-feature-from-plans` test:** Run the skill with `-readonly` sqlite3 queries. Verify all SELECT queries still work.
5. **Regression test:** Verify `_reloadIfStale` still correctly detects and reloads on legitimate external writes (e.g., another IDE instance).
6. **Dual notification check:** Start the extension with a pre-modified kanban.db (triggers `_initialize` notification), then trigger a runtime external write (triggers `_reloadIfStale` warning). Verify both notifications appear with appropriate severity and wording.
