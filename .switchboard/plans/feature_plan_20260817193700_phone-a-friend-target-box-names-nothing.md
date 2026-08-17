# The Phone-a-Friend "Target" Box Asks a Question It Never Explains — Say Who Gets Called Instead

## Goal

The Phone a friend panel in the TEAMS tab of `kanban.html` must be readable without knowing the resolver's internals. The operator picks a role and ticks a box; the panel then states, in words, which terminal gets called. The unlabelled free-text **Target** box goes.

The operator's reading of it is the evidence: *"I selected the role I want phone a friend on, what the hell is the 'target'? what the phone a friend replies back to?"* — a control that gets guessed at as a reply address is not a control, and the guess is wrong in a way that matters (Phone-a-Friend replies to nobody; it is a second pass on the plan, not a message round-trip).

### Problem analysis

The panel renders three things for the selected role (`agentsTabRenderDelegationPanel`, `src/webview/kanban.html:4463-4590`): an enable checkbox, then a row labelled exactly `Target` with a free-text input (`kanban.html:4502-4546`), then a disclosure. The label is one word, the placeholder is `Phone-a-Friend (default)`, and nothing on screen says what the field addresses, what values are legal, or what happens when it is empty:

```js
const targetLabel = document.createElement('label');
targetLabel.textContent = 'Target';
const targetInput = document.createElement('input');
targetInput.type = 'text';
targetInput.placeholder = 'Phone-a-Friend (default)';
```

It is a terminal name, typed by hand, written into a reserved `'*'` key of the role's `phoneAFriendTargets` map on blur. Its only reader is the middle branch of the dispatch resolver:

```ts
// The '*' key is the role-level default target, set by the Phone-a-Friend
// toggle's target select in the TEAMS tab.
const roleDefaultTarget = roleConfig?.addons?.phoneAFriendTargets?.['*'];
…
} else if (typeof roleDefaultTarget === 'string' && roleDefaultTarget.trim()) {
    agentName = roleDefaultTarget.trim();
} else {
    agentName = (await this._getAgentNameForRole('phone_a_friend', resolvedWorkspaceRoot)) || 'Phone-a-Friend';
}
```
(`TaskViewerProvider.ts:5721-5748`)

### Root cause — a second way to say something the role system already says

"Which terminal is the Phone-a-Friend?" is already answered, and answered visibly: `phone_a_friend` is a first-class role with its own visibility toggle and startup command in the AGENTS tab (`kanban.html:3188`, `BUILT_IN_AGENT_LABELS` / `DEFAULT_ROLE_CONFIG` in `sharedDefaults.js:33,50`). A terminal opened for that agent registers with `role: 'phone_a_friend'`, and `_getAgentNameForRole('phone_a_friend', …)` finds it — including PTY-fleet seats — with a literal-name fallback to a terminal called `Phone-a-Friend`.

So the box is a duplicate configuration path for a fact the operator already established somewhere discoverable, expressed as a free-text string with no picker and no validation. The label `Target` names the *map key's value*, not the operator's question, which is why the panel cannot be read: it exposes storage, and the storage's own vocabulary ("target") reads as a destination for a reply.

The comment above the block calls it a "select"; it is a text input. Even the code that built it describes a control that was never shipped.

### Why the `'*'` resolver branch goes with the box

Removing only the editor would leave any install that already typed a value routing to a terminal name the operator can no longer see or clear — invisible configuration, which is a worse failure than a confusing label. With the branch gone, resolution is the single long-standing path: **the terminal registered to the Phone-a-Friend role** (else one literally named `Phone-a-Friend`). That is one mechanism, visible in the AGENTS tab, and it is what the panel's new copy will state.

Stored `'*'` values are **preserved on disk** — the sanitizer keeps accepting the key (`agentConfig.ts:294-308`; note that its self-mapping guard deliberately skips `'*'`, since `norm('*')` is empty) — they simply stop being consulted. The `'*'` key shipped recently, in the pushed commit `6a4df070` that introduced `roleDefaultTarget`, so no long-standing install behaviour is being rewritten.

## Metadata

- **Complexity:** 3
- **Tags:** ui, ux, frontend, reliability
- **Project:** Browser Switchboard

## Complexity Audit

### Routine

- Deleting a DOM row from one webview render function and replacing it with a static line of copy.
- Deleting one branch from one resolver method.
- Both are grep-verifiable; the removed identifiers (`targetRow`, `targetLabel`, `targetInput`, `defaultTarget`, `roleDefaultTarget`) have no other readers.

### Complex / Risky

- **A wholesale block delete breaks the whole panel.** The `phoneAFriendTargets` materialisation lives *inside* the region being deleted (`kanban.html:4527-4529`), and code further down the same function reads `cfg.addons.phoneAFriendTargets` unguarded (`const targets = cfg.addons.phoneAFriendTargets;`, ~line 4570, then `Object.entries(targets)`). Deleting lines 4502–4546 as one block leaves that read `undefined` and `Object.entries(undefined)` throws — which does not break one control, it kills the render of the entire Phone a friend panel. The materialisation must be kept and relocated above the remaining consumers.
- **`addons.phoneAFriendTargets` is shipped role-config state** (~4,000 installs). Preserve every stored key; delete none.
- **A second host is mid-flight.** `onPhoneAFriend` is wired only at `TaskViewerProvider.ts:3541` today (`bootstrap.ts` has no such option), and a separate card is adding a standalone twin that copies this resolution chain including the `'*'` read. The deletion is therefore defined by a repo-wide grep for `['*']` on this map, not by a line number.
- **`kanban.html` is a self-contained webview**, and the panel served to the operator comes from the installed VSIX — verification is UAT in the installed extension, not an inspection of the repo's `dist/`.

## Edge-Case & Dependency Audit

- **The new copy must be true, or this trades one confusion for another.** Two claims are load-bearing and were verified: the friend is resolved from the `phone_a_friend` role registration (`_getAgentNameForRole('phone_a_friend', …)`, `TaskViewerProvider.ts:5747`), and the friend reports to nobody — its prompt ends *"summarize the bugs you found and the fixes you applied"* and explicitly forbids a Stage Complete marker (`TaskViewerProvider.ts:5797`). The copy says exactly those two things and nothing more.
- **The Phone-a-Friend agent is hidden by default.** `phone_a_friend: false` in the role visibility defaults (`sharedDefaults.js:14`), so an operator who never enabled it has no such terminal. The copy must name where it is enabled (AGENTS tab) rather than assume it exists.
- **The literal-name fallback stays.** `|| 'Phone-a-Friend'` covers installs with no role mapping that simply named a terminal `Phone-a-Friend`; it is documented as a compatibility rule at the call site and must not be removed while cleaning up the branch above it.
- **The self-dispatch guard is downstream and untouched.** It compares the resolved target to `originTerminal` and refuses (`TaskViewerProvider.ts:5751-5756`); with one fewer way to name a target, it is still required — a coder registered as the friend would otherwise be told to review its own work.
- **No confirmation dialog, and no new one.** Nothing in this change adds a gate.
- **Non-`'*'` keys in the map are not this change's business.** The map's other keys have their own reader and their own editor; leave both exactly as found. Preserving the materialisation (above) is what keeps them working.
- **Adjacent, out of scope:** the panel's role dropdown offers all 13 `ROLE_KEYS`, but the addon is only read for `lead`, `coder` and `intern` (`phoneAFriendByRole`, `KanbanProvider.ts:5505-5510`). Ticking the box on `reviewer` or `tester` saves state nothing reads, so the panel silently accepts a setting that can never fire. Real defect, different card — do not fix it here, and do not let it be mistaken for a regression from this change.

## Proposed Changes

### 1. `src/webview/kanban.html:3348-3351` — say what the panel does

```html
          <div style="font-size:11px; color:var(--text-secondary); margin-bottom:8px;">
            Enable Phone-a-Friend per role — when a batch finishes, the Phone-a-Friend terminal is
            asked to check that work and fix what it finds. Saved to role config.
          </div>
```

### 2. `src/webview/kanban.html:4502-4546` — replace the Target row with a statement

Delete the `Target` label, its input, the `'*'` read (`defaultTarget`) and the blur writer. **Keep the materialisation** and hoist it to the top of the region so the code below it is unaffected:

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

### 3. `src/services/TaskViewerProvider.ts:5721-5734` — delete the `'*'` branch

Before:

```ts
// The '*' key is the role-level default target, set by the Phone-a-Friend
// toggle's target select in the TEAMS tab. It sits between the per-terminal
// override and the workspace singleton fallback.
const roleDefaultTarget = roleConfig?.addons?.phoneAFriendTargets?.['*'];
…
} else if (typeof roleDefaultTarget === 'string' && roleDefaultTarget.trim()) {
    // No per-terminal override → use the role-level default target ('*').
    agentName = roleDefaultTarget.trim();
} else {
```

After — the declaration and its branch are gone; every other branch, including the `else` with its two documented compatibility fallbacks, is unchanged:

```ts
// The role-level default target ('*') was removed with its editor: it was a
// hand-typed terminal name duplicating the phone_a_friend role registration,
// and once the box was gone a stored value would have routed somewhere the
// operator could no longer see. Existing '*' values stay in role config but are
// no longer consulted — the friend is the terminal registered to the role.
} else {
```

Keep the existing `else` body verbatim (`_getAgentNameForRole('phone_a_friend', …) || 'Phone-a-Friend'` and both compatibility comments).

### 4. Completeness grep

`grep -rn "phoneAFriendTargets" src/` must show no `['*']` read anywhere afterwards. If a standalone twin has landed in `src/standalone/bootstrap.ts` by the time this is coded, it carries `targets?.['*']` in the same chain — remove it there too, in the same shape.

## Verification Plan

### Automated

1. `grep -rn "textContent = 'Target'" src/webview/kanban.html` → no hits.
2. `grep -rn "phoneAFriendTargets\?\.\['\*'\]\|phoneAFriendTargets\['\*'\]" src/` → no hits.
3. `grep -n "phoneAFriendTargets = {}" src/webview/kanban.html` → still present, and positioned *above* every `cfg.addons.phoneAFriendTargets` read in `agentsTabRenderDelegationPanel` (read the function once to confirm ordering — this is the throw-the-whole-panel risk).
4. `npx eslint src` clean; `npm run parity:check`, `npm run standalone-parity:check`, `npm run mirror:check`, `npm run catalog:check` all green.

### Manual (installed VSIX — `dist/` is not used for testing)

5. Package and install, open the board → TEAMS tab → **Phone a friend**. There is no `Target` label and no text box. In its place is one line naming the Phone-a-Friend terminal and where to enable it, and stating that the friend does not report back.
6. Cycle the role select through every role. The panel re-renders each time with **no console error** — this is the regression guard for the materialisation ordering, and it is the check that catches a wholesale block delete.
7. Tick the enable checkbox on `coder`, reload the board, confirm it persisted.
8. **Routing check.** Enable the Phone-a-Friend agent in the AGENTS tab, open its terminal, dispatch a batch to a coder with the toggle on, and confirm the second-pass prompt lands in that terminal. Then close it and repeat: the API-server diagnostics channel logs `[Phone-a-Friend] … no terminal running, dropped.` and nothing is sent.
9. **Preservation check.** Hand-seed a role config with `phoneAFriendTargets: {"*": "Some Old Name"}` before installing. After the upgrade confirm (a) the `"*"` entry is **still present** in the persisted role config, and (b) dispatch resolves to the registered Phone-a-Friend seat, not to `Some Old Name`.
