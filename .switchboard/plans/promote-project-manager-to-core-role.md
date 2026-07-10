---
description: "Promote the Project Manager from the Optional group in the kanban.html agents tab to a core role: core group placement, default-visible, so fresh setups get a PM terminal and the Manage button dispatches instead of falling back to the clipboard."
---

# Promote Project Manager to a Core Role (Agents Tab)

## Goal

Make the Project Manager a **core role** instead of an optional one: it appears in the agents tab's core group, is visible/enabled by default, and therefore gets a terminal in the default agent setup — so the Manage button (and the upcoming "Run Selected Plans" targeted-pass button) finds a live PM terminal on a fresh workspace instead of falling back to "prompt copied to clipboard".

### Problem / root cause

The PM role was added to the agents tab's **Optional** group (`src/webview/kanban.html:2898`, below the `<!-- OPTIONAL -->` label at `:2884`) with `project_manager: false` in the `getVisibleAgents()` defaults (`src/services/TaskViewerProvider.ts:4513-4528`). Optional roles are unchecked by default, so a default setup registers no PM terminal. But the 2026-07-10 manager overhaul made the PM the **single front door** (Guided Setup button removed; Manage button is the only launcher; the manage console is how users drive the board from any host). A front-door role whose terminal doesn't exist by default guarantees every new user's first Manage click lands on the clipboard-fallback path — the worst first impression of the console.

### Current state (verified in source, 2026-07-10)

- Core group rows (checked by default): planner (`kanban.html:2857`), lead (`:2873`), coder (`:2875`), intern (`:2877`), reviewer (`:2879`), analyst (`:2881`).
- Optional group (`:2884` label): tester, ticket_updater, researcher, jules, claude_artifacts, phone_a_friend, **project_manager (`:2898-2899`, no `checked`)**.
- Visibility defaults: `getVisibleAgents()` (`TaskViewerProvider.ts:4513`) — `project_manager: false`. Saved user state merges over defaults (`{...defaults, ...saved}`), machine-global file first, then globalState, then legacy state.json.
- Manage delivery: `_handleDispatchProjectManager()` resolves the PM terminal via `_getAgentNameForRole('project_manager', ...)` with clipboard fallback.

## Metadata
- **Tags:** feature, ui, ux
- **Complexity:** 2
- **Project:** switchboard

## User Review Required
- None. (Existing users who explicitly saved `project_manager: false` keep their saved value — the merge order preserves explicit user state; only users whose saved map lacks the key, and fresh installs, flip to visible. Confirm this is the intended migration behavior — it is the least surprising option.)

## Scope

### ✅ IN SCOPE
1. **`kanban.html` agents tab:** move the Project Manager row + its description div (`:2898-2899`) out of the Optional group and into the core group (after Analyst `:2881-2882`, above the `<!-- OPTIONAL -->` label); add `checked` to its `agents-tab-visible-toggle` like the other core rows.
2. **Visibility default:** `getVisibleAgents()` defaults — `project_manager: false` → `true` (`TaskViewerProvider.ts:~4527`).
3. **Description copy check:** keep the existing PM description ("Host-agnostic management console — drives the board over the LocalApiServer HTTP API. Activate via the Manage button…") — update only if the core-group placement makes the "Activate via the Manage button" hint redundant.
4. **Docs:** update `docs/switchboard_user_manual.md` §3 (Agent Roles & Configuration) if it enumerates core vs optional roles; verify the manage skill's Guided Setup §5 step 1 doc references still hold (they teach agent registration and now implicitly include the PM).

### ⚙️ OUT OF SCOPE
- Any dispatch/board-column behavior — PM has no kanban column; "core" here means default-visible + core-group placement only.
- Forcing PM visibility for users who explicitly saved it off (respect saved state).
- The targeted-pass button — sibling plan (`board-selected-plans-to-manager-targeted-pass.md`).

## Implementation Steps
1. Move the two PM lines in `kanban.html` into the core group; add `checked`.
2. Flip the default in `getVisibleAgents()`.
3. Grep for any other `project_manager` optionality assumptions (`grep -rn "project_manager" src/` — e.g. setup flows that skip optional roles when building the default terminal grid) and align them.
4. Docs check per Scope #4.
5. Gates: `catalog:check`, `parity:check`, `mirror:check` (no verb changes expected — regen only if the catalog hashes the webview).

## Complexity Audit
### Routine
- Two-line HTML move + one boolean default + docs touch-up.
### Complex / Risky
- **Saved-state migration semantics:** the three-tier visibility persistence (machine-global file → globalState → legacy state.json) merges saved maps over defaults. Verify a saved map that *lacks* the `project_manager` key inherits the new `true` default (it does — spread order), and one that has it `false` stays `false`. Do not write a migration that force-flips saved state.
- **Default terminal grid:** confirm whatever builds the default agent grid/registration honors the new visibility so a fresh setup actually opens a PM terminal (this is the point of the change).

## Edge-Case & Dependency Audit
- **Race conditions:** none — static defaults + markup.
- **Side effects:** fresh installs open one more terminal by default. Acceptable — the PM is the front door. Users can still untick it.
- **Dependencies & conflicts:** sibling plan `board-selected-plans-to-manager-targeted-pass.md` benefits directly (its button needs a live PM terminal); no ordering constraint between them. No interaction with the visibleAgents cross-IDE sync beyond the default flip.

## Dependencies
- None hard. Pairs with `board-selected-plans-to-manager-targeted-pass.md` under the PM-integration feature.

## Proposed Changes
### src/webview/kanban.html
- Move PM row + description (`:2898-2899`) into the core group (after `:2881-2882`); add `checked`.
### src/services/TaskViewerProvider.ts
- `getVisibleAgents()` defaults: `project_manager: true`.
### docs/switchboard_user_manual.md
- §3 core/optional role listing updated if present.

## Verification Plan
### Automated
- `catalog:check`, `parity:check`, `mirror:check` green.
### Manual / behavioral
- Fresh profile (no saved visibleAgents): agents tab shows Project Manager in the core group, checked; default agent setup registers/opens a PM terminal; clicking Manage dispatches to it (no clipboard fallback).
- Existing profile with `project_manager: false` explicitly saved: stays unchecked after update.
- Existing profile whose saved map predates the PM key: becomes checked (inherits new default).

---
**Recommendation:** Complexity 2 → Send to Coder.
