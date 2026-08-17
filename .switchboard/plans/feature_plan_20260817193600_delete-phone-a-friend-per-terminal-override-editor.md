# Delete the Phone-a-Friend "Advanced: Per-Terminal Overrides" Editor — It Is Raw Plumbing on Screen

## Goal

The Phone a friend panel in the TEAMS tab of `kanban.html` must show the operator only controls they can act on. The "Advanced: per-terminal overrides" disclosure is not one: it asks for an origin terminal name, a two-value mode select, and a target terminal name, typed free-hand, describing a routing map that has no counterpart anywhere else in the UI. It goes, and so does the stored map's effect on routing, so that deleting the screen does not leave invisible routing behind it.

### Problem analysis

The disclosure renders `roleConfig.addons.phoneAFriendTargets` — an origin-terminal → target-terminal string map — directly as UI (`src/webview/kanban.html:4548-4589`, with the row editor at `4593-4624`). Each row is three free-text/select controls whose meaning is only legible if you already know the resolver's shape:

```js
row.innerHTML = '<input type="text" placeholder="origin terminal" style="flex:1;">'
  + '<select style="width:80px;"><option value="target">target</option><option value="off">off</option></select>'
  + '<input type="text" placeholder="target terminal" style="flex:1;"><button class="strip-btn">×</button>';
```

"origin terminal" and "target terminal" are storage keys with a placeholder attached. There is no picker, no validation, and no live-terminal list — a typo produces a map entry that matches nothing and reports nothing. The panel's own help text advertises it as a feature: *"Advanced per-terminal overrides below."* (`kanban.html:3350`).

**This is a known-and-accepted debt being cashed in, not a discovery.** The plan that rebuilt this panel (`.switchboard/plans/teams-tab-three-presets-and-phone-a-friend.md`) says so in its own words: *"Phone-a-Friend's UI is raw plumbing… That is the override mechanism exposed as the primary control"*, and it chose to demote the map behind a disclosure rather than remove it, on the grounds that it is shipped state. Demoting it kept it on screen. The operator's verdict on the demoted version is that it is meaningless.

### Root cause — the map was exposed because it exists, not because anyone configures routing per terminal

There is exactly one consumer of a per-origin entry, `TaskViewerProvider._dispatchPhoneAFriend`:

```ts
const targetOverride = typeof originTerminal === 'string' && originTerminal
    ? roleConfig?.addons?.phoneAFriendTargets?.[originTerminal]
    : undefined;
…
if (targetOverride === null) {            // explicit "off" for this one terminal
    …dropped…
} else if (typeof targetOverride === 'string' && targetOverride.trim()) {
    agentName = targetOverride.trim();
}
```
(`TaskViewerProvider.ts:5717-5731`)

Both branches are reachable only by hand-typing an exact terminal name into the disclosure. The "off" branch duplicates the per-role enable checkbox that sits at the top of the same panel. Nothing else in Switchboard writes a per-origin key: a repo-wide grep for `phoneAFriendTargets` returns four sites only — the type and sanitizer (`agentConfig.ts:51,294-308`), this resolver read, and the terminal-rename migration (`TaskViewerProvider.ts:20039-20076`).

### Why the resolver branch goes with the UI

Deleting only the editor would leave any install that already has a per-origin entry routing to a terminal name the operator can no longer see or clear — and because the per-origin lookup wins over everything else in the chain, a stale entry silently defeats Phone-a-Friend with nothing on screen to explain it. That is a worse outcome than the confusing disclosure. Removing the lookup makes the stored keys inert, so what the operator sees is what happens.

The stored map is **not** deleted. `addons.phoneAFriendTargets` is shipped state; the sanitizer keeps accepting and preserving every key it already holds, so no operator's config is rewritten or dropped by this change.

## Metadata

- **Complexity:** 3
- **Tags:** ui, frontend, refactor, reliability
- **Project:** Browser Switchboard

## Complexity Audit

### Routine

- Deleting a self-contained DOM-building block and the one function it calls, in a file that is a self-contained webview.
- Deleting one resolution branch in one method.
- Both deletions are grep-verifiable: the removed identifiers (`agentsTabPhoneRow`, `advToggle`, `advContent`, `targetOverride`) have no other callers.

### Complex / Risky

- **`phoneAFriendTargets` is shipped role-config state** (~4,000 installs, many on older versions). The map must be preserved on disk. Nothing in this change may delete keys, and the sanitizer stays as-is.
- **A second host is mid-flight.** `onPhoneAFriend` is wired only in `TaskViewerProvider.ts:3541`; the standalone/browser host wires no callback today (`bootstrap.ts` contains no `onPhoneAFriend`). A separate card is adding a standalone twin that copies this exact resolution chain. The deletion is therefore defined by a repo-wide grep, not by a line number: **no per-origin lookup may survive anywhere.**
- **`kanban.html` is a self-contained webview** — the deleted block's only wiring is inside its own inline script, and the panel loads from the installed VSIX's `dist/`, so verification is UAT in the installed extension, not a `dist/` inspection.

## Edge-Case & Dependency Audit

- **The `'*'` key is a different control and stays untouched by this change.** The disclosure's row loop already skips it (`if (origin === '*') { continue; }`), and the resolver's `'*'` read is a separate branch from the per-origin lookup. This change owns the non-`'*'` key space only; the `'*'` reader and its editor keep working exactly as they do today.
- **The config-object materialisation must not break the remaining editors.** `cfg.addons.phoneAFriendTargets` is created on the role config (not locally) at `kanban.html:4527-4529` specifically because a local `|| {}` made the first write throw and the control silently do nothing. Leave that materialisation in place: whatever writers remain in the panel depend on it.
- **`ADD TARGET` disappears with the disclosure.** It is the only creator of an empty-key entry (`cur.phoneAFriendTargets[''] = ''`), which the sanitizer then discards on load (`if (typeof key !== 'string' || !key.trim()) { continue; }`). Removing it removes a control whose immediate effect was a row that could not be saved empty.
- **The terminal-rename migration stays.** `_migratePhoneAFriendTargetsOnRename` fixes both the key side and the *value* side of the map. The value side still matters (values are terminal names for the remaining reader); the key side becomes a no-op on inert keys, which is harmless. Do not delete this function.
- **`originTerminal` stays in the `/phone-a-friend` payload.** With the per-origin lookup gone it is still load-bearing: it drives the self-dispatch guard (`TaskViewerProvider.ts:5751-5756`) and is echoed into the second-pass prompt. Its builder-side comment, however, justifies omitting-when-unknown *by* the per-instance override lookup (`agentPromptBuilder.ts:718-725`) — that rationale dies with the lookup and must be rewritten rather than left standing as a false statement.
- **No confirmation dialog.** The removed rows had a `×` button that deleted immediately; nothing in this change adds a gate, and none may be added.
- **Adjacent, out of scope:** the panel's role dropdown iterates all 13 `ROLE_KEYS`, while the addon is only read for `lead`, `coder` and `intern` (`KanbanProvider.ts:5505-5510`). Enabling the toggle on any other role saves state that is never read. Real, but a different card.

## Proposed Changes

### 1. `src/webview/kanban.html:3348-3351` — stop advertising the disclosure

```html
          <div style="font-size:11px; color:var(--text-secondary); margin-bottom:8px;">
            Enable Phone-a-Friend per role — a second-pass coder notified when a batch finishes. Saved to role config.
          </div>
```

(The sentence *"Advanced per-terminal overrides below."* is removed; the rest of the line is unchanged.)

### 2. `src/webview/kanban.html:4548-4589` — delete the disclosure block

Delete the whole `// ── Advanced: per-terminal override map ──` region: `advToggle`, `advContent`, the `advOpen` flag and its click handler, `targetList` and its `Object.entries(targets)` loop, `addBtn`, and the four trailing `appendChild` calls. `agentsTabRenderDelegationPanel` then ends:

```js
            targetRow.appendChild(targetLabel);
            targetRow.appendChild(targetInput);
            phoneSection.appendChild(targetRow);

            container.appendChild(phoneSection);
        }
```

### 3. `src/webview/kanban.html:4593-4624` — delete `agentsTabPhoneRow`

The function has exactly one call site, the loop deleted in step 2. Remove the whole function (and only it — the `// ── Teams (Agent Groups) ──` block that follows at 4626 stays).

### 4. `src/services/TaskViewerProvider.ts:5715-5731` — delete the per-origin lookup

Before:

```ts
const roleConfig: any = this.getRoleConfig(`roleConfig_${originRole}`);
const targetOverride = typeof originTerminal === 'string' && originTerminal
    ? roleConfig?.addons?.phoneAFriendTargets?.[originTerminal]
    : undefined;
const roleDefaultTarget = roleConfig?.addons?.phoneAFriendTargets?.['*'];
let agentName: string;
if (targetOverride === null) {
    this._apiServerDiagnosticsChannel.appendLine(`… target=none (explicit off), dropped.`);
    return;
} else if (typeof targetOverride === 'string' && targetOverride.trim()) {
    agentName = targetOverride.trim();
} else if (typeof roleDefaultTarget === 'string' && roleDefaultTarget.trim()) {
```

After — the per-origin branch and its "explicit off" sibling are gone; the remaining chain is unchanged:

```ts
// Resolve the Phone-a-Friend terminal name. Per-terminal (origin-keyed)
// overrides were removed with their editor: they were hand-typed terminal
// names with no picker and no validation, and a stale key silently defeated
// dispatch with nothing on screen to explain it. Existing keys are preserved
// in role config but no longer consulted; "off" is the per-role toggle.
const roleConfig: any = this.getRoleConfig(`roleConfig_${originRole}`);
const roleDefaultTarget = roleConfig?.addons?.phoneAFriendTargets?.['*'];
let agentName: string;
if (typeof roleDefaultTarget === 'string' && roleDefaultTarget.trim()) {
```

The final `else` (workspace singleton + the two documented compatibility fallbacks) is untouched, as is everything from the self-dispatch guard down.

### 5. `src/services/agentPromptBuilder.ts:718-725` — rewrite the now-false comment

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

`grep -rn "phoneAFriendTargets" src/` must return exactly four sites afterwards: the type (`agentConfig.ts:51`), the sanitizer (`agentConfig.ts:294`), the `'*'` read in `_dispatchPhoneAFriend`, and the rename migration. If a standalone twin has landed in `src/standalone/bootstrap.ts` by the time this is coded, it carries the same `targets?.[originTerminal]` lookup and the same `override === null` drop — delete both there too, in the same shape.

## Verification Plan

### Automated

1. `grep -rn "agentsTabPhoneRow\|per-terminal override" src/` → no hits (comments included; the resolver's new comment deliberately says *"Per-terminal (origin-keyed) overrides were removed"*, so match on the UI phrasing `Advanced: per-terminal overrides` for the zero-hit assertion).
2. `grep -rn "phoneAFriendTargets" src/` → exactly the four sites listed in step 6, and **no** `?.[originTerminal]` lookup anywhere.
3. `node scripts/../src/test/...` — run the suites that touch this file's neighbours: `npm run test:contract:orchestrator-tick`, `npm run parity:check`, `npm run standalone-parity:check`, `npm run mirror:check`, `npm run catalog:check`. All green (none asserts on this UI today; the point is proving no collateral break).
4. `npx eslint src` clean on the two edited `.ts` files.

### Manual (installed VSIX — `dist/` is not used for testing)

5. Package and install, open the board → TEAMS tab → **Phone a friend**. The panel shows the role select, the enable checkbox, and the target row. No "▶ Advanced: per-terminal overrides" button, no `ADD TARGET`, no origin/target rows. The help line no longer mentions overrides.
6. Switch the role select across several roles: the panel re-renders each time with no console error (the deleted loop over `Object.entries(targets)` was inside the render path).
7. Toggle the enable checkbox on `coder`, reload the board, confirm it persisted — the surviving writers still save through the materialised config object.
8. **Preservation check.** With a role config that already contains a per-origin entry (hand-seed `phoneAFriendTargets: {"Coder 1": "Phone-a-Friend"}` into the stored role config before installing), confirm after the upgrade that (a) the entry is **still present** in the persisted role config, and (b) a batch-end `POST /phone-a-friend` from `Coder 1` now resolves to the role default or the registered Phone-a-Friend seat, not to the stale entry. Watch the `[Phone-a-Friend]` lines in the API-server diagnostics channel.
9. **The off-switch still exists.** Uncheck the per-role enable toggle, dispatch a batch, and confirm no `PHONE-A-FRIEND:` directive appears in the coder's prompt — the capability the deleted `"off"` select duplicated is intact.
