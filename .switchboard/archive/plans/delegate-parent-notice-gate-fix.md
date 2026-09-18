# Tell the Lead Its Coders Exist — Fix the DELEGATE PARENT Gate

## Goal

Make a team head receive the `DELEGATE PARENT` notice naming its live child terminals, by gating that notice on whether the terminal actually *has* children rather than on the legacy role-config `addons.delegates` list — which a team-spawned head never has.

### Problem analysis and root cause

**Adopt the shipped default team today and it spawns three coders the lead is never told about.** They sit idle at their CLI prompt indefinitely, because nothing gives them work and the only agent that could does not know they exist.

The shipped "Feature team" gallery type (`kanban.html:4398`) is:

```
{ role: 'coder',    count: 3, scope: 'per-team', relationship: 'reports-to-head' },
{ role: 'reviewer', count: 1, scope: 'shared',   relationship: 'reviewer' }
```

- The **reviewer** is learned about: `reviewer` is a `head-receives` preset, so its standing order is installed on the head and names the reviewer.
- The **three coders** are not: `reports-to-head` is `member-receives`, so the order goes on each *coder*, about the head. Nothing is installed on the head about the coders.

`DELEGATE_PARENT_NOTICE` (`agentPromptBuilder.ts:683`) exists precisely to close that gap — *"You have N delegate child terminals co-launched by the host. Your children are: X, Y, Z. Each child will report to you when it finishes its work."* It never renders for a team, because `_resolveDelegateIdentityForTarget` (`TaskViewerProvider.ts:9266`) opens with:

```ts
const roleConfig = this._readRoleConfigScoped(role) as any;
if (!Array.isArray(roleConfig?.addons?.delegates) || roleConfig.addons.delegates.length === 0) {
    return undefined;
}
```

> **Superseded:** `_resolveDelegateIdentityForTarget` (`TaskViewerProvider.ts:9174`)
> **Reason:** Line-number drift. The method declaration is at `:9266` and the gate condition at `:9273` in the current tree; the cited `:9174` points into `_resolveAgentTerminalForPlan`, a different method.
> **Replaced with:** Method at `TaskViewerProvider.ts:9266`; the `addons.delegates` gate at `:9273`.

A team's members live in `terminals.agentGroups`, never in role config. So the gate returns `undefined`, the notice is omitted, and the head is dispatched with no knowledge of its team.

**Root cause: the gate checks the pre-teams spawner.** `addons.delegates` is the older per-role delegate-children mechanism. It is still plumbed — `bootstrap.ts:1168` sets `payload.delegates` from it, as does `TaskViewerProvider.ts:2488` on the extension host — but `bootstrap.ts:1203` then overwrites that with `team.members` whenever a team heads the role, with the comment *"The team's members override role-config delegates."* (`TaskViewerProvider.ts:2539` is the matching extension-host overwrite.) So the notice is gated on a mechanism the team path deliberately supersedes.

> **Superseded:** `bootstrap.ts:1153` sets `payload.delegates` from it, but `:1188` then overwrites that with `team.members`.
> **Reason:** Line-number drift, and the extension-host twin of both sites was unnamed — leaving the impression this is a standalone-only shape when it is symmetric across hosts.
> **Replaced with:** Read path `bootstrap.ts:1168` + `TaskViewerProvider.ts:2488`; team overwrite `bootstrap.ts:1203` + `TaskViewerProvider.ts:2539`.

**The resolver underneath already works for teams.** `resolveDelegateIdentityForTerminal` (`agentPromptBuilder.ts:699`) finds children by `t.parentInstanceId === parent.agentInstanceId` off live `ptyListTerminals`, and per-team members are created with exactly that parentage (`ptyFleetService.ts:531`, which passes `parent.agentInstanceId` into `create()`). Only the gate looks in the wrong place — one condition.

Shared-scope members are unparented by construction and would not be listed. That is correct: their `head-receives` order already names them, so listing them again would duplicate.

**Blast radius.** Narrow and additive. The notice starts rendering for heads that have live children; nothing that renders today stops. Installs still using role-config delegates are unaffected — they have children too, so they satisfy the new condition as well as the old one.

## Metadata

**Complexity:** 2
**Tags:** bugfix, backend

## User Review Required

None.

## Complexity Audit

### Routine

- Replacing the gate condition with a children-based check.

### Complex / Risky

- **Do not simply delete the gate.** It is also a cheap-exit optimisation: without it, every dispatch to every terminal pays a `ptyListTerminals` round-trip. The replacement must stay cheap — reuse the caller-supplied `terminals` array when present (the signature already accepts one at `TaskViewerProvider.ts:9269`), and only round-trip when it is absent.
- **The notice must not fire for a childless terminal.** `resolveDelegateIdentityForTerminal` already returns `undefined` when the child list is empty (`agentPromptBuilder.ts:706`), so the empty-notice case is handled — but only if the new gate defers to it rather than short-circuiting on its own count.
- **Exited children must not be named.** A head whose coders have died should not be told it has three children. `resolveDelegateIdentityForTerminal` does **not** filter on `status` — it collects every row whose `parentInstanceId` matches, live or not. Verified by reading `agentPromptBuilder.ts:699-712`: there is no `status === 'active'` predicate anywhere in it.

## Edge-Case & Dependency Audit

**Race Conditions** — a member spawning concurrently with a dispatch to the head could be missed from the list. Harmless: the notice is informational and the next dispatch re-resolves.

**Security** — none. Read-only terminal enumeration on an existing authenticated path.

**Side Effects** — heads that previously received no notice now receive one, which lengthens their prompt slightly and changes behaviour: the lead will start dispatching to its coders. That is the intent.

**Dependencies & Conflicts** — independent of the standing-orders and gallery work; it fixes live behaviour on its own. It is a prerequisite in practice for the team workflow to function at all, since a lead cannot clear or dispatch to coders it does not know about. No other subtask in this feature edits `_resolveDelegateIdentityForTarget` or `resolveDelegateIdentityForTerminal`, so this plan owns both surfaces outright.

## Dependencies

None. Independently shippable, and the only plan in the set that makes the existing teams feature work today.

## Adversarial Synthesis

**Risk summary.** The change itself is one condition, but two failure modes hide behind it: a naive rewrite silently converts a zero-cost early return into a `ptyListTerminals` round-trip on *every* dispatch to *every* terminal, and the shared resolver has no liveness filter, so a head whose coders have exited gets told it has children that are gone. Mitigations: keep the caller-supplied-array fast path (the parameter already exists), and filter the terminals array to `status === 'active'` **before** handing it to the resolver — the resolver returns only names, so post-filtering its result is impossible.

## Implementation

1. Replace the `addons.delegates` gate in `_resolveDelegateIdentityForTarget` (`TaskViewerProvider.ts:9273`) with a check that the target terminal has live children, deferring to `resolveDelegateIdentityForTerminal` for the actual resolution.
2. Keep the cheap path: use the caller-supplied `terminals` array when provided; only issue `ptyListTerminals` when it is absent.
3. Filter the **input** terminals array to live (`status === 'active'`) seats on **both** branches — the caller-supplied array and the round-trip result — before passing it to `resolveDelegateIdentityForTerminal`, so the notice never names exited terminals.

   > **Superseded:** "Filter the resolved children to live (`status === 'active'`) seats so the notice never names exited terminals."
   > **Reason:** Incompatible with step 4 as written, and not implementable as stated. `resolveDelegateIdentityForTerminal` returns `{ agentInstanceId, delegateChildren: string[] }` — the children are bare `friendlyName` strings with no `status` field, so there is nothing left to filter after the call. Filtering "the resolved children" would require either re-consulting the terminals array or changing the shared resolver, and the latter contradicts step 4's "leave it unchanged".
   > **Replaced with:** Filter the *input* array (`terminals.filter(t => t.status === 'active')`) before the call. The parent row is itself active, so filtering the input cannot lose it, and the shared resolver stays untouched — step 4 holds.

4. Leave `resolveDelegateIdentityForTerminal` unchanged — it already does the right thing given a live-filtered input.

## Proposed Changes

### `_resolveDelegateIdentityForTarget` gate — `src/services/TaskViewerProvider.ts:9266`
- **Context:** Gated on `roleConfig.addons.delegates` (`:9273`), the pre-teams spawner a team head never populates.
- **Logic:** Gate on the terminal having live children instead; defer the resolution itself to `resolveDelegateIdentityForTerminal`.
- **Edge Cases:** Must stay cheap for childless terminals (keep the `terminals`-supplied fast path at `:9276`); must not name exited children (live-filter the input on both branches); shared members stay excluded by virtue of being unparented.
- **Clarification:** the existing `if (!displayName || !this._ptyHostPort) { return undefined; }` guard at `:9271` stays — it is the real zero-cost exit for VS Code terminals and for hosts with no PTY, and it is independent of the `addons.delegates` condition being replaced.

## Verification Plan

1. Start the shipped "Feature team" and dispatch to its lead: the prompt contains `DELEGATE PARENT: You have 3 delegate child terminals…` naming all three coders. This fails at HEAD.
2. The shared reviewer is **not** listed in the notice — it is unparented, and its own `head-receives` order already names it.
3. A terminal with no children receives no notice, and the dispatch issues no extra `ptyListTerminals` round-trip when a terminals array was already supplied.
4. Killing one coder and re-dispatching names two children, not three.
5. A dispatch that supplies a `terminals` array **already containing an exited child row** still names only the live children — proving the live filter is applied on the caller-supplied branch, not just the round-trip branch.
6. An install still using role-config `addons.delegates` continues to receive the notice exactly as before.
7. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (5 `TS2835` errors at HEAD).

## Recommendation

Complexity 2 → **Send to Coder, ship first.** One condition, independent of every other plan in the set, and it converts the shipped default team from inert to functional.

## Completion Summary

Implemented the children-based gate in `_resolveDelegateIdentityForTarget` (`src/services/TaskViewerProvider.ts:9273`), replacing the legacy `roleConfig.addons.delegates` check that a team-spawned head never populates. The method now defers entirely to `resolveDelegateIdentityForTerminal` for resolution, live-filtering the input terminals array (`status === 'active'`) on both the caller-supplied fast path and the `ptyListTerminals` round-trip branch, so exited children are never named in the DELEGATE PARENT notice. The existing `!displayName || !this._ptyHostPort` zero-cost guard and the caller-supplied-array fast path were preserved, keeping childless terminals cheap when a `terminals` array is supplied; `resolveDelegateIdentityForTerminal` was left untouched per the plan. The `role` parameter is retained in the signature for caller compatibility (now unused, but `noUnusedParameters` is disabled in tsconfig). Only `src/services/TaskViewerProvider.ts` was changed; no compile or test commands were run per instructions.

## Review Findings

Reviewed against the plan; no CRITICAL or MAJOR findings, no code changes applied. The gate at `TaskViewerProvider.ts:9395-9408` matches all four implementation steps: the `!displayName || !this._ptyHostPort` zero-cost guard is preserved, the caller-supplied fast path is preserved, `status === 'active'` filtering is applied on **both** branches, and `resolveDelegateIdentityForTerminal` is untouched. **NIT:** the fast path is unreachable in practice — both callers (`:6313`, `:20083`) invoke the method with two arguments, so `terminals` is always `undefined` and every PTY dispatch now pays one `ptyListTerminals` round-trip that the old `addons.delegates` check avoided; verification step 3 is therefore vacuously true. Verification was run independently this pass (the dispatch carried no skip directive): `npx tsc --noEmit` reports zero errors in this file, and the pty contract suites (`pty-host-gating`, `pty-route-surface`, `multi-parent-terminals` 29/29) pass.
