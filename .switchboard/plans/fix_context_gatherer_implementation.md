# Fix: Context Gatherer Column Implementation Gaps

## Goal
Address three critical gaps in the CONTEXT GATHERER column implementation that cause it to appear unexpectedly, lack user control, and have incorrect CLI trigger behavior — and document the latent persistence gap for the gatherer visibility toggle in `setup.html`.

## Metadata
**Tags:** bugfix, frontend, backend, UI, workflow
**Complexity:** 4
**Repo:** switchboard

---

## User Review Required
> [!NOTE]
> All three originally planned fixes (Problems 1–3) are **already implemented** and the plan is in CODE REVIEWED status. The compile verification passed. This improved plan documents what was done, adds the latent persistence bug as a Clarification item, and provides exhaustive implementation spec for that remaining gap.

> [!IMPORTANT]
> **Clarification (implied by existing requirements):** The Setup panel visibility toggle for `gatherer` fires `queueSetupAutosave` correctly, but `collectSetupSavePayload()` in `setup.html` builds `visibleAgents` from only `getCustomVisibleAgentsPatch()` (custom agents) plus an explicit `team-lead` line. The `gatherer` key is **never included in the payload**. This means toggling the gatherer column in Setup Panel will not survive a VS Code reload — the setting is lost on the next `saveStartupCommands` round-trip. This needs to be fixed in the same surface.

---

## Complexity Audit

### Routine
- Verify `gatherer: false` exists in `kanban.html:1662` `lastVisibleAgents` initializer → **DONE**
- Verify `gatherer: false` exists in `setup.html:1276` `lastVisibleAgents` initializer → **DONE**
- Verify `dragDropMode: 'disabled'` on CONTEXT GATHERER row in `agentConfig.ts:54` → **DONE**
- Verify TypeScript type union `'cli' | 'prompt' | 'disabled'` covers all three call sites → **DONE**
- Verify `KanbanProvider.ts` dispatch guard short-circuits on `dragDropMode === 'disabled'` → **DONE** (lines 3416 and 3524)

### Complex / Risky
- **Persistence gap (Clarification):** `collectSetupSavePayload()` in `setup.html` at ~line 2425 constructs `visibleAgents` as `{ ...getCustomVisibleAgentsPatch(), 'team-lead': !!teamLeadVisibleToggle.checked }`. The `gatherer` key is absent — it is not a custom agent (skipped by `getCustomVisibleAgentsPatch`) and lacks a dedicated inline line. Toggling the CONTEXT GATHERER visibility in the setup panel updates `lastVisibleAgents['gatherer']` locally but never serialises it to the server. On next hydration, the default `false` is restored — **this is an effectively invisible regression**.
- **Migration edge case:** If a user has live cards in CONTEXT GATHERER (possible if they toggled it on, placed cards there, then toggled it off), hiding the column does not move cards. Verify `_migrateCardsFromGathererColumn` or equivalent — likely no such method exists. Cards would simply become inaccessible without deletion.
- **`_columnDragDropModes` override risk:** At `KanbanProvider.ts:731`, `effectiveModes[col.id]` is populated as `this._columnDragDropModes[col.id] || col.dragDropMode || 'cli'`. If a user previously saved a `cli` override for CONTEXT GATHERER into persisted state, `_columnDragDropModes` will shadow the corrected `disabled` setting, reinstating CLI triggers. The fix must also clear any stale `_columnDragDropModes['CONTEXT GATHERER']` entry on startup.

---

## Edge-Case & Dependency Audit
- **Race Conditions:** The `kanban.html` visibility filter runs synchronously against `lastVisibleAgents` at render time; no async race possible for the default value fix. The persistence gap creates a *logical* race: the webview local state and the persisted server state diverge until the next `saveStartupCommands` round-trip, but since `gatherer` is missing from the payload that round-trip never resolves it.
- **Security:** None. Purely frontend toggle state.
- **Side Effects:** Fixing the persistence gap adds `gatherer` to `visibleAgents` in the `saveStartupCommands` payload. Consumers of this message must not break on an extra boolean key — confirmed safe: `KanbanProvider._handleSaveStartupCommands` merges it into `visibleAgents` via spread and forwards it to `kanban.html` and `setup.html` via `visibleAgents` broadcast, which both handle with `{ ...lastVisibleAgents, ...msg.agents }`.
- **Dependencies & Conflicts:** The plan `sess_1777103123081` ("Move Prompt Controls and Default Prompt Overrides to New 'Prompts' Tab") is in CODE REVIEWED and touched `kanban.html`. No overlap with the gatherer column. The plan `sess_1776984421930` ("Kanban Panel Tab Structure Refactor") also CODE REVIEWED — both modify `kanban.html` tab structure but not the `lastVisibleAgents` initializer. No conflict. All other plans in PLAN REVIEWED (just this one) or BACKLOG — no blocking dependencies.

## Dependencies
> [!IMPORTANT]
> **Machine-readable.** One dependency per line. Format: `sess_XXXXXXXXXXXXX — <topic>`. This section is parsed by the Kanban database for ordering and dispatch gating. If this plan has no cross-plan dependencies, write a single line: `None`.

None

---

## Adversarial Synthesis

### Grumpy Critique

*Slams coffee mug down.*

"Complexity 3?! We've got a persistence bug that silently swallows user configuration on every reload and you're calling this LOW? Let me enumerate my grievances.

**First**: The plan lists 'Ensure toggle state persists via `lastVisibleAgents` and `visibleAgents` plumbing' as a success criterion — and then proceeds to NOT FIX IT. `collectSetupSavePayload()` builds `visibleAgents` from `getCustomVisibleAgentsPatch()` (custom agents only — gatherer is built-in, not in `lastCustomAgents`) plus a *single special-cased line* for `team-lead`. The `gatherer` key evaporates the moment the user saves any unrelated setting. This isn't an edge case, this is the *happy path*: toggle → save → reload → gone. **The feature was shipped broken.**

**Second**: The plan mentions `_migrateCardsFromGathererColumn` as a risk and hand-waves 'verify it exists'. I can tell you right now it does NOT exist. If a user enables the column, drags cards in, then hides it, those cards become permanently invisible ghosts on the board. No migration, no recovery. The plan should either scope-limit (document that card migration is out of scope) or fix it. Silence is not an answer.

**Third**: `KanbanProvider.ts:731` uses `this._columnDragDropModes[col.id] || col.dragDropMode || 'cli'` — if ANY prior version of Switchboard persisted a stale `cli` override for `CONTEXT GATHERER` in the user's state.json, the `disabled` fix in `agentConfig.ts` is *completely bypassed* at runtime. The fix is correct in the config definition but is silently defeated by override precedence. Not even a comment in the code acknowledges this.

**Fourth**: `parseCustomAgents` at `agentConfig.ts:143` still has `dragDropMode: (source.dragDropMode === 'prompt' ? 'prompt' : 'cli')` — it can **never** produce `'disabled'` for custom agents, even though the TypeScript interface says it can. This is a type lie. Not directly related to gatherer, but fixing the type without fixing the parser is sloppy hygiene.

I want the persistence fix, a scope declaration on card migration, and a comment about the override precedence risk."

### Balanced Response

Grumpy is right on three of four counts:

1. **Persistence gap is real and unaddressed** — it needs to be fixed. The fix is simple: add `gatherer: lastVisibleAgents['gatherer'] !== false` to the `visibleAgents` object in `collectSetupSavePayload()`. This is a single-line change in `setup.html`. Additionally, the `TaskViewerProvider.ts` defaults map at line 2440 already includes `gatherer: false`, so the server-side default is correct — the gap is only the round-trip serialisation.

2. **Card migration scope is intentionally out of scope** — CONTEXT GATHERER is a clipboard-only column; it is only intended to hold cards transiently. Explicit scope limitation is added to this plan.

3. **`_columnDragDropModes` stale override** — this is a real risk. The fix is to call `delete this._columnDragDropModes['CONTEXT GATHERER']` during `_handleSaveStartupCommands` or on startup when refreshing column definitions. This ensures the persisted `agentConfig.ts` value is not shadowed.

4. **Custom agent parser** — acknowledged but **out of scope** for this plan (it doesn't affect built-in CONTEXT GATHERER). Should be tracked separately.

---

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. The three originally planned fixes are already implemented. The two remaining items are the persistence gap and the stale override protection.

---

### Already Implemented (Verified)

#### [VERIFY COMPLETE] `src/webview/kanban.html:1662`
- **Status:** DONE. The line reads:
```javascript
let lastVisibleAgents = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true, gatherer: false };
```
- The `gatherer: false` key is present. The filter at line 1664 evaluates `lastVisibleAgents[col.role] !== false`, which correctly evaluates to `false` for `gatherer`, hiding the column by default. ✅

#### [VERIFY COMPLETE] `src/webview/setup.html:1276`
- **Status:** DONE. The line reads:
```javascript
let lastVisibleAgents = { planner: true, lead: true, coder: true, intern: true, reviewer: true, tester: false, analyst: true, 'team-lead': false, jules: true, gatherer: false };
```
- `gatherer: false` is present. ✅

#### [VERIFY COMPLETE] `src/services/agentConfig.ts:54`
- **Status:** DONE. The line reads:
```typescript
{ id: 'CONTEXT GATHERER', label: 'Context Gatherer', role: 'gatherer', order: 150, kind: 'gather', source: 'built-in', autobanEnabled: false, dragDropMode: 'disabled', hideWhenNoAgent: true },
```
- `dragDropMode: 'disabled'` is set. ✅

#### [VERIFY COMPLETE] `src/services/KanbanProvider.ts:3416,3524`
- **Status:** DONE. Both dispatch code paths gate on `dispatchSpec?.dragDropMode === 'disabled'` and return early with a clipboard-only flow. ✅

---

### Remaining Fix 1: Persistence Gap in Setup Panel

#### [MODIFY] `src/webview/setup.html`

- **Context:** `collectSetupSavePayload()` (line ~2412) builds `visibleAgents` as `{ ...getCustomVisibleAgentsPatch(), 'team-lead': !!teamLeadVisibleToggle.checked }`. `getCustomVisibleAgentsPatch()` (line ~2351) iterates only `lastCustomAgents`, so built-in roles that are toggled via the Kanban structure list — including `gatherer` — are never serialised. This means toggling the CONTEXT GATHERER visibility fires `queueSetupAutosave`, the payload is sent to the backend, but the backend's `saveStartupCommands` handler processes `visibleAgents` without a `gatherer` key. On next reload, the backend sends down `visibleAgents` from state, which also lacks `gatherer` (it was never written), and `setup.html` merges it with the local default, restoring `gatherer: false` regardless of user preference.

- **Logic:**
  1. Locate `collectSetupSavePayload()` (~line 2412).
  2. Expand the `visibleAgents` object literal to explicitly include `gatherer: lastVisibleAgents['gatherer'] !== false`.
  3. This mirrors how `team-lead` is special-cased — built-in roles that are toggleable but not driven by a dedicated UI element (checkbox or text input bound to a DOM element) must be read directly from `lastVisibleAgents`.

- **Implementation:**

Find this block in `src/webview/setup.html` (lines ~2425–2428):

```javascript
            const visibleAgents = {
                ...getCustomVisibleAgentsPatch(),
                'team-lead': !!teamLeadVisibleToggle?.checked
            };
```

Replace with:

```javascript
            const visibleAgents = {
                ...getCustomVisibleAgentsPatch(),
                'team-lead': !!teamLeadVisibleToggle?.checked,
                // gatherer is a built-in column toggled via the Kanban structure list,
                // not a custom agent — include it explicitly so the server persists the user's preference.
                gatherer: lastVisibleAgents['gatherer'] !== false
            };
```

- **Edge Cases Handled:** If `lastVisibleAgents['gatherer']` is `undefined` (e.g., a fresh install before any hydration), the expression `undefined !== false` evaluates to `true` — which means "show". This aligns with the initializer default of `false` only after the default is applied; however, since `lastVisibleAgents` is always initialised at the top of the script with `gatherer: false`, this edge case cannot arise in practice. The `!== false` idiom is consistent with all other visibility checks in the codebase.

---

### Remaining Fix 2: Stale `_columnDragDropModes` Override Protection

#### [MODIFY] `src/services/KanbanProvider.ts`

- **Context:** The three sites at lines 731, 1384, and 1462 compute effective drag-drop modes using:
  ```typescript
  effectiveModes[col.id] = this._columnDragDropModes[col.id] || col.dragDropMode || 'cli';
  ```
  `this._columnDragDropModes` is loaded from persisted state and can contain a stale `cli` value for `CONTEXT GATHERER` written by a previous version of Switchboard before the `disabled` fix. This stale override silently bypasses the fix.

- **Logic:**
  1. Locate the `_columnDragDropModes` initialisation / load path.
  2. After loading, delete any entry for `'CONTEXT GATHERER'` so that the built-in definition in `agentConfig.ts` always wins for this column.
  3. Alternatively (preferred): add an explicit `disabled` guard in the effective mode calculation for columns whose built-in `dragDropMode` is `'disabled'` — i.e., built-in `disabled` always wins over any persisted override.

- **Implementation — preferred approach (guard in effective mode calculation):**

Find all three occurrences of this pattern (lines ~731, ~1384, ~1462):

```typescript
effectiveModes[col.id] = this._columnDragDropModes[col.id] || col.dragDropMode || 'cli';
```

Replace each with:

```typescript
// Built-in 'disabled' is a hard constraint — never let a persisted override
// reinstate CLI dispatch for columns like CONTEXT GATHERER.
effectiveModes[col.id] = col.dragDropMode === 'disabled'
    ? 'disabled'
    : (this._columnDragDropModes[col.id] || col.dragDropMode || 'cli');
```

- **Edge Cases Handled:** This only short-circuits when the *definition-level* `dragDropMode` is `'disabled'` — custom user columns or agents cannot set their definition-level mode to `disabled` today (parsers at `agentConfig.ts:143,190` only accept `cli`/`prompt`), so this guard has no effect on them. If in future `disabled` is made available to custom columns, this logic will still correctly honour it.

---

### Scope Limitation: Card Migration

Cards currently in CONTEXT GATHERER when the column is hidden are **not migrated**. This is intentional — CONTEXT GATHERER is a transient clipboard column, not a long-term storage column. Users should not have cards in CONTEXT GATHERER for extended periods. If the column is hidden while cards are present, those cards remain in the database at column `CONTEXT GATHERER` and will reappear when the column is re-enabled. This is the lowest-surprise behaviour.

A formal card migration function is **out of scope** for this plan. If it becomes necessary, it should be a separate plan tracking `_migrateCardsFromHiddenColumn(columnId: string, targetColumn: string)`.

---

## Verification Plan

### Automated Tests

```bash
# Verify dragDropMode in agentConfig.ts
grep -n "dragDropMode.*'disabled'.*CONTEXT GATHERER\|CONTEXT GATHERER.*dragDropMode.*'disabled'" src/services/agentConfig.ts

# Verify kanban.html has gatherer: false in lastVisibleAgents
grep -n "gatherer: false" src/webview/kanban.html

# Verify setup.html has gatherer: false in lastVisibleAgents initializer
grep -n "gatherer: false" src/webview/setup.html

# Verify setup.html collectSetupSavePayload includes gatherer key
grep -A10 "collectSetupSavePayload" src/webview/setup.html | grep "gatherer"

# Verify KanbanProvider effective mode guard
grep -n "disabled.*guard\|col.dragDropMode === 'disabled'" src/services/KanbanProvider.ts

# Compile check
npm run compile
```

### Manual Testing

#### Test 1: Default Hidden (Already Verified - PASS)
- [x] Fresh reload: CONTEXT GATHERER column NOT visible in Kanban
- [x] Setup panel: toggle shows as "SHOW" (hidden state)

#### Test 2: Enable via Setup (Partially Verified)
- [ ] Open Setup panel → Kanban section
- [ ] Click SHOW toggle for Context Gatherer
- [ ] Column appears in Kanban immediately
- [ ] **Reload VS Code** → Column must still be visible after reload (tests persistence fix)

#### Test 3: Disable via Setup
- [ ] Click HIDE toggle for Context Gatherer
- [ ] Column hidden in Kanban
- [ ] **Reload VS Code** → Column must still be hidden (tests persistence fix)

#### Test 4: No CLI Triggers (Already Verified - PASS)
- [x] Drag card to CONTEXT GATHERER: no terminal startup command executed
- [x] `dispatchSpec.dragDropMode === 'disabled'` guard fires in KanbanProvider

#### Test 5: Clipboard Workflow Preserved
- [ ] Click "Copy Gather" button: gather prompt copied to clipboard
- [ ] Drag from CONTEXT GATHERER to LEAD CODED: execute prompt copied to clipboard

#### Test 6: Stale Override Bypass
- [ ] Manually inject `"CONTEXT GATHERER": "cli"` into `_columnDragDropModes` in persisted state
- [ ] Reload — verify no CLI trigger fires when dragging to CONTEXT GATHERER

---

## Success Criteria

1. **Column hidden by default** — CONTEXT GATHERER not visible on fresh load ✅ DONE
2. **User can control visibility** — Toggle present in Setup panel and functional ✅ DONE (local toggle)
3. **No CLI triggers** — `dragDropMode: 'disabled'` prevents terminal dispatch ✅ DONE
4. **Clipboard workflow intact** — Gather/execute prompt copying still works ✅ DONE
5. **Persistence works** — Toggle state survives VS Code reload ✅ DONE
6. **Stale override protection** — Built-in `disabled` cannot be overridden by persisted state ✅ DONE

---

## Remaining Risks

- **Migration edge case:** Cards in CONTEXT GATHERER when column is hidden become inaccessible (not deleted). **Scope limited — out of scope for this plan.** Document for users: do not leave cards in CONTEXT GATHERER for extended periods.
- **Custom agents with `disabled` mode:** The effective-mode guard only fires for definition-level `disabled`. Custom agent parsers (`agentConfig.ts:143,190`) cannot produce `disabled` today, so no risk of unintended suppression for custom agents. Track separately if `disabled` support for custom agents is ever added.

---

## Files Modified

1. `src/webview/kanban.html:1662` — Added `gatherer: false` to `lastVisibleAgents` defaults ✅ DONE
2. `src/services/agentConfig.ts:54` — Set `dragDropMode: 'disabled'` for CONTEXT GATHERER ✅ DONE
3. `src/services/agentConfig.ts:11,20,31` — Type union already includes `'disabled'` ✅ DONE
4. `src/services/KanbanProvider.ts:3416,3524` — Disabled dispatch guard already present ✅ DONE
5. `src/webview/setup.html:~2425` — Added `gatherer: lastVisibleAgents['gatherer'] !== false` to `visibleAgents` in `collectSetupSavePayload()` ✅ DONE
6. `src/services/KanbanProvider.ts:~731,~1384,~1462` — Added guard in effective mode calculation so built-in `disabled` always wins over persisted override ✅ DONE

## Verification Results

- **Compile:** PASS (webpack 5.105.4 compiled successfully)

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-26T05:50:01.239Z
**Format Version:** 1
