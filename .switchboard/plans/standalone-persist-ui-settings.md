# Standalone: persist UI settings instead of holding them in a process-local Map

## Goal

Give the headless host a durable settings store so `getSetting` / `saveSetting` behave as they do in
the extension. Today every setting written from a browser panel is lost on restart, and every read
starts empty — which is the underlying reason the terminals role picker falls back to a hardcoded list.

**The deliverable is a deletion, not an implementation.** `KanbanProvider` already contains the exact
durable, prefixed, key-guarded, four-tier `getSetting`/`saveSetting` arms this plan was going to
rebuild, both verbs are already in `KANBAN_VERBS`, and once `standalone-workspace-root-wiring` lands
they work headlessly. So the fix is to retire `bootstrap.ts`'s `uiSettings` Map and its two
hand-rolled arms so both verbs fall through to the provider — see the Superseded callout in
Complex / Risky.

### Root problem / background (verified 2026-08-04; re-verified against source 2026-08-04)

`src/standalone/bootstrap.ts:300`:

```ts
const uiSettings = new Map<string, any>();
```

That Map is the entire settings store for the headless host. It is created at boot, never hydrated
from disk, and never written to disk.

The two arms that use it:

- `getSetting` (`:713-722`) — `uiSettings.get(key)`, so on a fresh boot **every** key is `undefined`.
- `saveSetting` (`:724-729`) — `uiSettings.set(key, value)`, and *only* `selectedRole` is additionally
  persisted via `hostState.update('selectedRole', value)`.

Consequences:

1. **Every panel setting resets on restart** except `selectedRole`. Anything a browser panel persists
   through `saveSetting` — tab selection, view toggles, filters, per-panel preferences — is gone the
   next time the CLI starts.
2. **Reads can never find pre-existing configuration.** The extension's `getSetting` resolves through
   a four-tier chain (`KanbanProvider._getScopedSetting:636-670`: project config → workspace DB config
   → globalState → legacy DB config). Standalone's resolves through an empty Map. So a workspace
   configured in VS Code presents as unconfigured in the browser, even though the values sit in
   `kanban.db`'s `config` table that standalone already has open.
3. **This is the disease behind the role-picker bug.** `terminals.js` asks `getSetting` for
   `agents.visibleAgents`; in the extension the answer is `undefined` because of a key-prefix mismatch,
   and in standalone it is `undefined` because the store is empty. The sibling plan
   `standalone-role-picker-visible-agents` fixes that one read properly by going to the machine-global
   agent config, but every *other* `getSetting` caller in standalone remains on empty ground.

Standalone already has the pieces to fix this. `KanbanDatabase` exposes a `config` table with
`getConfigJsonSync` / project-scoped variants (used throughout `_getScopedSetting`), the DB is open and
migrated at boot, and `hostState` already persists one key — so the durable-write path exists and is
used for exactly one value.

### What the provider already does (measured, and why this plan shrank)

`KanbanProvider._handleMessage` carries complete arms for both verbs — `saveSetting` at `:10085-10101`
and `getSetting` at `:10102-10118` — and both `'getSetting'` and `'saveSetting'` are present in
`KANBAN_VERBS` (`src/generated/verbAllowlist.ts:7`). The `getSetting` arm, verbatim:

```ts
case 'getSetting': {
    if (this._kanbanService) { return await this._kanbanService.getSetting(msg); }
    const { key } = msg;
    if (typeof key !== 'string') return { success: false, error: 'Key is not a string' };
    const fullKey = `switchboard.prompts.${key}`;
    let value: any;
    if (key === 'selectedRole') {
        value = this._context.workspaceState.get(fullKey);
    } else if (key.startsWith('roleConfig_')) {
        const roleName = key.replace('roleConfig_', '');
        value = this.getScopedRoleConfig(roleName, msg.initiatorProject);
    } else {
        value = this._getScopedSetting(fullKey, undefined, msg.initiatorProject);
    }
    this.postMessage({ type: 'settingResult', key, value });
    return { success: true, key, value };
}
```

Every element this plan specified as new work is already there:

| This plan's spec | Already in the provider arm |
| :--- | :--- |
| apply the `switchboard.prompts.` prefix | `const fullKey = \`switchboard.prompts.${key}\`` |
| reject non-string keys with a clean error | `if (typeof key !== 'string') return { success: false, error: 'Key is not a string' }` |
| resolve project tier then workspace DB tier | `_getScopedSetting(fullKey, undefined, msg.initiatorProject)` (four tiers) |
| keep the `settingResult` WS broadcast | `this.postMessage({ type: 'settingResult', key, value })` |
| preserve the `selectedRole` special case | `this._context.workspaceState.get(fullKey)` — standalone's `workspaceState` **is** the file-backed memento (`bootstrap.ts:566-567`), so it persists |
| return in body | `return { success: true, key, value }` — PRD contract #4 compliant |
| `roleConfig_*` routing | `getScopedRoleConfig` / `updateScopedRoleConfig` |

The only reason these arms do not serve standalone today is that `bootstrap.ts`'s hand-rolled arms
claim the verb names first (and, before `standalone-workspace-root-wiring`, that
`_getScopedSetting` could not reach the DB tier).

## Metadata
- **Tags:** backend, reliability, cli, bugfix, refactor
- **Complexity:** 3

## Architecture Review — the approach was challenged

**The plan's original approach:** write new `readUiSetting` / `writeUiSetting` helpers in
`bootstrap.ts` that talk directly to the `kanban.db` `config` table, keep the Map as a write-through
cache, and invalidate it on `setProjectFilter`.

**Alternatives:**

1. **Retire the hand-rolled arms; fall through to `KanbanProvider` (chosen).** Deletes ~20 lines,
   adds no store, and inherits the extension's exact semantics — including two tiers the original
   approach explicitly gave up (globalState and the legacy DB tier) and the key guard it planned to
   add. Requires `standalone-workspace-root-wiring` (which is sequenced first anyway) and requires the
   fallthrough to pass `initiatorProject`.
2. **Parallel direct-DB helpers in bootstrap (the plan's original).** Creates a *fifth* settings
   store with its own two-tier subset, its own cache and its own invalidation rule — three new places
   for the project-scope staleness bug this codebase has already been bitten by. Its own Complex/Risky
   section identified the reuse hazard and then concluded "the direct-DB helpers specified below are
   correct as written", which inverted the right answer once plan-1 ordering is taken into account.
3. **Keep the Map, hydrate it from the DB at boot.** Simplest, but a snapshot: an editor-side write
   after boot stays invisible, and the write path still diverges from the extension's.

**Justification.** (1) removes code instead of adding a store, and the sequencing objection that
justified (2) no longer holds: `standalone-workspace-root-wiring` is step 1 of this feature and
`standalone-board-verb-rail-fallthrough` is step 2, so by the time this lands the provider's arms are
both reachable and DB-backed.

**Goal-vs-appearance probe.** "Settings persist" is trivially fakeable — a value written and read back
inside one process proves nothing. The acceptance oracle must be **cross-process** (write, kill the
server, boot again, read) and **cross-host** (a row seeded as the editor writes it is visible to the
browser). Both are in the Verification Plan. A subtler appearance risk is specific to approach (1):
if the fallthrough does not forward `initiatorProject`, every scoped read and write silently resolves
on the workspace tier — settings *do* persist, on the wrong tier, with no error. That is why the
`initiatorProject` assertion is a pass-bar item and not a nicety.

## User Review Required (decisions, with defaults)

1. **Where do standalone settings live?**
   **Default (recommended): wherever the extension puts them** — i.e. delegate to
   `KanbanProvider._getScopedSetting` / `_updateScopedSetting` and inherit the `kanban.db` `config` /
   `project_config` split unchanged. This makes settings written in the browser visible to the editor
   and vice versa, which is the behaviour a user expects from "the same board, two front ends", and it
   guarantees the two hosts cannot drift.

   > **Superseded:** "Default: the workspace `kanban.db` `config` table, using the same keys the
   > extension's DB tier uses" — implemented by new bootstrap-local helpers.
   > **Reason:** Right destination, wrong vehicle. Reimplementing the tier logic in a second place is
   > how the two hosts drift; the provider already owns it.
   > **Replaced with:** delegate to the provider; write no new store.

2. **Should standalone mirror the extension's full four-tier resolution?**

   > **Superseded:** "Default: two tiers — project config, then workspace DB config. GlobalState does
   > not exist headlessly and the legacy tier is a migration artifact."
   > **Reason:** The premise is false. Standalone *does* have a globalState — `bootstrap.ts:529-567`
   > installs a file-backed memento as both `globalState` and `workspaceState` — which is exactly why
   > the provider's `selectedRole` path persists there. Dropping two tiers would make standalone
   > answer differently from the editor for keys that live in them.
   > **Replaced with:** **all four tiers, by delegation.** No tier subset, no second convention.

3. **Key namespace: match the extension's `switchboard.prompts.` prefix, or store bare keys?**
   **Default: match the extension** — automatic under delegation, since the provider applies the
   prefix itself (`fullKey`). Bare keys would read cleaner and be silently incompatible: the exact
   failure mode this plan exists to end.

4. **What happens to the existing `selectedRole` value in `hostState`?**
   **Default: accept the one-time loss and note it.** Today standalone writes `selectedRole` to
   `hostState` under the **bare** key; the provider reads/writes `workspaceState` under
   `switchboard.prompts.selectedRole`. After delegation the old value is orphaned and the picker
   falls back to its default once. Both stores are the same JSON file, so a three-line migration
   (copy bare → prefixed if the prefixed key is absent) is available if the reset is judged
   unacceptable — but the browser host is unreleased, so a clean break is the cheaper call.

## Complexity Audit

### Routine
- Deleting the Map (`:300`) and two arms (`:713-729`) is a small, local, subtractive edit.
- The replacement behaviour needs no new code: `standalone-board-verb-rail-fallthrough`'s `default:`
  arm already routes unclaimed verbs to `kanbanProvider.handleServiceVerb`, and both verbs are in
  `KANBAN_VERBS`.

### Complex / Risky

> **Superseded:** "**Do NOT reuse `KanbanProvider._getScopedSetting` for this — it is blind in this
> host.** ... The direct-DB helpers specified below are correct as written; the hazard is an
> implementer reaching for the existing helper because it looks like the obvious reuse and getting
> defaults with no error. Once `standalone-workspace-root-wiring` lands, `_getScopedSetting` becomes
> usable headlessly and delegating to it is a worthwhile simplification — but that is a follow-up, not
> this plan."
> **Reason:** The blindness is real *today* and the diagnosis was exactly right, but the conclusion
> inverted the sequencing. `standalone-workspace-root-wiring` is step 1 of this feature and this plan
> is step 4 — the helper is already un-blinded by the time this lands, so "a follow-up, not this plan"
> defers the simple fix in favour of building a fifth settings store that would then need unwinding.
> Verification also found that the provider's `getSetting`/`saveSetting` arms
> (`KanbanProvider.ts:10085-10118`) already implement every element this plan specified as new work,
> including the non-string-key guard and the `switchboard.prompts.` prefix.
> **Replaced with:** **delegate.** Delete the Map and the two hand-rolled arms so both verbs fall
> through to the provider. The residual risks are the three below, all of which are about the
> delegation being wired correctly rather than about a new store being correct.

- **`initiatorProject` must be forwarded, or the project tier silently disappears.** The provider keys
  its project tier off `msg.initiatorProject` (`_getScopedSetting(fullKey, undefined, msg.initiatorProject)`),
  while standalone tracks the active project in its own `projectFilter` closure variable
  (`bootstrap.ts:301`, mutated by the `setProjectFilter` arm at `:708`). If the fallthrough forwards
  only `workspaceRoot`, every scoped read and write lands on the workspace tier and *nothing reports
  an error*. This is a shared requirement with `standalone-board-verb-rail-fallthrough` — see
  Dependencies.
- **Shared rows mean shared blast radius.** Once the browser writes to the same `config` rows the
  editor reads, a bad write from a headless session affects the editor. Delegation inherits the
  provider's key guard, which is the mitigation the original approach had to add by hand.
- **The `settingResult` push must still reach the browser.** The provider arm calls
  `this.postMessage(...)`; in standalone that routes through the injected `_broadcaster`
  (`bootstrap.ts:634`). Verify the push arrives on the `kanban` surface — panels listen for
  `settingResult`, and losing it would leave reads returning correct HTTP bodies while the UI never
  updates.

## Edge-Case & Dependency Audit

- **Race Conditions.** Two browser tabs writing the same key concurrently: last write wins, same as
  the editor. More interesting is a browser write racing the editor's own write to the same row while
  both are running against one workspace — acceptable (it is one logical store) but worth a note in
  the docs rather than a lock.
- **Security.** `getSetting`/`saveSetting` are reachable over HTTP from any authenticated browser
  session. Making them durable turns them into a persistence primitive. Delegation routes them through
  `handleServiceVerb`, which applies the `KANBAN_VERBS` allowlist **and** `validateVerbPayload` before
  dispatch, then hits the provider's own non-string-key guard — strictly tighter than today's
  hand-rolled arm, which reads `payload.key` unvalidated and throws a raw TypeError on a missing key.
- **Side Effects.** First run after this change will read *existing* DB config rows that were
  previously invisible to standalone. Panels may suddenly reflect editor-side configuration — correct,
  but a visible behaviour change worth calling out in release notes, together with the one-time
  `selectedRole` reset (User Review 4).
- **Dependencies & Conflicts.** Now **depends on** `standalone-workspace-root-wiring` (un-blinds
  `_getScopedSetting`) and `standalone-board-verb-rail-fallthrough` (provides the delegation path and
  must forward `initiatorProject`). `standalone-editor-bound-verb-triage` cannot classify the eight
  settings-toggle verbs until this lands, because a toggle that cannot persist cannot be verified by a
  second read. `standalone-verb-robustness-hardening`'s `saveSetting` key guard becomes redundant for
  this verb once delegation lands — check before implementing it twice.

## Dependencies

> **Superseded:** "None blocking, but see the first Complex/Risky bullet: `standalone-workspace-root-wiring`
> is what makes `_getScopedSetting` usable headlessly. This plan is deliberately written to not need it."
> **Reason:** The plan no longer avoids the helper — it delegates to it — so the dependency is now
> hard in both directions: the root wiring must land first, and the fallthrough must exist to carry
> the delegation.
> **Replaced with:** the two hard dependencies below.

- **HARD: `standalone-workspace-root-wiring`** — un-blinds `_getScopedSetting` / `_updateScopedSetting`
  by wiring `kanbanProvider.setTaskViewerProvider` and making root resolution work.
- **HARD: `standalone-board-verb-rail-fallthrough`** — supplies the `default:` delegation path, and
  must forward `initiatorProject` (the active `projectFilter`) in the payload it spreads.
- Feeds `standalone-editor-bound-verb-triage` (settings-toggle cluster).
- Related but independent: `standalone-role-picker-visible-agents` fixes one specific read by a
  different, better route (machine-global agent config) and should not be made to wait on this.
- (No session IDs cited; IDs are assigned on import.)

## Adversarial Synthesis

**Risk summary.** The change is now subtractive, which moves the risk from "the new store is wrong" to
"the delegation is under-wired". The two concrete hazards are a missing `initiatorProject` (settings
persist on the wrong tier, silently) and a lost `settingResult` push (correct HTTP bodies, stale UI).
Both are cheap to assert and neither can crash, which is exactly why they need explicit tests rather
than a smoke check.

## Proposed Changes

### `src/standalone/bootstrap.ts` — retire the process-local settings store

- **Context.** `uiSettings` at `:300`; `projectFilter` at `:301`; the `setProjectFilter` arm at `:708`;
  `getSetting` at `:713-722`; `saveSetting` at `:724-729`; `hostState` at `:272`; the file-backed
  memento installed as `globalState`/`workspaceState` at `:529-567`.
- **Logic.** Delete the `uiSettings` Map and both hand-rolled arms so `getSetting` and `saveSetting`
  fall past the switch into the `KanbanProvider` passthrough. Leave `projectFilter` in place — it is
  still the source of `initiatorProject`.
- **Implementation.**
  - Remove `const uiSettings = new Map<string, any>();` (`:300`) and both `case` blocks.
  - Leave a comment at the deletion site recording why: the provider's arms
    (`KanbanProvider.ts:10085-10118`) are durable, prefixed, key-guarded and four-tier, and both verbs
    are in `KANBAN_VERBS` — a hand-rolled arm here would shadow them.
  - Classify both verbs correctly in `KANBAN_READ_ONLY_VERBS` (the set the fallthrough introduces):
    `getSetting` is a read (no board push), `saveSetting` is a write. A settings write does not change
    card state, so if a full board push per `saveSetting` proves noisy, it is a legitimate exception —
    but default to over-inclusion of writes, per the fallthrough plan's own rule.
- **Edge Cases.** `selectedRole` moves from the bare `hostState` key to
  `switchboard.prompts.selectedRole` in `workspaceState` (same JSON file) — one-time reset unless the
  optional migration in User Review 4 is taken. Any other bootstrap code reading `uiSettings`
  directly must be found and repointed; grep before deleting.

### `src/standalone/bootstrap.ts` — forward `initiatorProject` in the fallthrough payload

- **Context.** The `default:` arm introduced by `standalone-board-verb-rail-fallthrough`, which spreads
  `{ ...payload, workspaceRoot: root }`; `projectFilter` at `:301`.
- **Logic.** Add the active project filter so the provider's project tier resolves. Let an explicit
  payload value win, so a caller can target a specific project.
- **Implementation.** `{ initiatorProject: projectFilter, ...payload, workspaceRoot: root }` — note the
  spread order: `payload` after the default so a caller-supplied `initiatorProject` overrides it, and
  `workspaceRoot` last because the router's resolved root is authoritative.
- **Edge Cases.** If this lands in the fallthrough plan instead, delete it here rather than doing it
  twice — the two plans touch the same expression and must not both edit it. Whichever lands second
  owns the assertion.

## Verification Plan

### Automated Tests

- **Contract — settings survive a restart.** Boot standalone on a scratch workspace, `POST
  /kanban/verb/saveSetting` with a test key, kill the server, boot again, `POST getSetting`, assert the
  value is returned. This is the test that fails today for every key except `selectedRole`.
- **Contract — standalone sees editor-written config.** Seed a `config` row directly in a scratch
  `kanban.db` using the extension's prefixed key (`switchboard.prompts.<key>`), boot standalone, and
  assert `getSetting` returns it.
- **Contract — the response carries the value in the body.** Assert `POST getSetting` returns
  `{success:true, key, value}`, not a bare ack (PRD contract #4). The hand-rolled arm's shape must not
  be missed as a regression.
- **Contract — project tier is honoured end to end.** With a project filter active
  (`POST setProjectFilter`), write a key, clear the filter, and assert the workspace-tier value (not
  the project one) is returned; re-select the project and assert the project value returns. This is
  the `initiatorProject` assertion — it fails if the fallthrough forwards only `workspaceRoot`.
- **Contract — `settingResult` still reaches the browser.** With a real WS client attached, `POST
  getSetting` and assert a `settingResult` message arrives on the `kanban` surface with the same key
  and value as the HTTP body.
- **Contract — key validation.** `saveSetting` with a non-string key returns
  `{success:false, error:'Key is not a string'}` rather than throwing a raw TypeError.
- **Regression — `selectedRole` round trip.** After a save and a restart, the role picker resolves the
  saved role (via the prefixed `workspaceState` key). If the optional migration is implemented, also
  assert a pre-existing bare-key value is adopted exactly once.
- **Manual smoke.** Toggle a board view setting in the browser, restart the CLI, confirm the toggle
  stuck.

## Uncertain Assumptions

- That every current `saveSetting` caller intends workspace-scoped persistence. Some may be
  session-scoped by intent (a transient UI state that *should* reset); durably persisting those is a
  behaviour change. Worth a scan of `saveSetting(` call sites in the webviews before landing, and an
  explicit session-scoped escape hatch if any are genuinely transient. Note delegation makes standalone
  match the extension here, so any such key is already persisted for editor users today.
- That no bootstrap code outside the two arms reads `uiSettings`. Grep before deleting.
- That `_kanbanService` is not constructed in standalone at the time these verbs run. Both provider
  arms short-circuit to `this._kanbanService.getSetting(msg)` / `.saveSetting(msg)` when it exists
  (`:10086`, `:10103`), which is a different code path from the inline tier logic quoted above. Confirm
  which branch standalone takes — the tests above assert behaviour either way, but the two branches
  must be checked for equivalent tier semantics.

## Out of Scope

- Changing the extension's key prefix or its four-tier resolution.
- The `agents.visibleAgents` read specifically (handled by the role-picker plan via the
  machine-global agent config).
- Converting `_getScopedSetting`'s tier logic into a shared service (a deeper refactor; delegation
  makes it unnecessary for this plan).

## Completion Summary
Retired the in-process `uiSettings` Map and hand-rolled `getSetting` / `saveSetting` arms in `src/standalone/bootstrap.ts`. All settings operations now fall through to `KanbanProvider`'s four-tier durable settings handlers, persisting settings across standalone server restarts and matching extension behavior.
- Files changed: `src/standalone/bootstrap.ts`
- Issues encountered: None.

