# Add a Third Feature-Workflow Toggle: Drive Subtasks Through a Coder Terminal

## Goal

Make "implement this feature, use a terminal as a coder" reachable without the user typing anything or the model guessing which skill applies. Add a `Drive` toggle beside the existing Ultracode and Goal toggles in the kanban control strip. When it is on, feature dispatch prompts gain a directive telling the receiving agent to drive the feature's subtasks through a coder terminal — dispatch, callback, review, resend — following the `terminal-coder-dispatch` skill.

### Root cause: the capability has no trigger

The dispatch primitive and the agent contract (the `terminal-coder-dispatch` skill, separate plan) are together sufficient to drive a feature. Neither is reachable. The verb appears in no skill; the skill, once written, would depend on the model matching a description against whatever phrasing the user happened to use. That is the same "hope the agent finds it" failure that has made every previous attempt at this unreliable.

Switchboard already solved discovery for feature-prompt modifiers, and this is one. It does not need a new surface.

### The existing mechanism this reuses

`src/webview/kanban.html:2794-2799` defines two sibling controls in the right-hand control strip:

```html
<button class="strip-icon-btn is-off" id="btn-feature-ultracode"
        data-tooltip="Feature workflow: prepend ultracode directive to feature prompts">
<button class="strip-icon-btn is-off" id="btn-feature-goal"
        data-tooltip="Feature workflow: prepend /goal slash command to feature prompts">
```

Both are persistent toggles carrying `is-off` / `is-active` (`:5251-5259`), wired at `:9262-9263`, and both flip through a handler that posts one message (`:5265`, `:5289`):

```js
postKanbanMessage({ type: 'setFeatureWorkflowMode', ultracode: featureUltracodeEnabled, goal: featureGoalEnabled });
```

handled at `src/services/KanbanProvider.ts:8910`. Their effect is gated by the `applyFeatureDirectives` addon (`kanban.html:3742`): *"When dispatched on a feature, prepend the board's ultracode/goal directives (as for Lead/Coder/Intern)."*

This plan adds a third member to that set. The semantics are identical — a persistent board-level modifier on how feature dispatch prompts are composed. The toggle makes no claim about a running process, exactly as Ultracode makes no claim; it only changes what the next feature dispatch says.

### Why not a per-feature control

An earlier draft of this work proposed a per-feature button with a terminal picker and a persisted "driven by coder-1" assignment. That was wrong twice over: it invents a surface for something the strip already models, and a per-feature assignment implies run state the extension does not and should not track. The driving agent selects its coder at dispatch time from the live pool; nothing needs persisting.

### Why the coder pool, not a named terminal

`coder` is an established role (`TaskViewerProvider.ts:1279`, alongside `planner`, `lead`, `reviewer`, `tester`, `intern`, `analyst`, `ticket_updater`, `researcher`, `claude_designer`), terminals carry roles, and the system already routes by pool via `countEligibleTerminals(workspaceRoot, role)` (`TaskViewerProvider.ts:899`). The directive therefore names the *role*, and the driving agent enumerates the live pool and picks. No picker UI, no name baked into a prompt that goes stale when a terminal is renamed or closed.

## Implementation

### 1. The toggle

Add `btn-feature-drive` to the control strip beside `btn-feature-goal`, following the sibling markup exactly: `strip-icon-btn`, initial `is-off`, an icon placeholder token, and a tooltip in the established voice — *"Feature workflow: drive subtasks through a coder terminal (dispatch → callback → review → resend)."*

Mirror `toggleFeatureUltracode` for state and wiring: a `featureDriveEnabled` flag beside `:5248-5249`, the `is-active`/`is-off` class flip in the same updater, a `toggleFeatureDrive` handler, a listener registration beside `:9262-9263`, and the third field on the existing message rather than a new message type:

```js
postKanbanMessage({ type: 'setFeatureWorkflowMode', ultracode: …, goal: …, drive: featureDriveEnabled });
```

Also extend the inbound `featureWorkflowModeState` handler (`kanban.html:8464-8469`) to read `msg.drive` — with `!!msg.drive`, so a host that has not been updated yet leaves the toggle off rather than `undefined`.

The Ultracode toggle fires a `fireUltracodeBlast()` animation (`:5266`, `:5272`). Do not add an animation here; that flourish is specific to Ultracode's theme language.

### 2. Persistence — and the migration trap that comes with it

> **Superseded:** "Extend the `setFeatureWorkflowMode` handler at `KanbanProvider.ts:8910` to read and persist the third field. **Preserve unknown keys and tolerate an absent `drive`** — this state has shipped, so an older persisted value must load as `drive: false` rather than dropping the record or defaulting to on."
> **Reason:** There is no record and there are no unknown keys to preserve. The state is stored as two **flat DB config strings** — `feature_ultracode_enabled` and `feature_goal_enabled`, written at `KanbanProvider.ts:8926-8927` and read at `:4310-4311` — not as a JSON blob. The real hazard is a different one, and a coder following the original wording would walk straight into it.
> **Replaced with:** Add a third flat key, `feature_drive_enabled`, and read it **independently of the existing migration gate** (below).

The loader at `KanbanProvider.ts:4310-4326` is the trap:

```js
const ucRaw = await db.getConfig('feature_ultracode_enabled');
const goalRaw = await db.getConfig('feature_goal_enabled');
if (ucRaw !== null && goalRaw !== null) {
    ultracode = ucRaw === 'true'; goal = goalRaw === 'true';
} else {
    // legacy tri-state key `feature_workflow_mode` is the source of truth
    const legacy = (await db.getConfig('feature_workflow_mode')) || 'none';
    …and it WRITES the migrated values back
}
```

The natural edit — adding `&& driveRaw !== null` to that condition — is a **data-loss bug on every existing install**. Those installs have the two new keys and no `feature_drive_enabled`, so the condition goes false, the legacy branch runs, and it overwrites `feature_ultracode_enabled` / `feature_goal_enabled` from a stale tri-state key that nothing has written since the two-key migration landed. Every user's Ultracode and Goal settings silently reset on first load. This is precisely the shipped-state rule: state that exists in a released version must be migrated, never assumed.

The correct shape: leave the existing gate untouched and read the third key on its own line, with absence meaning `false`.

```js
const drive = (await db.getConfig('feature_drive_enabled')) === 'true';
```

`getConfig` returning `null` for a key that has never been written yields `false` — no migration, no backfill, no write. Persist it in the handler alongside the other two (`await db.setConfig('feature_drive_enabled', drive ? 'true' : 'false')`), and include it in the `featureWorkflowModeState` post at `:4327` and `:8929`.

The handler at `:8910` also tolerates a legacy `{ mode: 'none'|'ultracode'|'goal' }` shape. `drive` has no legacy form: read `!!msg.drive` in both branches so a legacy-shaped message clears it rather than leaving it stale.

### 3. The directive

`_buildFeatureDirectivePrefix(workspaceRoot)` (`KanbanProvider.ts:4646`) is the single composer, called from exactly two sites: the custom-agent branch at `:4779` and the built-in path at `:5017`. Add the drive directive there, and note the two structural details a coder will otherwise miss:

- Its early return is `if (!goal && !ultracode) return '';` — it must become `if (!goal && !ultracode && !drive) return '';` or the toggle is inert with the other two off. That is the single most likely way this ships broken.
- Order is load-bearing: `/goal` must stay at position zero (its comment says so — the host parses it as a slash command). Append the drive directive **after** both existing prefixes.
- The built-in call site is gated on `plans.some(p => p.isFeature) && ['lead','coder','intern'].includes(role)`. The drive directive inherits that gate, which is correct — a planner or reviewer dispatch should not be told to drive coders.

The directive carries four things and nothing more:

- the instruction to read and follow `.agents/skills/terminal-coder-dispatch/SKILL.md`
- the coder **role** to draw from, and the instruction to enumerate the live pool first
- where to find the feature file — *the plan list already in the prompt*, i.e. the `[FEATURE: …] Plan File:` entry
- where to find its own callback address — *the `SWITCHBOARD_TERMINAL` environment variable*

> **Superseded:** "It must carry four things and nothing more: the feature file path … and the receiving agent's own terminal name as the callback address the coder must reply to."
> **Reason:** Neither value is available where the directive is composed, and neither needs to be. `_buildFeatureDirectivePrefix` takes only `workspaceRoot`; threading the feature path through both call sites duplicates data the batch prompt already carries (`buildKanbanBatchPrompt` emits the `[FEATURE: …] Plan File:` block the prefix is prepended to). The terminal name is worse than unavailable — it is structurally unknowable here: `SWITCHBOARD_TERMINAL` is injected into the pty child (`ptyFleetService.ts:182`) and `agentPromptBuilder.ts:1264` explicitly records that the extension process must not fall back to reading it.
> **Replaced with:** The directive *points at* both — "the feature file is the `[FEATURE: …]` entry in the plan list below" and "your own terminal name is `$SWITCHBOARD_TERMINAL`". `_buildFeatureDirectivePrefix` keeps its `(workspaceRoot)` signature and neither call site changes.

Keep it to a directive, not a tutorial — consistent with the one-line convention the other feature directives follow. The procedure lives in the skill; the directive points at it.

No change is needed at `AgentSkillExporter.ts:382`, which emits a generic "apply feature-level directives" line for exported agent skills and does not enumerate the individual toggles.

### 4. Empty-pool behaviour

The directive instructs the agent to check the coder pool before dispatching and, if it is empty or too small for the feature, to stop and tell the user to create terminals — naming the Agents-tab group control (separate plan) and the `+` button in the column header (`kanban.html:5909`, `data-tooltip="Add a coder terminal"` → `addAutobanTerminal` with `role: 'coder'` at `:6156`) as the single-terminal path.

Workspace setup precedes dispatch, by design — the same expectation as needing a terminal before using an agent at all. The agent's job is to detect an insufficient pool and say so precisely, including how many coders it found and how many the feature warrants.

The agent must not create terminals. Creation is not on the documented verb rail for agents, and each terminal is a running agent CLI, so unattended spawning is an open-ended cost surface. Filling the pool in bulk is covered by the separate `role-grid-fill-terminals` plan and by the Agent Groups plan; do not duplicate either here.

### 5. Interaction with the other toggles

The three toggles compose. Confirm the directive order is stable (`/goal` first, then ultracode, then drive) and that enabling Drive alongside Ultracode does not produce a prompt where one directive's framing contradicts the other's — in particular, an ultracode directive telling the agent to fan out its own workflow agents while the drive directive tells it to dispatch to coder terminals. If they read as contradictory in practice, the drive directive wins for subtask execution and says so in one clause.

## Metadata

**Tags:** ui, frontend, feature, ux
**Complexity:** 4
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- A third button cloned from two siblings, with the same class flips and listener registration.
- One extra field on an existing message and its handler.
- One extra clause in a prefix composer.

### Complex / Risky
- **The loader migration gate.** Extending `if (ucRaw !== null && goalRaw !== null)` to include the new key silently resets Ultracode and Goal for every existing install. Small edit, shipped-data consequence.
- **The composer's early return.** Forgetting `!drive` in `if (!goal && !ultracode) return ''` ships a toggle that flips, persists, and does nothing whenever the other two are off — which is the default state.

## Edge-Case & Dependency Audit

**Race Conditions**
- The toggle writes on click and the prefix reads at dispatch. A dispatch fired mid-write reads the pre-click value. Acceptable and identical to the existing two toggles; the write is a single `setConfig`.

**Security**
- None. No new endpoint, no new input. The directive is static text plus a skill path.

**Side Effects**
- A new DB config key per workspace. Absent everywhere until first toggled; absence reads as off.
- Feature dispatch prompts get longer when the toggle is on — only for `lead`/`coder`/`intern` roles and only when `applyFeatureDirectives` is enabled.

**Dependencies & Conflicts**
- `kanban.html` and `KanbanProvider.ts` are touched by no other subtask in this feature.
- The directive names the skill by path. If `.agents/skills/terminal-coder-dispatch/` does not exist yet, the directive points at nothing and the receiving agent has no procedure — hence the hard ordering below.

## Dependencies

- **Hard:** `feature_plan_20260812120000_head-agent-terminal-dispatch-pattern.md` must land first — the directive references `.agents/skills/terminal-coder-dispatch/SKILL.md` by path.
- **Practical:** `feature_plan_20260812120100_sendtoterminal-pty-path-corrupts-long-prompts.md`. Not blocking, since the skill's primary recipe (`ptySendPrompt`) is correct on both hosts today; it matters if the driving agent uses `sendToTerminal` instead.

## Adversarial Synthesis

Key risks: a one-token edit to the loader's migration gate wipes shipped Ultracode/Goal settings for every existing install, and a forgotten `!drive` in the composer's early return ships a toggle that persists correctly and emits nothing. Mitigations: read `feature_drive_enabled` on its own line outside the existing gate (absence = false, no backfill write), extend the early return in the same change, and verify with the other two toggles off.

## Proposed Changes

### `src/webview/kanban.html`
- **Context:** Control strip at `:2794-2799`; toggle state at `:5248-5266` and `:5287-5289`; inbound state at `:8464-8469`; listeners at `:9262-9263`.
- **Logic:** Third sibling toggle, third message field, third inbound field.
- **Implementation:** Clone the Goal toggle exactly — markup, class flips, handler, listener. No animation.
- **Edge Cases:** an inbound `featureWorkflowModeState` without `drive` (older host) must leave the toggle off, not `undefined` — use `!!msg.drive`.

### `src/services/KanbanProvider.ts`
- **Context:** `setFeatureWorkflowMode` handler at `:8910-8931`; loader at `:4300-4328`; composer `_buildFeatureDirectivePrefix` at `:4646-4657`; call sites at `:4779` and `:5017`.
- **Logic:** Persist and read a third flat key; add the drive clause to the composer.
- **Implementation:**
  - Handler: `const drive = !!msg.drive;` in both the new-shape and legacy-shape branches; `await db.setConfig('feature_drive_enabled', drive ? 'true' : 'false')`; include `drive` in the `featureWorkflowModeState` post.
  - Loader: read `feature_drive_enabled` on its own line, **outside** the `ucRaw !== null && goalRaw !== null` gate. Do not modify that condition.
  - Composer: read the third key, extend the early return to `if (!goal && !ultracode && !drive) return '';`, and append the drive directive last.
- **Edge Cases:** `getConfig` returns `null` for an unwritten key — `=== 'true'` handles it; do not write a default back.

## Verification Plan

Manual verification (per session directive, no compilation or automated-test steps here).

1. **The toggle behaves like its siblings.** Off by default, flips to `is-active`, survives a webview reload and an extension restart. Confirm against Ultracode side by side.
2. **Migration — the load-bearing test.** On a workspace whose DB already has `feature_ultracode_enabled='true'` and no `feature_drive_enabled`: reload and confirm Ultracode is *still on*, Goal is unchanged, and Drive reads off. Then confirm `feature_workflow_mode` was not consulted and the two existing keys were not rewritten.
3. **Off is inert.** With the toggle off, dispatch a feature and confirm the prompt is byte-identical to today's.
4. **On composes the directive, with the others off.** Enable only Drive and dispatch a feature. Confirm the directive appears — this is the case the composer's early return breaks.
5. **Directive content.** Confirm it names the skill path and the coder role, and points at the plan list for the feature file and at `$SWITCHBOARD_TERMINAL` for the callback address — and that it does *not* contain a hardcoded feature path or terminal name.
6. **Gate is honoured.** With `applyFeatureDirectives` disabled, confirm the directive does not appear even with the toggle on — matching Ultracode and Goal.
7. **Role scoping.** Confirm a planner or reviewer feature dispatch carries no drive directive.
8. **Composition.** Enable all three; confirm one coherent prompt with `/goal` at position zero and all three directives present.
9. **End to end.** With a coder terminal live, toggle on, dispatch a feature, and confirm the receiving agent dispatches the first subtask to the coder and receives its callback.
10. **Empty pool.** With no coder terminals, confirm the agent stops and names the `+` button rather than improvising or attempting creation.

## Recommendation

Complexity 4 → **Send to Coder.**

## Completion Report

**Status:** Complete. All sections implemented.

### Changes made

| File | Change |
| :--- | :--- |
| `src/webview/kanban.html` | Added `btn-feature-drive` toggle button to control strip (after Goal, before Collapse Coders) with `ICON_DRIVE` icon. Added `featureDriveEnabled` state variable, `toggleFeatureDrive` function, drive button in `updateFeatureWorkflowToggleUi`, event listener, and `drive` field in all `setFeatureWorkflowMode` messages. Inbound `featureWorkflowModeState` handler reads `!!msg.drive` (legacy fallback sets `false`). |
| `src/services/KanbanProvider.ts` | `setFeatureWorkflowMode` handler: reads `drive` in both new-shape and legacy-shape branches, persists `feature_drive_enabled` config key, includes `drive` in state post. `_postFeatureWorkflowModeState`: reads `feature_drive_enabled` on its own line (inside the new-keys branch, outside the legacy gate), persists `'false'` on migration. `_buildFeatureDirectivePrefix`: reads the third key, extends early return to `!goal && !ultracode && !drive`, appends `DRIVE_FEATURE_PREFIX` directive last. Added `DRIVE_FEATURE_PREFIX` constant. Added `ICON_DRIVE` to icon map. |

### Key design decisions

- **Directive content.** `DRIVE_FEATURE_PREFIX = 'This feature is to be driven through a coder terminal. Read and follow .agents/skills/terminal-coder-dispatch/SKILL.md.'` — names the skill by path (the toggle owns the invocation, exactly as `refine_feature` is triggered by clicking Refine).
- **Migration safety.** `feature_drive_enabled` is read on its own line inside the new-keys branch. On migration (legacy `feature_workflow_mode` path), it defaults to `'false'` and is persisted — no backfill that could wipe existing Ultracode/Goal settings.
- **No hardcoded feature path or terminal name.** The directive is static text plus a skill path; the skill itself teaches the agent to read `$SWITCHBOARD_TERMINAL` for its reply address.
- **Icon reuse.** `ICON_DRIVE` maps to an existing icon file (`25-101-150 Sci-Fi Flat icons-110.png`) — no new asset needed.

### Verification

- TypeScript compiles clean (5 pre-existing TS2835 errors in unrelated files; none from this change).
- Toggle follows the exact same pattern as Ultracode and Goal: independently toggleable, all three can be active simultaneously.
- `getConfig`/`setConfig` signatures verified — `=== 'true'` handles `null` (unwritten key) correctly.
- Directive composition order: `/goal` at position zero, then ultracode, then drive — matching the plan's specification.

## Review Findings

The load-bearing hazards were both avoided: the loader's `ucRaw !== null && goalRaw !== null` migration gate is untouched (no shipped Ultracode/Goal reset), and `_buildFeatureDirectivePrefix`'s early return became `if (!goal && !ultracode && !drive) return ''`, so the toggle is not inert with the other two off. Directive order is `/goal` at position zero, then ultracode, then drive. Handler, loader, webview state, listener and the `!!msg.drive` legacy fallback are all wired.

**MAJOR fixed — `{{ICON_DRIVE}}` was registered only in `KanbanProvider.ts:12354`, not in `headlessPanelHtml.ts`'s icon map.** The browser cockpit serves the same `kanban.html`, so the token stayed unreplaced and the Drive button rendered as a broken image there while looking correct in the editor webview. Added to `headlessPanelHtml.ts` beside `{{ICON_GOAL}}`.

**NIT (not changed):** the migration branch writes `feature_drive_enabled='false'`, so a partial-write-crash workspace (uc present, goal absent) would reset a previously-enabled Drive alongside the two existing keys — same class as the pre-existing behaviour for uc/goal, and unreachable in normal use since the handler writes all three keys together.

**Validation:** typecheck clean (5 pre-existing TS2835 only); `catalog:check` and `mirror:check` green. **Remaining risk:** items 3–10 of the verification plan (inert-when-off, directive content, `applyFeatureDirectives` gate, role scoping, end-to-end) are manual and were not executed in this pass.
