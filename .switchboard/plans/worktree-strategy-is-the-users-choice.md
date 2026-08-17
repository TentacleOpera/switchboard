# Worktree Strategy Is the User's Choice, and the Agent Obeys It

## Goal

You pick how work is isolated. The default is **no worktrees** — everyone works in the main checkout, one team at a time. Nothing else in the system may change that setting; agents read it and follow it.

### Why

**Today the agent sets the topology and hides your choice.** `KanbanProvider.applyOversightWorktreeTopology` (`:2259`) is documented as applying *"the per-feature worktree topology that an oversight session requires."* Arming the orchestrator stashes your `feature_worktree_mode` under `orchestration_prior_feature_worktree_mode`, forces `per-feature`, and restores it on disarm. There is a double-enter guard, a stale-mode reconciler, and a liveness check to stop the reconciler firing mid-session — a small machine whose entire job is to take a setting away from you and give it back.

**That forcing is what invented `Miscellaneous`.** In `per-feature` mode worktrees are provisioned in exactly one place — inside `createFeatureFromPlanIds` (`:13592`), at feature-creation time. No path gives a featureless plan a worktree. So a plan not in a feature has nowhere to be coded, and the orchestrator's kickoff has to sweep every loose plan into a `Miscellaneous` feature "so nothing is left ungrouped." That feature groups by *everything else*, which carries no information, and it is the direct cause of column-mixed features.

**Worktrees are the right answer sometimes and overkill often.** Their job is to stop parallel workers colliding in one checkout. If one team works at a time, there is nothing to collide with, and the whole apparatus — provisioning, branch-per-feature, merge-back, cleanup — is cost with no benefit.

### Root cause found during this pass — the choice does not exist yet

The framing above is right about the forcing and understates the defect. Verified in the working tree on 2026-08-17 (*line numbers drift — anchor on symbol names*):

| Fact | Evidence |
| :--- | :--- |
| `feature_worktree_mode` is broadcast to the webview | `_sendWorktreeConfig` packs `featureWorktreeMode` into the `worktreeConfig` message (`KanbanProvider.ts:12882`, `:12942`) |
| **Nothing in any webview reads it** | `grep -rn "featureWorktreeMode" src/webview/` → **zero hits** |
| **Nothing in any webview writes it** | `grep -rln "setFeatureWorktreeMode" src/` → only `src/generated/verbAllowlist.ts` and `KanbanProvider.ts`. **No caller.** |
| A radio for it used to exist | `KanbanDatabase.ts:419` (V53 migration note): *"epic_worktree_mode drives the Worktrees tab's Auto Mode radio"* — that radio is no longer in `src/` |
| So the only live writer is the forcing machinery | `applyOversightWorktreeTopology` (`:2271`, `:2279`) and `_reconcileStaleWorktreeMode` (`:2300`) |

**The setting is broadcast-only and write-only-over-HTTP.** The `setFeatureWorktreeMode` verb arm exists (`:12068`) and is on the Kanban verb allowlist, but the only thing that can reach it is an HTTP caller. A human clicking around Switchboard cannot set their worktree strategy at all.

That changes what this plan is. Deleting the forcing machinery is necessary and **not sufficient**: it leaves a setting that nobody — user or agent — can write, permanently pinned at whatever the DB happens to hold. The plan must also put the control back on the Worktrees tab. Both halves ship together or the goal is not met.

## What changes

**The setting is user-owned and has three values:**

| Value | Meaning | Ships in this plan? |
| :--- | :--- | :--- |
| `none` **(default)** | One checkout, one team working at a time. No worktrees, no merge-back, no cleanup. | **Yes** |
| `per-feature` | As today — one shared worktree per feature, provisioned at feature creation. | **Yes** |
| `per-team` | One worktree per team, whatever that team is currently assigned. | **No — deferred, see Scope call** |

**Nothing but the user writes it.** Delete `applyOversightWorktreeTopology`, the `orchestration_prior_feature_worktree_mode` stash key, and the oversight-liveness guard inside `_reconcileStaleWorktreeMode` that exists only to protect the forced value. Agents read the setting; no agent, mode, or automation path sets it.

> **Superseded:** delete *"the oversight-liveness guard inside `_reconcileStaleWorktreeMode`"*.
> **Reason:** `_reconcileStaleWorktreeMode` (`KanbanProvider.ts:2286`) only does anything when `savedPrior` is truthy — it reads `orchestration_prior_feature_worktree_mode` and returns early otherwise. Once the stash key is gone the entire function is dead code, not just its guard, and both of its call sites (`:466` in the constructor, `:1377` in `setCurrentWorkspaceRoot`) exist solely to drive it. Deleting only the guard leaves a dead function running twice per workspace focus change.
> **Replaced with:** delete `_reconcileStaleWorktreeMode` outright along with both call sites — **but only after** the one-time drain migration below has taken over its restore duty.

**The user gets a control.** Add a worktree-strategy radio to the Worktrees tab's existing tab-level settings block in `renderWorktreesTab()` (`kanban.html:11804–11834`, beside `suppress-main-terminals-chk`). Both ends of the plumbing already exist — the broadcast carries `featureWorktreeMode`, and `setFeatureWorktreeMode` is an allowlisted verb with a working arm. Only the control is missing. *(Clarification — strictly implied by "You pick how work is isolated"; this is the surface that makes the Goal true, not new scope.)*

**`none` means serialise.** With no isolation, two teams coding at once corrupt each other. Whoever dispatches — a human dragging a card, or the orchestrator's tick — dispatches one team at a time and waits for it to finish. This is a real constraint of the mode, not a bug in it, and it must be stated wherever work is dispatched.

*Scope of that statement in this plan:* it is **stated, not enforced**. This plan adds the sentence to the radio's helper text so the choice is honest at the point it is made. No dispatch interlock is added here — the dispatch paths belong to the automation and orchestrator work, and adding a half-interlock in the settings tab would be a guard in the wrong file. Recorded explicitly so nobody reads "must be stated" as "must be blocked."

**Keep the DB key `feature_worktree_mode` as it is.** The name is now slightly wrong, but renaming a shipped config key buys a migration for nothing. Rename it in the UI only.

## Migration — the stashed prior must be drained, not ignored

`feature_worktree_mode` is **shipped** state: migration V53 (`KanbanDatabase.ts:417–427`) carries `epic_worktree_mode` → `feature_worktree_mode` on real installs, and its own comment records that installs had it set to `per-subtask` or `high-low`. Two consequences the original plan missed:

**1. A stranded install loses its real setting.** An install whose orchestrator was armed and never cleanly disarmed (crash, reload, force-quit) is sitting on `feature_worktree_mode = 'per-feature'` with its true prior parked in `orchestration_prior_feature_worktree_mode`. Today `_reconcileStaleWorktreeMode` restores that on the next activation. Delete the key and the reconciler in one change and those installs are **stuck on `per-feature` forever**, with the value that would have rescued them thrown away. That is exactly the "assume it shipped and migrate" case in the repo rules.

So: **drain, then delete.** Add a one-shot migration on the same activation path the reconciler used — if `orchestration_prior_feature_worktree_mode` holds a non-empty value, write it into `feature_worktree_mode` (clamped to a known value) and clear the key. It runs once per install, is idempotent, and afterwards the key is inert forever. Only then is the permanent reconciler redundant.

**2. Unknown legacy values must clamp on read, not silently behave as `none`.** `per-subtask` and `high-low` can still be sitting in the key. Every consumer today compares `=== 'per-feature'` (`:12882`, `:13592`), so those installs already behave as `none` — but the new radio would render *no* selection for them, which is a control that lies about the state it reflects. Normalise on read at a single helper so display and behaviour agree.

## Scope call — `per-team` is deferred

`none` and `per-feature` both exist in the tree today; this plan makes the choice yours and deletes the machinery that overrode it. `per-team` is new provisioning work for an option you said *could* exist rather than one you plan to use. Ship the two that exist, then add `per-team` when you actually want it. Say so and it goes in this plan instead.

Concretely: `setFeatureWorktreeMode`'s `validModes` stays `['none', 'per-feature']` (`:12072`) and the radio renders exactly those two. Adding a third radio option ahead of its provisioning would be a dead control — PRD contract #6.

## Order — land this first

This is **1 of 4** in the orchestration set. It has no prerequisites, and the other three assume the `none` default it establishes:

1. **this plan** — worktree strategy becomes the user's, `none` is the default
2. `automation-tab-three-exclusive-modes.md` — agent-managed mode exists
3. `orchestration-starts-as-a-conversation.md` — Start opens a pre-flight
4. `orchestrator-persona-becomes-a-tick.md` — the persona consumes all of the above

Landing this second or later means the persona describes a `none` default that does not exist, and the automation tab deletes `orchestrationConfig.enabled` while `applyOversightWorktreeTopology` is still firing on its transitions.

## Metadata

**Complexity:** 5
**Tags:** refactor, backend, ui
**Project:** Browser Switchboard

## User Review Required

**None.** Four decisions taken here:

* **The radio ships in this plan, not a follow-up.** Without it the plan's own title is false. A setting only the HTTP surface can write is not "the user's choice."
* **Drain-then-delete, not delete-and-ignore.** The stashed prior is drained into the real setting on one activation, then the key is dead. Ignoring it strands crashed sessions on `per-feature`.
* **`per-team` stays deferred and is not rendered.** Two radio options, matching the two values `setFeatureWorktreeMode` accepts.
* **`none` is stated, not enforced.** No dispatch interlock in this plan. The serialisation constraint is written on the control; guarding it belongs to the dispatch paths.

## Complexity Audit

* **Score:** 5 / 10

### Routine

* Deleting `applyOversightWorktreeTopology` (`KanbanProvider.ts:2259–2284`) and its two callers (`TaskViewerProvider.ts:10412`, `:10436`).
* Deleting `_reconcileStaleWorktreeMode` (`:2286–2303`) and its two call sites (`:466`, `:1377`).
* Dropping the `orchestration_prior_feature_worktree_mode` clear from the `setFeatureWorktreeMode` arm (`:12084`) — it exists only to defend against a restore that no longer happens.
* Adding a two-option radio to an existing settings block that already has a working broadcast field and a working verb.

### Complex / Risky

* **The drain migration is a write to shipped config on activation.** It must be idempotent, must clamp the drained value, and must clear the key in the same pass — a drain that does not clear re-runs every activation and will overwrite a user's later choice on every restart. Get the clear wrong and the plan reintroduces the exact defect it deletes.
* **Ordering against the deletion.** The drain must be in place *before* `_reconcileStaleWorktreeMode` is removed within the same change; a coder who deletes first and adds the drain second leaves a window where a stranded install has no restore path at all if the work is split across commits.
* **`autoban-state-regression.test.js` asserts the deleted symbol is present.** Line `:467–470` asserts `kanbanProviderSource.includes('public async applyOversightWorktreeTopology(workspaceRoot: string, armed: boolean)')`. This test goes red the moment the method is deleted, and it is a *contract* test — it is asserting the old model on purpose. It must be updated in the same change, not "fixed later."
* **Unknown-value clamping touches display and behaviour separately.** A clamp that only fixes the radio leaves the DB holding `high-low`; a clamp that writes on every read is a config write on a render path.

## Edge-Case & Dependency Audit

### Race Conditions

* **Drain vs. first render.** The drain runs on the activation path; the Worktrees tab may render before it completes. `_sendWorktreeConfig` is already called after config writes (`:12085`), so the drain must end with a `_sendWorktreeConfig` so a tab opened mid-drain settles to the drained value rather than showing the stranded `per-feature`.
* **Double-drain across workspaces.** `_reconcileStaleWorktreeMode` ran per workspace root (constructor + `setCurrentWorkspaceRoot`). The stash key is per-DB, so the drain is per-DB too — running it on both entry points is safe *because it clears the key*, which is the idempotency mechanism. Do not add a separate in-memory latch; the cleared key is the latch.
* **Radio re-render during interaction.** `renderWorktreesTab()` rebuilds the whole tab from the `worktreeConfig` broadcast. The radio's checked state must derive from `config.featureWorktreeMode` on every render — never from a local click assumption — so a rejected write settles back to the true value. This is the same broadcast-driven discipline the automation tab's controls already use.

### Security

* Not a privilege change. No new routes, no new verbs — `setFeatureWorktreeMode` and `getFeatureWorktreeMode` are both already allowlisted, both already schema-covered at the HTTP boundary, and the arm already rejects values outside `validModes` with `{success:false, error}` (`:12073–12076`). The new radio can only emit the two values the arm accepts.

### Side Effects

* **Removing the forced `per-feature` changes what a *newly created* feature does.** `createFeatureFromPlanIds` reads the mode at creation time (`:13591`) and provisions nothing under `none`. A user who was implicitly relying on the orchestrator forcing `per-feature` will stop getting worktrees for features created during an orchestrator session. That is the intended behaviour change, and it is the whole point — but it is a behaviour change, so the radio's helper text must say what `none` costs.
* **Already-created worktrees are untouched.** Mode is read only at feature-creation time; existing worktrees, their rows, and the merge-back path are unaffected by any of this.
* **The `Miscellaneous` sweep loses its justification but is not removed here.** `.agents/skills/switchboard-orchestrator/SKILL.md:37` still instructs the sweep. This plan removes the *reason* for it; the skill edit belongs to the persona work, and doing it here would be an edit to a file this plan otherwise never touches.
* **Both hosts get the radio from one edit.** `headlessPanelHtml.ts` serves `kanban.html` to the browser cockpit, so the control lands in the editor and the browser from the same file (PRD contract #1).

### Dependencies & Conflicts

* **`src/services/KanbanProvider.ts`** — `applyOversightWorktreeTopology` (`:2259`), `_reconcileStaleWorktreeMode` (`:2286`) and its call sites (`:466`, `:1377`), the `setFeatureWorktreeMode` arm (`:12068–12087`), `_sendWorktreeConfig` (`:12874`).
* **`src/services/TaskViewerProvider.ts`** — the two `applyOversightWorktreeTopology` calls (`:10412`, `:10436`) only. Both are single lines inside `startOrchestratorFromKanban` / `stopOrchestratorFromKanban`; the surrounding arming logic is **not** this plan's to touch.
* **`src/webview/kanban.html`** — `renderWorktreesTab()` tab-level settings block (`:11804–11834`).
* **`src/test/autoban-state-regression.test.js`** — the worktree-topology assertions at `:464–480`. `:467–470` must be deleted with the method. `:471–480` (asserting the `setAutomationMode` arm does not touch either key) stays valid and becomes trivially true — keep it as a tripwire.
* **`src/test/feature-worktree-guardrail-contract.test.js`** — mentions `feature_worktree_mode` in prose only (`:10`); no assertion depends on it. No change needed. *(Checked so a coder does not go looking.)*
* **Sibling subtask conflict — `TaskViewerProvider.ts`.** `automation-tab-three-exclusive-modes.md` deletes `orchestrationConfig.enabled`, which is the flag whose transition drives the two calls this plan removes. **This plan lands first** so the automation tab deletes a field with no remaining topology caller. See Order above.
* **No `verbSchemas.ts` / allowlist change.** No verb is added or removed, so `parity:check` and `catalog:check` need no regen.

## Dependencies

* None outstanding. Every mechanism this plan needs — the broadcast field, the verb, the arm, the schema — is already in the tree.

## Adversarial Synthesis

Key risks: (1) **shipping the deletion without the control**, which passes every original verification step while leaving the user unable to set the thing the plan is named after; (2) **deleting the stash key without draining it**, stranding any install whose orchestrator session ended uncleanly on a forced `per-feature` with its real prior discarded; (3) **a drain that fails to clear the key**, which re-runs forever and overwrites the user's choice on every restart — the original defect wearing a migration's clothes; (4) **`autoban-state-regression.test.js:467` going red**, since it asserts the deleted method exists by exact signature. Mitigations: radio and deletion ship in one change; drain-then-delete ordering is explicit and the cleared key *is* the idempotency latch; the contract test is updated in the same commit.

## Proposed Changes

**Build order:** (1) the drain migration → (2) delete the forcing machinery → (3) the radio → (4) the contract test. The drain first so no window exists where a stranded install has no restore path.

### 1. `src/services/KanbanProvider.ts` — drain the stashed prior once, then never again

Replace `_reconcileStaleWorktreeMode` (`:2286–2303`) with a one-shot drain. Keep both existing call sites (`:466`, `:1377`) pointed at the new method for one release — the key is per-DB, and a user who focuses a second workspace needs its drain to run too.

```ts
/**
 * One-time drain of the retired orchestration worktree stash. Prior versions
 * forced `feature_worktree_mode = 'per-feature'` while an oversight session was
 * armed and parked the user's real value under PRIOR_KEY. A session that ended
 * uncleanly (crash, reload) left the forced value in place. This restores the
 * user's value and consumes the key; once cleared it never fires again, so the
 * cleared key IS the idempotency latch — do not add an in-memory flag.
 */
private async _drainRetiredWorktreeModeStash(workspaceRoot: string): Promise<void> {
    const db = this._getKanbanDb(workspaceRoot);
    if (!db || !await db.ensureReady()) { return; }
    const PRIOR_KEY = 'orchestration_prior_feature_worktree_mode';
    const savedPrior = await db.getConfig(PRIOR_KEY);
    if (!savedPrior) { return; }                 // '' and null both mean "already drained"
    await db.setConfig('feature_worktree_mode', normalizeFeatureWorktreeMode(savedPrior));
    await db.setConfig(PRIOR_KEY, '');           // consume — this is the latch
    await this._sendWorktreeConfig(workspaceRoot);
}
```

**Edge cases:** a `savedPrior` of `''` is the already-consumed marker the old code wrote (`:2280`) and must be treated as absent, not as an unknown value to clamp. The drain must not run before `ensureReady()`. It must end with `_sendWorktreeConfig` so a Worktrees tab already open settles.

### 2. `src/services/KanbanProvider.ts` — one normaliser for the mode

Add a module-level helper next to the existing worktree code and route **every** read through it (`:12882` in `_sendWorktreeConfig`, `:13591` in `createFeatureFromPlanIds`), replacing the current `|| 'none'` idiom:

```ts
/**
 * `feature_worktree_mode` is shipped state. V53 carried `epic_worktree_mode`
 * across, and that key held values this build no longer implements
 * ('per-subtask', 'high-low'). They already behave as `none` — every consumer
 * compares against 'per-feature' — so clamp on READ so the radio shows the
 * behaviour rather than rendering no selection at all. Read-only: never write
 * back from a render path.
 */
export function normalizeFeatureWorktreeMode(value: unknown): 'none' | 'per-feature' {
    return value === 'per-feature' ? 'per-feature' : 'none';
}
```

**Edge cases:** read-only by design. A legacy `high-low` install keeps that string in the DB until the user picks a radio option; it renders and behaves as `none` in the meantime. Do not add a write-back sweep — it would be a config write on every board refresh for a value that is already inert.

### 3. `src/services/KanbanProvider.ts` + `src/services/TaskViewerProvider.ts` — delete the forcing machinery

* Delete `applyOversightWorktreeTopology` entirely (`KanbanProvider.ts:2245–2284`, doc comment included).
* Delete its two callers: `TaskViewerProvider.ts:10412` (`await this._kanbanProvider?.applyOversightWorktreeTopology(root, true);` plus the comment block at `:10408–10411`) and `:10430–10437` (the whole restore block in `stopOrchestratorFromKanban`, including the `_resolveWorkspaceRoot` call that exists only to feed it). Leave `stopOrchestratorFromKanban`'s disarm-and-persist logic untouched.
* Delete the `orchestration_prior_feature_worktree_mode` clear in the `setFeatureWorktreeMode` arm (`:12084`) and the three-line comment above it. Its stated purpose — *"so the mode-switch-away restore does not later clobber the user's explicit choice"* — describes a restore that no longer exists.
* Leave no tombstone comments. The model is gone; a comment explaining the model that used to be here is the next reader's confusion.

**Edge cases:** `stopOrchestratorFromKanban(workspaceRoot?)` keeps its parameter — callers pass it and the signature is part of the verb path. Do not narrow it just because its last in-body consumer left.

### 4. `src/webview/kanban.html` — the worktree-strategy radio

In `renderWorktreesTab()`, append to the tab-level settings block after the `suppress-main-terminals` row (`:11826`) and before `container.appendChild(settingsSection)` (`:11834`):

```js
// ── Worktree strategy ────────────────────────────────────────────────────
// The user's choice, and the only writer of feature_worktree_mode. Checked
// state comes from the broadcast on every render — never from a local click
// assumption — so a rejected write settles back to the true value.
{
    const modeRow = document.createElement('div');
    modeRow.style.cssText = 'display:flex; flex-direction:column; gap:4px; margin-top:8px;';
    const modeTitle = document.createElement('div');
    modeTitle.textContent = 'Worktree strategy';
    modeTitle.style.cssText = 'font-size:11px;';
    modeRow.appendChild(modeTitle);

    const current = (config && config.featureWorktreeMode) === 'per-feature' ? 'per-feature' : 'none';
    const options = [
        { value: 'none', label: 'None — one checkout',
          help: 'Everyone works in the main checkout. No worktrees, no merge-back, no cleanup. One team codes at a time — a second team started in parallel would edit the same files.' },
        { value: 'per-feature', label: 'Per feature',
          help: 'One shared worktree per feature, provisioned when the feature is created. A plan that is not in a feature has no worktree and runs in the main checkout.' }
    ];
    for (const opt of options) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:flex-start; gap:8px;';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'feature-worktree-mode';
        radio.id = 'feature-worktree-mode-' + opt.value;
        radio.value = opt.value;
        radio.checked = current === opt.value;
        radio.style.cssText = 'width:auto; margin:2px 0 0 0; flex-shrink:0;';
        // No confirm dialog — project rule, and confirm() is a no-op in a webview.
        radio.addEventListener('change', () => {
            if (!radio.checked) return;
            postKanbanMessage({
                type: 'setFeatureWorktreeMode',
                mode: opt.value,
                workspaceRoot: currentWorkspaceRoot
            });
        });
        const label = document.createElement('label');
        label.htmlFor = radio.id;
        label.style.cssText = 'cursor:pointer; line-height:1.4;';
        label.innerHTML = '<span style="font-size:11px;">' + opt.label + '</span>' +
            '<br><span style="font-size:10px; color:var(--text-secondary);">' + opt.help + '</span>';
        row.appendChild(radio);
        row.appendChild(label);
        modeRow.appendChild(row);
    }
    settingsSection.appendChild(modeRow);
}
```

**Edge cases:** `config` is `lastWorktreeConfig`, which is null before the first `worktreeConfig` broadcast — the `(config && ...)` guard makes that render as `none`, and the broadcast handler already calls `renderWorktreesTab()` (`:8811`) so it corrects itself. `per-team` is deliberately absent: `setFeatureWorktreeMode` would reject it (`:12073`), which is a dead control. Only two options render until `per-team` is actually provisioned.

### 5. `src/test/autoban-state-regression.test.js` — update the contract it asserts

Delete the assertion at `:467–470` that requires `applyOversightWorktreeTopology` to exist, and its `// Worktree topology rides the ARMING transition` comment block at `:464–466` — the assertion is now asserting the removed model.

Keep `:471–480` (the `setAutomationMode` arm must not touch `feature_worktree_mode` or the prior key) — it is still the correct contract and now holds trivially, which makes it a cheap tripwire against reintroduction. Add the mirror assertion that the deletion actually happened:

```js
// The forcing machinery is DELETED, not flagged off. Worktree strategy is the
// user's; nothing outside the setFeatureWorktreeMode arm and the one-time
// stash drain may write feature_worktree_mode.
assert.ok(
    !kanbanProviderSource.includes('applyOversightWorktreeTopology'),
    'applyOversightWorktreeTopology must be deleted — no automation path may force the worktree topology'
);
assert.ok(
    !providerSource.includes('applyOversightWorktreeTopology'),
    'TaskViewerProvider must no longer call the worktree topology forcer'
);
```

## Verification Plan

> **Session note:** this run was directed to skip compilation and skip automated test execution, so the checks below are written for the implementing coder, not run here.

### Automated Tests

* `applyOversightWorktreeTopology` appears nowhere in `src/` — `KanbanProvider.ts` and `TaskViewerProvider.ts` asserted separately so a half-deletion fails.
* `orchestration_prior_feature_worktree_mode` appears in `src/` in exactly one place: the drain method. Asserted by count, not presence, so a left-behind writer fails.
* The drain is idempotent: run it twice against a DB seeded with `feature_worktree_mode='per-feature'` + `orchestration_prior_feature_worktree_mode='none'`; after the first run the mode is `none` and the key is `''`, and the second run is a no-op that does not rewrite the mode.
* The drain treats `''` as already-consumed: seeded with `feature_worktree_mode='per-feature'` + prior `''`, the mode stays `per-feature`.
* `normalizeFeatureWorktreeMode` maps `'per-feature'`→`'per-feature'` and each of `'none'`, `'per-subtask'`, `'high-low'`, `''`, `null`, `undefined`→`'none'`.
* `renderWorktreesTab` emits exactly two radios named `feature-worktree-mode`, with values `none` and `per-feature` — asserted on the value set, so adding a `per-team` radio ahead of its provisioning fails.
* The radio's checked option tracks `worktreeConfig.featureWorktreeMode`; a broadcast carrying `high-low` checks `none` rather than checking nothing.
* Selecting a radio posts `setFeatureWorktreeMode` carrying `mode` and `workspaceRoot`.
* No `confirm(` / `window.confirm(` is introduced on any path added here.
* `autoban-state-regression.test.js` passes with the `:467–470` assertion removed and the two deletion assertions added.
* `catalog:check` / `parity:check` stay green with no regeneration — this plan adds and removes no verbs.

### Manual Verification

1. **The control exists:** open the Worktrees tab. A **Worktree strategy** radio is present under the tab settings, with `None` selected on a fresh workspace.
2. **It writes:** pick `Per feature`, reload the window, reopen the tab — still `Per feature`.
3. **It provisions:** with `Per feature` selected, create a feature. One shared integration worktree is provisioned, as today.
4. **It stops provisioning:** switch to `None`, create a feature. No worktree is created; the feature's plans dispatch into the main checkout.
5. **The orchestrator no longer touches it:** with `Per feature` selected, start and stop the orchestrator. The radio never moves, and `orchestration_prior_feature_worktree_mode` is never written (inspect via the kanban DB `config` table).
6. **The stranded install is rescued:** seed a DB with `feature_worktree_mode='per-feature'` and `orchestration_prior_feature_worktree_mode='none'`, then open the workspace. The tab opens on `None` and the prior key is empty.

> **Superseded:** *"1. A fresh workspace defaults to `none` — no worktree is created for a new feature."*
> **Reason:** already true at HEAD — every read is `(await db.getConfig('feature_worktree_mode')) || 'none'` (`:12882`, `:13591`). As a verification step it passes before the change and therefore tests nothing.
> **Replaced with:** step 4 above, which checks the default *survives* — a feature created under `None` provisions no worktree even with the orchestrator running.

> **Superseded:** *"7. An install carrying a stale `orchestration_prior_feature_worktree_mode` from the old machinery opens on its real current mode and the dead key is ignored."*
> **Reason:** "ignored" is the bug. A stale prior exists precisely because the install is sitting on a forced `per-feature` that is **not** its real current mode; ignoring the key leaves that install stuck there permanently with the rescuing value discarded.
> **Replaced with:** step 6 above — the key is *drained* into `feature_worktree_mode`, then cleared.

7. **Browser cockpit:** repeat steps 1–4 in the browser board. Same `kanban.html`, so it must behave identically.

## Recommendation

Complexity 5 → **Send to Coder.**

**Read the "Root cause found during this pass" table first.** The plan is not a pure deletion. `feature_worktree_mode` currently has no UI writer at all — the radio is half the change, and shipping the deletion alone produces a setting no human can reach.

**The thing to get right:** drain before delete. The stashed prior is the only record of what a crashed orchestrator session took from the user. Restore it and clear it in one method, and let the cleared key be the latch — an in-memory flag would miss the second workspace.

**Do not** add a `per-team` radio, a dispatch interlock, or a write-back sweep for legacy mode values. All three are named and deliberately out of scope.

## Completion Report

Implemented the full plan in the stated build order: drain migration first, then deletion of the forcing machinery, then the radio, then the contract test. In `KanbanProvider.ts`, replaced `_reconcileStaleWorktreeMode` with `_drainRetiredWorktreeModeStash` (one-shot drain: reads `orchestration_prior_feature_worktree_mode`, writes the clamped value into `feature_worktree_mode`, clears the key — the cleared key is the idempotency latch, no in-memory flag), added the module-level `normalizeFeatureWorktreeMode` helper and routed both reads through it (`_sendWorktreeConfig` and `createFeatureFromPlanIds`), deleted `applyOversightWorktreeTopology` entirely, removed the stash-key clear from the `setFeatureWorktreeMode` arm, and repointed both call sites (constructor + `setCurrentWorkspaceRoot`) at the drain. In `TaskViewerProvider.ts`, deleted both `applyOversightWorktreeTopology` callers (the arm call in `startOrchestratorFromKanban` and the restore block in `stopOrchestratorFromKanban`), leaving the arming/disarming logic untouched. In `kanban.html`, added the two-option worktree-strategy radio (`none` / `per-feature`) to the Worktrees tab settings block, with checked state derived from the broadcast on every render. In `autoban-state-regression.test.js`, replaced the `applyOversightWorktreeTopology` presence assertion with two deletion mirror assertions (KanbanProvider + TaskViewerProvider), preserving the `setAutomationMode` tripwire. No issues encountered — `isOversightAgentRunning` (used by the old reconciler) is preserved as it has other callers, and no verb/schema changes were needed so no catalog regen is required.

## Review Findings

Both halves shipped correctly: `applyOversightWorktreeTopology` and `_reconcileStaleWorktreeMode` are gone from both providers, the stash key survives in exactly one place (the drain, which clamps, consumes the key, and ends with `_sendWorktreeConfig` — verified panel-safe, since `postMessage` queues into `_pendingWebviewMessages` when the webview is not yet ready), and the two-option radio is wired to an already-allowlisted verb so both hosts get it from one file. Reviewer fixed two material gaps. **(1) MAJOR — CI red:** deleting the topology-restore block shrank `stopOrchestratorFromKanban` enough that the `autoban-state-regression.test.js:456` byte-window regex (`{0,900}`) ran past its closing brace into `setAutomationModeFromKanban`, whose `_stopAutobanEngine()` call is legitimate; rescoped the assertion to the method body. **(2) MAJOR — no gate:** the plan's `### Automated` subsection names nine checks and only the `autoban-state` edit had shipped, so added `src/test/worktree-strategy-control-contract.test.js` (11 assertions: forcer absence per-file, stash key by count, drain consumes-the-key, `normalizeFeatureWorktreeMode` mapping table executed for `per-subtask`/`high-low`/`per-team`/null, both reads clamped, exactly-two radios, broadcast-derived checked state, verb payload, no confirm gate) and wired it into `package.json` + `.github/workflows/integration-tests.yml` so it is actually invoked. Validation: the new test and `feature-worktree-guardrail`, `headless-feature-mgmt`, `unattended-batch`, `browser-direct-terminal-helpers`, `catalog:check`, `mirror:check` and `verb-returns:check` all pass. Remaining risks: the drain's runtime idempotency is covered structurally, not by a seeded-DB round trip (no DB harness exists in this suite); and `autoban-state-regression.test.js` is still red at `:521` plus `compile-tests` has four errors, all from a *concurrent* scheduler-loop removal landing in `TaskViewerProvider.ts` during this review — unrelated to this plan, which typechecked clean before that change arrived.

## Review Findings — second pass (feature-level review, 2026-08-17)

Re-verified at the merged tree: both halves still hold. `applyOversightWorktreeTopology` and `_reconcileStaleWorktreeMode` are absent from both providers (surviving mentions are the deletion assertions only), `orchestration_prior_feature_worktree_mode` lives in exactly one place — the drain, which clamps, consumes the key and ends with `_sendWorktreeConfig` — and the two-option radio renders from the broadcast. The first pass's two open items are now closed: `compile-tests` is **clean** (`tsc -p tsconfig.test.json`, 0 errors) and `autoban-state-regression.test.js` is **green**; both reds were the concurrent scheduler-loop removal landing mid-review, as that pass diagnosed, not defects in this plan. `test:contract:worktree-strategy-control` — the gate this plan's first pass added — is invoked by `.github/workflows/integration-tests.yml`, so the fix is genuinely gated. No new findings; the accepted risk stands (the drain's runtime idempotency is covered structurally rather than by a seeded-DB round trip, no DB harness existing in this suite).
