# Shared reviewer named `team-reviewer` instead of `<teamName>-reviewer` on the extension host

## Goal

### Problem
The user started a Coding team (head role `lead`, members: 3× `coder` per-team + 1× `reviewer` shared). The reviewer member — which the Coding team definition declares with `scope: 'shared'` — was spawned with the terminal name **`team-reviewer`** instead of **`Coding-reviewer`**. The user read that name as the reviewer being placed in a separate "team reviewer" group rather than as a member of the Coding team.

### Background
Shared-scope members are reused, not respawned per team start. `spawnDelegates` derives each shared member's terminal name from a `teamName` value:

```js
// src/standalone/ptyFleetService.ts:475-476
const teamName = opts?.teamName || 'team';
const sharedBaseName = `${teamName}-${d.label || d.role}`;
```

When `teamName` is supplied, the Coding team's shared reviewer becomes `Coding-reviewer` — the name the team-scoped routing tests assert (`team-scoped-role-routing.test.js:58,68`). When `teamName` is absent, it falls back to the literal `'team'`, producing `team-reviewer`.

### Root cause
The **standalone host** passes the team name through correctly:

```js
// src/standalone/bootstrap.ts:2221
await ptyFleetService.spawnDelegates(head, spec.delegates, { teamName: group?.name });
```

The **extension host** does not. Its `createHeadWithDelegates` builds the `ptyCreateTerminal` payload without a `teamName` field:

```js
// src/services/TaskViewerProvider.ts:12041-12054
createHeadWithDelegates: (spec) => this._ptyHostVerb('ptyCreateTerminal', {
    role: spec.role,
    name: spec.name,
    cwd: spec.cwd,
    delegates: spec.delegates,
    claudeInlineRendering: ...,
}),
```

The pty-host child reads `payload.teamName` and forwards it to `spawnDelegates`:

```js
// src/standalone/ptyHost.ts:94
await fleet.spawnDelegates(terminal, rawDelegates, { teamName: payload.teamName })
```

Because the extension-host payload omits `teamName`, `payload.teamName` is `undefined`, `spawnDelegates` falls back to `'team'`, and every shared member is named `team-<role>` regardless of which team started it.

### Consequences
1. **Misnamed reviewer**: The Coding team's reviewer is `team-reviewer`, which the operator reads as a separate "team reviewer" entity rather than a Coding-team member. The reviewer IS registered in the `team_<headName>` group's `members` array (wiring uses the spawned friendlyName), so group membership is technically correct — but the name is wrong and misleading.
2. **Cross-team shared-member collision**: Two different teams (e.g. "Coding" and "Backend") both spawn a shared reviewer named `team-reviewer` on the extension host. `spawnDelegates` reuses a live instance by friendlyName (`ptyFleetService.ts:487`), so the second team's start reuses the first team's reviewer terminal instead of spawning its own. The standalone host does not hit this because the names are `Coding-reviewer` and `Backend-reviewer`. The team-scoped routing test fixture (`team-scoped-role-routing.test.js:56-72`) assumes the distinct names; on the extension host those two teams collapse onto one reviewer.

## Metadata
- **Complexity:** 3
- **Tags:** backend, bugfix
- **Project:** Browser Switchboard

## User Review Required
- None. The fix makes the extension host match the standalone host's existing, tested behavior. No new naming scheme, no new product surface, no breaking change.

## Complexity Audit

### Routine
- Adding a `teamName?: string` field to the `createHeadWithDelegates` spec type in `InstantiateAgentGroupOptions` — one interface line (`agentGroupInstantiation.ts:50-55`).
- Passing `teamName: group?.name` from `instantiateAgentGroupCore` into the `createHeadWithDelegates` call — one property in the spec literal (`agentGroupInstantiation.ts:107-112`).
- Forwarding `teamName: spec.teamName` in the extension host's `ptyCreateTerminal` payload — one property (`TaskViewerProvider.ts:12041-12054`).

### Complex / Risky
- **None.** The standalone host already passes `teamName: group?.name` through an identical path (`bootstrap.ts:2221`), so this change makes the extension host match the standalone host's existing, tested behaviour. No new naming scheme is introduced; the fallback `'team'` in `spawnDelegates` remains as a safety net for any caller that genuinely has no team name.

## Edge-Case & Dependency Audit

1. **`group?.name` undefined**: If `group.name` is absent, `teamName` is `undefined`, `spawnDelegates` falls back to `'team'` — identical to today's behaviour. No regression for a malformed definition.

2. **External-headed teams**: `instantiateExternalHeadedTeam` uses `createDelegatesOnly`, not `createHeadWithDelegates`. Its extension-host implementation (`TaskViewerProvider.ts:12121-12153`) already derives `baseName` from `spec.teamName` (`TaskViewerProvider.ts:12128`), and `instantiateExternalHeadedTeam` passes `teamName: headName` (`agentGroupInstantiation.ts:369`). That path is already correct and is NOT touched by this plan.

3. **Standalone host `createHeadWithDelegates`**: `bootstrap.ts:2215-2237` calls `spawnDelegates(head, spec.delegates, { teamName: group?.name })` directly — it does not go through the `ptyCreateTerminal` verb. Adding `teamName` to the spec is additive; the standalone host's `createHeadWithDelegates` closure already has `group?.name` in scope and ignores the spec field. No change needed there, and no behaviour change.

4. **Pty-host child**: `ptyHost.ts:94` already reads `payload.teamName` and forwards it. Once the extension host supplies the field, the child forwards it correctly. No change to `ptyHost.ts`.

5. **Shared-member reuse across re-starts**: Once the reviewer is named `Coding-reviewer`, a re-start of the same Coding team reuses the live `Coding-reviewer` instance (`ptyFleetService.ts:487`). This is the intended shared-member semantics and is unchanged. The fix only changes the name from `team-reviewer` to `Coding-reviewer`, which makes reuse team-scoped instead of global.

6. **Existing `team-reviewer` terminals in the field**: An install that already started a Coding team on the extension host has a live (or persisted) `team-reviewer` terminal. After the fix, a re-start looks for `Coding-reviewer`, does not find it, and spawns a new one — leaving the old `team-reviewer` as an orphan terminal. This is a one-time transient; the orphan is an ordinary terminal the operator can close. **The orphan does NOT pollute team routing**: `wireSpawnedTeam` performs an upsert with member-list REPLACEMENT, not union (`teamWiring.ts:1228-1246` — *"Replace stale members (not union), preserve operator-authored layout"*). On restart, `groupMembers = [headName, ...childNames]` is rebuilt from the fresh spawn, so the group's `members` array becomes `[headName, 'Coding-reviewer']` — the old `team-reviewer` entry is overwritten. The orphan terminal is live but absent from the group's members, so `resolveTeamScopedRoleTerminal` will not route to it. No migration is needed for terminal names (they are runtime state, not persisted team definitions), and no membership cleanup is needed (the upsert-replace handles it).

7. **Team group membership**: `wireSpawnedTeam` registers `groupMembers = [headName, ...childNames]` from the spawned children's friendlyNames (`teamWiring.ts:1213-1224`). After the fix, the reviewer's friendlyName is `Coding-reviewer`, so the group membership correctly lists `Coding-reviewer`. Today it lists `team-reviewer` — also a member, but misnamed. The group id (`team_<headName>`) is unaffected.

8. **`group.name` sanitization (pre-existing, out of scope)**: `ptyFleetService.create()` sets `friendlyName: name` verbatim (`ptyFleetService.ts:299`) — no sanitization. A team named "My Awesome Team" would produce a shared reviewer named "My Awesome Team-reviewer" (spaces intact). This is the standalone host's existing, shipped behavior (`bootstrap.ts:2221` passes `group?.name` raw); the fix makes the extension host match it. Not a new risk, not a regression, and not introduced by this plan.

## Dependencies
- None. The fix is a one-field addition threaded through three existing call sites that already carry the value on the standalone host.

## Adversarial Synthesis
Key risks: (1) the existing `team-scoped-role-routing.test.js` suite covers the resolution layer (given correct names, route correctly), NOT the production-naming layer — a green run does not prove the extension host now produces `Coding-reviewer`; (2) the spec-shape pin test (verification step 1) covers only the first link of the five-link chain `spec → payload → ptyHost → spawnDelegates → friendlyName`, leaving links 2–5 unasserted automatically. Mitigations: ship the spec-shape pin as a regression guard, rely on the manual extension-host check (step 3) for end-to-end confirmation, and cite `wireSpawnedTeam`'s upsert-replace semantics (edge case #6) to prove the orphan-terminal scenario is membership-clean rather than hand-waving it.

## Proposed Changes

### 1. `src/services/agentGroupInstantiation.ts` — Add `teamName` to the `createHeadWithDelegates` spec type

Add `teamName` to the spec interface so the host callback receives the team name without re-deriving it:

```typescript
    /** Create the head with its delegate members, BELOW the handlePtyVerb wrapper. */
    createHeadWithDelegates: (spec: {
        role: string;
        name: string;
        cwd: string;
        delegates: any[];
        teamName?: string;   // ← NEW: the team/group name, for shared-member naming
    }) => Promise<AgentGroupCreateResult>;
```

### 2. `src/services/agentGroupInstantiation.ts` — Pass `teamName` from `instantiateAgentGroupCore`

In the `createHeadWithDelegates` call (around line 107-112), add `teamName: group?.name`:

```typescript
    const result = await createHeadWithDelegates({
        role: group?.headRole || 'lead',
        name: group?.name,
        cwd,
        delegates: members,
        teamName: group?.name,   // ← NEW: matches standalone host's group?.name
    });
```

### 3. `src/services/TaskViewerProvider.ts` — Forward `teamName` in the `ptyCreateTerminal` payload

In `createHeadWithDelegates` (around line 12041-12054), add `teamName: spec.teamName` to the verb payload so the pty-host child receives it:

```typescript
            createHeadWithDelegates: (spec) => this._ptyHostVerb('ptyCreateTerminal', {
                role: spec.role,
                name: spec.name,
                cwd: spec.cwd,
                delegates: spec.delegates,
                teamName: spec.teamName,   // ← NEW: forwarded to spawnDelegates via ptyHost.ts:94
                claudeInlineRendering: vscode.workspace
                    .getConfiguration('switchboard')
                    .get<boolean>('terminal.claudeInlineRendering', true),
            }),
```

## Verification Plan

### Automated Tests

1. **Unit test — spec-shape pin (the only automated coverage of the fix itself).** Add a test to `src/test/team-scoped-role-routing.test.js` (or a new focused test file) that invokes `instantiateAgentGroupCore` with a mock `createHeadWithDelegates` capturing the spec, then asserts `spec.teamName` equals the group name. This pins the field's presence at link 1 of the chain (`spec → payload → ptyHost → spawnDelegates → friendlyName`). It does NOT assert the downstream friendlyName — that is covered by the manual check (step 3).

2. **Existing test suite — resolution-layer regression guard (NOT production-naming coverage).** Run `node src/test/team-scoped-role-routing.test.js`. The `TWO_GROUPS` fixture (lines 56-72) hardcodes `Coding-reviewer` and `Backend-reviewer` in `SIX_LIVE` and asserts `resolveTeamScopedRoleTerminal` routes correctly GIVEN those names exist. This test passes BEFORE the fix (it assumes the correct names into existence) and AFTER. It guards the resolution layer against regressions, but a green run does NOT prove the extension host now PRODUCES `Coding-reviewer` — that is the fix's concern, covered only by step 1 (spec shape) and step 3 (manual end-to-end). No fixture change is needed because the fixture already models the correct end state.

### Manual Checks

3. **Manual check (extension host) — the real end-to-end confirmation.** Start a Coding team from the TEAMS tab in VS Code. Confirm the reviewer terminal is named `Coding-reviewer` (not `team-reviewer`) and appears in the Coding team group tab. Start a second team (e.g. a forked "Backend" team with a shared reviewer) and confirm its reviewer is `Backend-reviewer` — a distinct terminal, not a reuse of `Coding-reviewer`.

4. **Manual check (standalone host, regression).** Start a Coding team via the standalone host (`npx` / CLI). Confirm the reviewer is still `Coding-reviewer` — the standalone path is unchanged and must not regress.

> **Note:** Compilation and automated test execution are skipped for this run per session directives. The checks above remain the plan's verification contract for the implementing coder; they are simply not executed now.

## Completion Report
Implemented `teamName` forwarding on the extension host during agent group creation so that shared delegates derive their name as `<teamName>-<role>` (e.g. `Coding-reviewer`) rather than falling back to `team-<role>`. Added `teamName?: string` to `InstantiateAgentGroupOptions.createHeadWithDelegates` and passed `teamName: group?.name` in `src/services/agentGroupInstantiation.ts`, forwarded `teamName: spec.teamName` in `src/services/TaskViewerProvider.ts`, and added regression pin tests in `src/test/team-scoped-role-routing.test.js`. Files changed: `src/services/agentGroupInstantiation.ts`, `src/services/TaskViewerProvider.ts`, `src/test/team-scoped-role-routing.test.js`, and this plan file. No issues encountered.

## Review Findings

All three proposed changes are implemented exactly as specified (`agentGroupInstantiation.ts:55,113`; `TaskViewerProvider.ts:13115`) and the full five-link chain was traced: every `spawnDelegates` call site in the tree now passes `teamName` (`ptyHost.ts:94`, `bootstrap.ts:1499,2302`), `_ptyHostVerb` applies no payload schema that would drop the field, and edge cases 2, 6 and 7 were confirmed against `TaskViewerProvider.ts:13199` and `teamWiring.ts`'s upsert-replace. No code defects found; no fixes applied. Validation: `compile-tests` clean, `test:contract:team-scoped-routing` 62 passed / 0 failed (item 8's two new pins included, and the check is CI-wired at `integration-tests.yml:219`); `catalog:check`, `parity:check`, `standalone-parity:check`, `verb-returns:check`, `standalone-fork:check` all pass. One pre-existing out-of-scope observation, not introduced here: when `_ptyHostVerb` routes through `_headlessRuntime`, `ptyCreateTerminal` lands on `bootstrap.ts:1491`, which force-sets `payload.delegates = []`, so `teamName` arrives but no delegates spawn on that branch at all.
