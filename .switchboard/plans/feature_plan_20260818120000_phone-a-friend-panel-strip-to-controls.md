# Strip the Phone-a-Friend Panel to Controls, Not Plumbing

## Goal

The Phone a friend panel in the TEAMS tab of `kanban.html` must show the operator only controls they can act on and one line of copy that names who gets called. Today it renders two storage surfaces as UI — an unlabelled free-text **Target** box that reads as a reply address, and an "Advanced: per-terminal overrides" disclosure that exposes an origin→target routing map with no picker, no validation, and no live-terminal list. Both go, along with the resolver branches that read them, so that what the operator sees is what happens. The panel becomes a role select, an enable checkbox, and one line of copy. Stored map keys (`addons.phoneAFriendTargets`, including `'*'` and per-origin entries) are preserved on disk — neither this plan nor the sanitizer deletes operator config.

### Problem analysis

The panel renders three things for the selected role inside `agentsTabRenderDelegationPanel` (`src/webview/kanban.html:4464-4592`):

1. **Enable checkbox** (`kanban.html:4474-4501`) — the one real control. Governs whether the `PHONE_A_FRIEND_DIRECTIVE` is emitted in the coder's prompt.
2. **Target row** (`kanban.html:4503-4547`) — a label that says exactly `Target`, a free-text input with placeholder `Phone-a-Friend (default)`, and nothing on screen that says what the field addresses, what values are legal, or what happens when it is empty. The operator's reading of it is the evidence: *"I selected the role I want phone a friend on, what the hell is the 'target'? what the phone a friend replies back to?"* — a control that gets guessed at as a reply address is not a control, and the guess is wrong in a way that matters (Phone-a-Friend replies to nobody; it is a second pass on the plan, not a message round-trip).
3. **Advanced disclosure** (`kanban.html:4549-4590`) — `▶ Advanced: per-terminal overrides`, behind which sits an origin-terminal → target-terminal string map rendered as free-text rows (`agentsTabPhoneRow`, `kanban.html:4594-4625`). Each row is three controls whose meaning is only legible if you already know the resolver's shape. "origin terminal" and "target terminal" are storage keys with a placeholder attached. A typo produces a map entry that matches nothing and reports nothing. The panel's own help text advertises it as a feature: *"Advanced per-terminal overrides below."* (`kanban.html:3351`).

**This is a known-and-accepted debt being cashed in, not a discovery.** The plan that rebuilt this panel (`.switchboard/plans/teams-tab-three-presets-and-phone-a-friend.md`) says so in its own words: *"Phone-a-Friend's UI is raw plumbing… That is the override mechanism exposed as the primary control"*, and it chose to demote the map behind a disclosure rather than remove it, on the grounds that it is shipped state. Demoting it kept it on screen. The operator's verdict on the demoted version is that it is meaningless.

### Root cause — two ways to say something the role system already says, exposed as storage keys

The Target box writes a reserved `'*'` key into the role's `phoneAFriendTargets` map. The disclosure writes per-origin keys. Both are read by the dispatch resolver `_dispatchPhoneAFriend` (`TaskViewerProvider.ts:5611-5651`):

```ts
const roleConfig: any = this.getRoleConfig(`roleConfig_${originRole}`);
const targetOverride = typeof originTerminal === 'string' && originTerminal
    ? roleConfig?.addons?.phoneAFriendTargets?.[originTerminal]
    : undefined;
const roleDefaultTarget = roleConfig?.addons?.phoneAFriendTargets?.['*'];
let agentName: string;
if (targetOverride === null) {            // explicit "off" for this one terminal
    …dropped…
} else if (typeof targetOverride === 'string' && targetOverride.trim()) {
    agentName = targetOverride.trim();
} else if (typeof roleDefaultTarget === 'string' && roleDefaultTarget.trim()) {
    agentName = roleDefaultTarget.trim();
} else {
    agentName = (await this._getAgentNameForRole('phone_a_friend', resolvedWorkspaceRoot)) || 'Phone-a-Friend';
}
```

"Which terminal is the Phone-a-Friend?" is already answered, and answered visibly: `phone_a_friend` is a first-class role with its own visibility toggle and startup command in the AGENTS tab (`sharedDefaults.js:14,33,50` — `phone_a_friend: false` by default, label `'Phone-a-Friend'`). A terminal opened for that agent registers with `role: 'phone_a_friend'`, and `_getAgentNameForRole('phone_a_friend', …)` finds it — including PTY-fleet seats — with a literal-name fallback to a terminal called `Phone-a-Friend`.

So both the Target box and the disclosure are duplicate configuration paths for a fact the operator already established somewhere discoverable, expressed as free-text strings with no picker and no validation. The label `Target` names the *map key's value*, not the operator's question, which is why the panel cannot be read: it exposes storage, and the storage's own vocabulary ("target") reads as a destination for a reply.

### Why both resolver branches go with the UI

Deleting only the editors would leave any install that already typed a value routing to a terminal name the operator can no longer see or clear — invisible configuration, which is a worse failure than a confusing label. The per-origin lookup wins over everything else in the chain, so a stale entry silently defeats Phone-a-Friend with nothing on screen to explain it. With both the per-origin and `'*'` branches gone, resolution is the single long-standing path: **the terminal registered to the Phone-a-Friend role** (else one literally named `Phone-a-Friend`). That is one mechanism, visible in the AGENTS tab, and it is what the panel's new copy will state.

Stored keys are **preserved on disk** — the sanitizer keeps accepting and preserving every key it already holds (`agentConfig.ts:294-308`; note that its self-mapping guard deliberately skips `'*'`, since `norm('*')` is empty), so no operator's config is rewritten or dropped by this change. The `'*'` key shipped recently, in the pushed commit `6a4df070` that introduced `roleDefaultTarget`, so no long-standing install behaviour is being rewritten.

## Metadata

- **Complexity:** 3
- **Tags:** ui, ux, frontend, refactor, reliability
- **Project:** Browser Switchboard
- **Feature:** 6a3f99b3-3401-45a0-9cdb-a71653f6c322
- **Consolidated From:** feature_plan_20260817193600_delete-phone-a-friend-per-terminal-override-editor.md, feature_plan_20260817193700_phone-a-friend-target-box-names-nothing.md

## User Review Required

No user decision is required before coding. The deletion shape, the replacement copy, and the preservation guarantees are all grounded in source-verified facts. The two load-bearing claims in the new copy (the friend is resolved from the `phone_a_friend` role registration; the friend does not report back) were checked against `TaskViewerProvider.ts:5650` and the Phone-a-Friend prompt body respectively. Proceed unless the operator wants to keep either surface.

## Complexity Audit

### Routine

- Deleting two self-contained DOM-building blocks (the Target row and the Advanced disclosure) and the one function (`agentsTabPhoneRow`) the disclosure calls, in a file that is a self-contained webview.
- Deleting two adjacent branches in one resolver method and collapsing the chain to a single assignment.
- Rewriting one comment block in `agentPromptBuilder.ts` whose rationale dies with the lookup.
- All deletions are grep-verifiable: the removed identifiers (`agentsTabPhoneRow`, `advToggle`, `advContent`, `targetOverride`, `roleDefaultTarget`, `targetRow`, `targetLabel`, `targetInput`, `defaultTarget`) have no other callers or readers.

### Complex / Risky

- **A wholesale block delete breaks the whole panel.** The `phoneAFriendTargets` materialisation lives *inside* the Target-row region being deleted (`kanban.html:4528-4529`), and the Advanced disclosure's loop reads `cfg.addons.phoneAFriendTargets` unguarded (`const targets = cfg.addons.phoneAFriendTargets;` ~line 4572, then `Object.entries(targets)`). Deleting both regions without keeping the materialisation leaves that read `undefined` and `Object.entries(undefined)` throws — which does not break one control, it kills the render of the entire Phone a friend panel. The materialisation must be kept and hoisted above any remaining consumer (see Proposed Changes step 2).
- **`phoneAFriendTargets` is shipped role-config state** (~4,000 installs, many on older versions). The map must be preserved on disk. Nothing in this change may delete keys, and the sanitizer stays as-is.
- **A second host is mid-flight.** `onPhoneAFriend` is wired only in `TaskViewerProvider.ts:3429`; the standalone/browser host wires no callback today (`bootstrap.ts` contains no `onPhoneAFriend` and no `phoneAFriendTargets` references — verified by repo-wide grep). A separate card may add a standalone twin that copies this resolution chain. The deletion is therefore defined by a repo-wide grep, not by a line number: **no per-origin lookup and no `['*']` read may survive anywhere.**
- **`kanban.html` is a self-contained webview** — the deleted blocks' only wiring is inside the inline script, and the panel loads from the installed VSIX's `dist/`, so verification is UAT in the installed extension, not a `dist/` inspection.

## Edge-Case & Dependency Audit

- **The `'*'` key and the per-origin keys are both removed from the resolver, but neither is deleted from storage.** The sanitizer keeps accepting both (`agentConfig.ts:294-308`). The `'*'` self-mapping guard (`norm('*')` is empty, so the guard skips it) stays untouched. Existing installs with stored values keep them; the values simply stop being consulted.
- **The config-object materialisation must not break.** `cfg.addons.phoneAFriendTargets` is materialised on the role config (not locally) at `kanban.html:4528-4529` specifically because a local `|| {}` made the first write throw and the control silently did nothing. Keep that materialisation in place, hoisted to the top of the region, above any remaining consumer.

  > **Superseded (from the source plans):** The original plans justified keeping the materialisation because "whatever writers remain in the panel depend on it" (per-terminal plan) and "code further down this function also reads it unguarded" (target-box plan).
  > **Reason:** In the merged end-state, the Target-row blur writer, the Advanced-disclosure `Object.entries(targets)` loop, and every `agentsTabPhoneRow` writer are ALL deleted. No remaining code in `agentsTabRenderDelegationPanel` reads or writes through `cfg.addons.phoneAFriendTargets` except the materialisation itself.
  > **Replaced with:** The materialisation is now vestigial — it creates an empty `{}` that the sanitizer discards on save (`Object.keys(map).length > 0` is false, so `a.phoneAFriendTargets` is never set). It is kept as a harmless safety net: if a future change re-adds a reader, the materialisation prevents the `Object.entries(undefined)` throw that motivated it originally. Removing it is safe but expands scope beyond "delete UI + resolver branches"; this plan keeps it to stay minimal.

- **`ADD TARGET` disappears with the disclosure.** It is the only creator of an empty-key entry (`cur.phoneAFriendTargets[''] = ''`), which the sanitizer then discards on load (`if (typeof key !== 'string' || !key.trim()) { continue; }`). Removing it removes a control whose immediate effect was a row that could not be saved empty.
- **The terminal-rename migration stays.** `_migratePhoneAFriendTargetsOnRename` (`TaskViewerProvider.ts:19959+`) fixes both the key side and the value side of the map. Do not delete this function.

  > **Superseded (from the per-terminal plan):** "The value side still matters (values are terminal names for the remaining reader); the key side becomes a no-op on inert keys, which is harmless."
  > **Reason:** The "remaining reader" was the `'*'` reader, which this merged plan also deletes. In the merged end-state the ENTIRE map is inert — no reader consults any key, `'*'` or per-origin. The claim "the value side still matters" is false post-merge.
  > **Replaced with:** The migration is a complete no-op on inert keys, which is harmless. It is kept because it is a data-preservation migration: it keeps stored map entries consistent on terminal rename for any future reader, and deleting it would leave inconsistent data on disk for no benefit. The function is dead but safe; removing it is out of scope.

- **`originTerminal` stays in the `/phone-a-friend` payload.** With both lookups gone it is still load-bearing: it drives the self-dispatch guard (`TaskViewerProvider.ts:5654-5659`) and is echoed into the second-pass prompt. Its builder-side comment, however, justifies omitting-when-unknown *by* the per-instance override lookup (`agentPromptBuilder.ts:734-741`) — that rationale dies with the lookup and must be rewritten rather than left standing as a false statement.
- **The new copy must be true, or this trades one confusion for another.** Two claims are load-bearing and were verified: the friend is resolved from the `phone_a_friend` role registration (`_getAgentNameForRole('phone_a_friend', …)`, `TaskViewerProvider.ts:5650`), and the friend reports to nobody — its prompt ends *"summarize the bugs you found and the fixes you applied"* and explicitly forbids a Stage Complete marker. The copy says exactly those two things and nothing more.
- **The Phone-a-Friend agent is hidden by default.** `phone_a_friend: false` in the role visibility defaults (`sharedDefaults.js:14`), so an operator who never enabled it has no such terminal. The copy must name where it is enabled (AGENTS tab) rather than assume it exists.
- **The literal-name fallback stays.** `|| 'Phone-a-Friend'` covers installs with no role mapping that simply named a terminal `Phone-a-Friend`; it is documented as a compatibility rule at the call site and must not be removed while cleaning up the branches above it.
- **The self-dispatch guard is downstream and untouched.** It compares the resolved target to `originTerminal` and refuses (`TaskViewerProvider.ts:5654-5659`); with two fewer ways to name a target, it is still required — a coder registered as the friend would otherwise be told to review its own work.
- **No confirmation dialog, and no new one.** The removed rows had a `×` button that deleted immediately; nothing in this change adds a gate, and none may be added.
- **Adjacent, out of scope:** the panel's role dropdown iterates all 13 `ROLE_KEYS`, while the addon is only read for `lead`, `coder` and `intern` (`phoneAFriendByRole`, `KanbanProvider.ts:5505-5510`). Enabling the toggle on any other role saves state that is never read. Real, but a different card — do not fix it here, and do not let it be mistaken for a regression from this change.

## Dependencies

- `sess_20260817_teams_panel_rebuild` — the plan that rebuilt the TEAMS tab Phone-a-Friend panel and demoted the override map behind a disclosure. This plan cashes in the debt that plan explicitly accepted.

## Adversarial Synthesis

Key risks: (1) a wholesale block delete that removes the `phoneAFriendTargets` materialisation before the unguarded `Object.entries(targets)` read kills the entire panel render — mitigated by hoisting the materialisation above all consumers; (2) invisible routing from stale stored keys after the editors are gone — mitigated by deleting both resolver branches so stored keys become inert; (3) a standalone twin landing mid-flight with its own copy of the lookup — mitigated by a repo-wide grep completeness check that defines the deletion by symbol, not line number. The change is preservation-correct: no stored key is deleted, the sanitizer and rename migration stay as-is, and the `phone_a_friend` role registration remains the single visible source of truth for who gets called.

## Proposed Changes

### 1. `src/webview/kanban.html:3350-3352` — say what the panel does

Replace the help line (which currently advertises "Advanced per-terminal overrides below.") with copy that explains what the friend does and where it is configured:

```html
          <div style="font-size:11px; color:var(--text-secondary); margin-bottom:8px;">
            Enable Phone-a-Friend per role — when a batch finishes, the Phone-a-Friend terminal is
            asked to check that work and fix what it finds. Saved to role config.
          </div>
```

### 2. `src/webview/kanban.html:4503-4547` — replace the Target row with a statement; keep + hoist the materialisation

Delete the `Target` label, its input, the `'*'` read (`defaultTarget`), and the blur writer. **Keep the materialisation** and hoist it to the top of the region so it sits above any remaining consumer. Replace the row with a static line of copy:

```js
            // Materialise the map on the config, not just locally — remaining
            // editors write through `cfg.addons.phoneAFriendTargets`, and a local
            // `|| {}` left it undefined so the first write threw and the control
            // did nothing at all. Code further down this function also reads it
            // unguarded, so this must stay above them.
            if (!cfg.addons.phoneAFriendTargets || typeof cfg.addons.phoneAFriendTargets !== 'object') {
                cfg.addons.phoneAFriendTargets = {};
            }

            // ── Who gets called ─────────────────────────────────────────────
            // Not a control: the friend is the terminal registered to the
            // phone_a_friend role. A second free-text way to name it read as a
            // reply address and taught nobody anything.
            const whoRow = document.createElement('div');
            whoRow.style.fontSize = '11px';
            whoRow.style.color = 'var(--text-secondary)';
            whoRow.style.marginBottom = '8px';
            whoRow.textContent = 'Calls the Phone-a-Friend terminal (enable that agent in the AGENTS tab). '
                + 'It re-checks the plan this role just coded and fixes what it finds — it does not report back to this role.';
            phoneSection.appendChild(whoRow);
```

### 3. `src/webview/kanban.html:4549-4625` — delete the Advanced disclosure and `agentsTabPhoneRow`

Delete the whole `// ── Advanced: per-terminal override map ──` region: `advToggle`, `advContent`, the `advOpen` flag and its click handler, `targetList` and its `Object.entries(targets)` loop, `addBtn`, and the trailing `appendChild` calls. Then delete the `agentsTabPhoneRow` function (4594-4625) — it has exactly one call site, the loop deleted above. `agentsTabRenderDelegationPanel` then ends:

```js
            phoneSection.appendChild(whoRow);

            container.appendChild(phoneSection);
        }
```

(The `// ── Teams (Agent Groups) ──` block that follows at ~4627 stays untouched.)

### 4. `src/services/TaskViewerProvider.ts:5618-5651` — delete both resolver branches

Before:

```ts
        // Resolve the Phone-a-Friend terminal name from per-instance overrides,
        // falling back to the role default ('*' key), then the workspace singleton.
        const roleConfig: any = this.getRoleConfig(`roleConfig_${originRole}`);
        const targetOverride = typeof originTerminal === 'string' && originTerminal
            ? roleConfig?.addons?.phoneAFriendTargets?.[originTerminal]
            : undefined;
        // The '*' key is the role-level default target, set by the Phone-a-Friend
        // toggle's target select in the TEAMS tab. It sits between the per-terminal
        // override and the workspace singleton fallback.
        const roleDefaultTarget = roleConfig?.addons?.phoneAFriendTargets?.['*'];
        let agentName: string;
        if (targetOverride === null) {
            // The one reachable "none". Absent key means inherit, NOT off.
            this._apiServerDiagnosticsChannel.appendLine(`[Phone-a-Friend] origin=${originTerminal || '<unknown>'} role=${originRole} target=none (explicit off), dropped.`);
            return;
        } else if (typeof targetOverride === 'string' && targetOverride.trim()) {
            agentName = targetOverride.trim();
        } else if (typeof roleDefaultTarget === 'string' && roleDefaultTarget.trim()) {
            // No per-terminal override → use the role-level default target ('*').
            agentName = roleDefaultTarget.trim();
        } else {
            // No override and no role default → the workspace singleton, exactly
            // as before, INCLUDING the literal-name fallback. Two compatibility
            // rules live here:
            //  - `|| 'Phone-a-Friend'`: _getAgentNameForRole returns falsy when the
            //    role has no saved mapping, and the shipped path then matched an open
            //    terminal literally named "Phone-a-Friend". Dropping it silently
            //    unwired every install that never set a mapping.
            //  - No `addons.phoneAFriend === true` gate: the flag governs whether the
            //    DIRECTIVE is emitted, and never governed dispatch. Gating here breaks
            //    in-flight prompts built before this change, which hardcode
            //    `originRole:"coder"` even when the addon lives on lead/intern.
            agentName = (await this._getAgentNameForRole('phone_a_friend', resolvedWorkspaceRoot)) || 'Phone-a-Friend';
        }
```

After — the per-origin lookup, the `'*'` lookup, and all three conditional branches are gone; `roleConfig` is removed (it had no other reader in this method); the two compatibility comments are preserved because they still explain the surviving fallback:

```ts
        // Resolve the Phone-a-Friend terminal name. Per-terminal (origin-keyed)
        // overrides and the role-level default ('*') were removed with their
        // editors: they were hand-typed terminal names with no picker and no
        // validation, and a stale key silently defeated dispatch with nothing on
        // screen to explain it. Existing keys are preserved in role config but are
        // no longer consulted; "off" is the per-role toggle. The friend is the
        // terminal registered to the phone_a_friend role (else one literally named
        // "Phone-a-Friend").
        //
        // Two compatibility rules live in the fallback:
        //  - `|| 'Phone-a-Friend'`: _getAgentNameForRole returns falsy when the
        //    role has no saved mapping, and the shipped path then matched an open
        //    terminal literally named "Phone-a-Friend". Dropping it silently
        //    unwired every install that never set a mapping.
        //  - No `addons.phoneAFriend === true` gate: the flag governs whether the
        //    DIRECTIVE is emitted, and never governed dispatch. Gating here breaks
        //    in-flight prompts built before this change, which hardcode
        //    `originRole:"coder"` even when the addon lives on lead/intern.
        let agentName = (await this._getAgentNameForRole('phone_a_friend', resolvedWorkspaceRoot)) || 'Phone-a-Friend';
```

Everything from the self-dispatch guard down (`TaskViewerProvider.ts:5652+`) is untouched.

### 5. `src/services/agentPromptBuilder.ts:734-741` — rewrite the now-false comment

The block justifies omitting `originTerminal` because *"the host resolves a per-instance override by exact terminal name"*. That resolution no longer exists. Replace with the reason the field is still sent:

```ts
/**
 * `originTerminal` is OMITTED when the builder does not know it, never filled with a
 * placeholder. The host uses it for the self-dispatch guard (a terminal must not be
 * told to review its own work) and echoes it into the second-pass prompt, so a
 * literal `"unknown"` would both defeat the guard's name match and print to the
 * friend as though it were a real terminal. An absent field is the documented
 * backward-compatible payload — older prompts never carried it.
 */
```

### 6. Completeness grep — the deletion is repo-wide, not line-scoped

`grep -rn "phoneAFriendTargets" src/` must return exactly four sites afterwards: the type (`agentConfig.ts:51`), the sanitizer (`agentConfig.ts:294`), and the rename migration (`TaskViewerProvider.ts:19961`). **No** `?.[originTerminal]` lookup and **no** `?.['*']` read may survive anywhere. If a standalone twin has landed in `src/standalone/bootstrap.ts` by the time this is coded, it carries the same `targets?.[originTerminal]` lookup, the same `override === null` drop, and the same `targets?.['*']` read — delete all three there too, in the same shape.

## Verification Plan

### Automated

1. `grep -rn "agentsTabPhoneRow\|Advanced: per-terminal overrides" src/` → no hits (the resolver's new comment deliberately says *"Per-terminal (origin-keyed) overrides were removed"*, so match on the UI phrasing `Advanced: per-terminal overrides` for the zero-hit assertion).
2. `grep -rn "textContent = 'Target'" src/webview/kanban.html` → no hits.
3. `grep -rn "phoneAFriendTargets" src/` → exactly the four sites listed in step 6, and **no** `?.[originTerminal]` or `?.['*']` lookup anywhere.
4. `grep -n "phoneAFriendTargets = {}" src/webview/kanban.html` → still present, and positioned *above* every `cfg.addons.phoneAFriendTargets` read in `agentsTabRenderDelegationPanel` (read the function once to confirm ordering — this is the throw-the-whole-panel risk).
5. `npx eslint src` clean on the two edited `.ts` files.
6. `npm run test:contract:orchestrator-tick`, `npm run parity:check`, `npm run standalone-parity:check`, `npm run mirror:check`, `npm run catalog:check` — all green (none asserts on this UI today; the point is proving no collateral break).

### Manual (installed VSIX — `dist/` is not used for testing)

7. Package and install, open the board → TEAMS tab → **Phone a friend**. The panel shows the role select, the enable checkbox, and one line of copy naming the Phone-a-Friend terminal and where to enable it, and stating that the friend does not report back. No `Target` label, no text box, no "▶ Advanced: per-terminal overrides" button, no `ADD TARGET`, no origin/target rows. The help line no longer mentions overrides.
8. Cycle the role select through every role. The panel re-renders each time with **no console error** — this is the regression guard for the materialisation ordering, and it is the check that catches a wholesale block delete.
9. Toggle the enable checkbox on `coder`, reload the board, confirm it persisted — the surviving writer still saves through the materialised config object.
10. **Routing check.** Enable the Phone-a-Friend agent in the AGENTS tab, open its terminal, dispatch a batch to a coder with the toggle on, and confirm the second-pass prompt lands in that terminal. Then close it and repeat: the API-server diagnostics channel logs `[Phone-a-Friend] … no terminal running, dropped.` and nothing is sent.
11. **Preservation check (per-origin).** With a role config that already contains a per-origin entry (hand-seed `phoneAFriendTargets: {"Coder 1": "Phone-a-Friend"}` into the stored role config before installing), confirm after the upgrade that (a) the entry is **still present** in the persisted role config, and (b) a batch-end `POST /phone-a-friend` from `Coder 1` now resolves to the registered Phone-a-Friend seat, not to the stale entry. Watch the `[Phone-a-Friend]` lines in the API-server diagnostics channel.
12. **Preservation check (`'*'`).** Hand-seed a role config with `phoneAFriendTargets: {"*": "Some Old Name"}` before installing. After the upgrade confirm (a) the `"*"` entry is **still present** in the persisted role config, and (b) dispatch resolves to the registered Phone-a-Friend seat, not to `Some Old Name`.
13. **The off-switch still exists.** Uncheck the per-role enable toggle, dispatch a batch, and confirm no `PHONE-A-FRIEND:` directive appears in the coder's prompt — the capability the deleted `"off"` select duplicated is intact.
