# Fix: Git strategy defaults should be "Not Specified" for all three; remove meaningless "Incremental Commits" option

**Plan ID:** a1b2c3d4-1259-4a04-9f04-gitDefaults1259

## Goal

The three git strategy radios (Branch / Commit / Push) on the Prompts tab default to prescriptive values — `current` (branch), `whenDone` (commit), `noPush` (push). The user wants all three to default to **Not Specified**, so that by default no git policy clause is emitted unless the user explicitly chooses one. Additionally, the **Incremental Commits** option in the Git Commit Strategy is perceived as not meaningfully different from "Commit When Done" and should be removed.

### Problem / background / root cause

**Defaults.** The git strategy defaults are hardcoded in four places that must all be aligned:

1. `src/webview/sharedDefaults.js:65,72,80` — the `GIT_*_STRATEGY_RADIO` definitions: `default: 'current'`, `default: 'whenDone'`, `default: 'noPush'`.
2. `src/webview/sharedDefaults.js:24,25,28,32` — `DEFAULT_ROLE_CONFIG` for `lead`, `coder`, `intern`, `claude_designer` hardcodes `gitBranchStrategy: 'current'`, `gitCommitStrategy: 'whenDone'`, `gitPushStrategy: 'noPush'` in the addons object.
3. `src/webview/kanban.html:3398,3403,3409` — the custom-agent fallback addon array duplicates the same `default: 'current'/'whenDone'/'noPush'`.
4. `src/services/KanbanProvider.ts:4206-4208` — server-side merge fallback: `gitBranchStrategy === undefined -> 'current'`, `gitCommitStrategy === undefined -> 'whenDone'`, `gitPushStrategy === undefined -> 'noPush'`.
5. `src/services/KanbanProvider.ts:4561-4590` — `gitBranchStrategyByRole` / `gitCommitStrategyByRole` / `gitPushStrategyByRole` fallbacks when reading role config: `?? 'current'` / `?? 'whenDone'` / `?? 'noPush'`.

Because of these defaults, every freshly-configured Lead/Coder/Intern/Custom agent emits a `GIT POLICY:` block with "Do all work on the current branch...", "When you have finished the task, stage all your changes and create a single descriptive commit.", "Do NOT push to any remote." — even when the user never chose a strategy. The user's intent is that **no git policy is emitted by default**; the user opts in explicitly.

**Incremental Commits option.** The `incremental` commit option (`sharedDefaults.js:74`, `kanban.html:3405`) emits the clause: "Commit at each logical checkpoint with a clear message so progress is captured incrementally." (`agentPromptBuilder.ts:411`). The user considers this not meaningfully different from `whenDone` ("When you have finished the task, stage all your changes and create a single descriptive commit.") — both instruct the agent to commit; the only difference is timing granularity, which in practice agents do not follow deterministically. The option adds UI clutter without reliable behavioural difference.

**Root cause:** the defaults were chosen to be "safe/opinionated" (work on current branch, commit when done, don't push) but the user wants a neutral default that emits nothing. The `incremental` option was added for granularity but does not produce a reliably different agent behaviour.

## Metadata

**Tags:** frontend, webview, prompts-tab, git-policy, defaults, cleanup
**Complexity:** 3

## User Review Required

No — the user explicitly requested this change (the feature is literally "git strategy defaults should be Not Specified; remove Incremental Commits"). The one migration concern (stale persisted `incremental` values) is handled defensively by allow-list narrowing + read-time normalisation + the `GIT_COMMIT_CLAUSES` map no longer containing the key. The behavior change (reversing the prior "work-on-main default") is the user's stated intent, not an emergent side effect. Safe to implement directly.

## Complexity Audit

### Routine
- Changing the `default` field on the three `GIT_*_STRATEGY_RADIO` objects in `sharedDefaults.js` to `'notSpecified'`.
- Changing the hardcoded values in `DEFAULT_ROLE_CONFIG` (`sharedDefaults.js:24,25,28,32`) to `'notSpecified'`.
- Changing the custom-agent fallback defaults in `kanban.html:3398,3403,3409` to `'notSpecified'`.
- Changing the server-side fallbacks in `KanbanProvider.ts:4206-4208` and `4561-4590` to `'notSpecified'`.
- Removing the `incremental` option from `GIT_COMMIT_STRATEGY_RADIO.options` (`sharedDefaults.js:74`), the custom-agent fallback (`kanban.html:3405`), the type union (`agentConfig.ts:10`, `agentPromptBuilder.ts:188`), and the clause vocabulary (`agentPromptBuilder.ts:411`).

### Complex / Risky
- **Existing saved configs.** Users who already saved a role config with `gitCommitStrategy: 'whenDone'` (or `'incremental'`) will keep that saved value — `roleConfigs[role]?.addons?.[addon.id] ?? addon.default` reads the persisted value first. The default change only affects fresh/unconfigured roles. This is the desired behaviour (don't override explicit user choices). **However**, any user who previously selected `incremental` and saved it will have a now-invalid value persisted. The renderer (`kanban.html:3431`) reads `currentValue ?? addon.default`; if `currentValue === 'incremental'` and the option no longer exists, no radio will be checked (the radio group shows nothing selected) but the saved value remains `incremental`. The prompt builder (`agentPromptBuilder.ts:455`) guards with `GIT_COMMIT_CLAUSES[commit]` — after removing `incremental` from the clauses map, an `incremental` value produces no clause (treated like `notSpecified`). This is safe (no crash, no clause emitted) but the UI will show no selection. **Mitigation:** add a one-time normalisation in `KanbanProvider.ts` (or the renderer) that maps any persisted `'incremental'` to `'notSpecified'` on read.
- **Server-side merge fallback** (`KanbanProvider.ts:4206-4208`) runs when merging addons. Changing `undefined -> 'notSpecified'` means a role with no saved git strategy emits no clause. Verify no other code path depends on the old non-`notSpecified` default.
- **`agentConfig.ts:220`** validates `gitCommitStrategy` against an allow-list including `'incremental'`. Remove `'incremental'` from the allow-list so a stale `incremental` value is dropped during config sanitisation (defence in depth alongside the normalisation above).

## Edge-Case & Dependency Audit

- **Stale `incremental` persisted values.** Handle via (a) removing `incremental` from the `agentConfig.ts:220` allow-list so sanitisation drops it, and (b) the `GIT_COMMIT_CLAUSES` map no longer containing `incremental` so `buildGitPolicyBlock` emits no clause for it. Add an explicit normalisation mapping `incremental -> notSpecified` on read in `KanbanProvider.ts` so the UI shows a valid selection.
- **`notSpecified` already supported end-to-end.** `buildGitPolicyBlock` (`agentPromptBuilder.ts:450,455,461`) already treats `notSpecified` as "emit no clause". The `?? 'notSpecified'` fallbacks at `KanbanProvider.ts:4283-4285` already exist for the per-role override path. So the default change is consistent with existing handling.
- **No prompt-output regression for explicit choices.** Users who explicitly select `current`/`whenDone`/`newBranch`/`noPush`/`pushWhenDone`/`dontCommit` keep getting the same clauses. Only the *default* (no explicit choice) changes from emitting a clause to emitting nothing.
- **Custom agents.** The custom-agent fallback (`kanban.html:3396-3418`) must receive the same default + incremental-removal changes so custom agents behave identically to built-in code roles.
- **No dependency on Issue 1.** Issue 1 (layout/accordions) adds a `group: 'git'` field to the same radio objects. This plan edits `default` and the `options` array. The two edits are to different fields and do not conflict. Coordinate merge order so both land cleanly.

## Dependencies

- No session dependencies. Sibling subtask `feature_plan_20260707125810_prompts-tab-layout-accordions-grouping` edits the same `sharedDefaults.js` radio objects and `kanban.html` custom-agent fallback block, but different fields (`group` vs `default`/`options`). Recommended landing order: **this plan first** (defaults + `incremental` removal + comment rewrites), then the sibling (layout) — see the feature's `## Dependencies & sequencing`. Landing in that order (or in a single PR) eliminates the merge-conflict surface on the shared object literals.

## Adversarial Synthesis

Key risks: (1) reversing "locked decision #2" (work-on-main default) without updating the encoding comments at `KanbanProvider.ts:4201-4205` and `4556-4560` invites a future maintainer to "fix" the `notSpecified` defaults back; (2) the stale-`incremental` normalisation site is underspecified (three read sites exist); (3) `AgentSkillExporter.ts:104,193` passes `gitCommitStrategy` straight through and is not named as a verify-compiles site; (4) the verification step references `dist/` regen, which `CLAUDE.md` forbids as a gate. Mitigations: rewrite the locked-decision comments (new §8), pin the normalisation to the per-role map read (`KanbanProvider.ts:4575-4578`), name `AgentSkillExporter.ts` in the compile guard, and reframe the build check to "TS compiles" (not `dist/` regen).

## Proposed Changes

### 1. `src/webview/sharedDefaults.js` — defaults to `notSpecified`, remove `incremental`

```js
/* BEFORE — sharedDefaults.js:64-85 */
const GIT_BRANCH_STRATEGY_RADIO = {
    id: 'gitBranchStrategy', ..., type: 'radio', default: 'current', options: [ ... ]
};
const GIT_COMMIT_STRATEGY_RADIO = {
    id: 'gitCommitStrategy', ..., type: 'radio', default: 'whenDone', options: [
        { value: 'whenDone', label: 'Commit When Done', tooltip: '...' },
        { value: 'incremental', label: 'Incremental Commits', tooltip: 'Commit at each logical checkpoint with a clear message' },
        { value: 'dontCommit', label: 'Do Not Commit', tooltip: '...' },
        { value: 'notSpecified', label: 'Not Specified', tooltip: 'Emit no commit clause' }
    ]
};
const GIT_PUSH_STRATEGY_RADIO = {
    id: 'gitPushStrategy', ..., type: 'radio', default: 'noPush', options: [ ... ]
};

/* AFTER */
const GIT_BRANCH_STRATEGY_RADIO = {
    id: 'gitBranchStrategy', ..., type: 'radio', default: 'notSpecified', options: [ ... ]   // current -> notSpecified
};
const GIT_COMMIT_STRATEGY_RADIO = {
    id: 'gitCommitStrategy', ..., type: 'radio', default: 'notSpecified', options: [          // whenDone -> notSpecified
        { value: 'whenDone', label: 'Commit When Done', tooltip: '...' },
        // incremental removed — not meaningfully different from whenDone
        { value: 'dontCommit', label: 'Do Not Commit', tooltip: '...' },
        { value: 'notSpecified', label: 'Not Specified', tooltip: 'Emit no commit clause' }
    ]
};
const GIT_PUSH_STRATEGY_RADIO = {
    id: 'gitPushStrategy', ..., type: 'radio', default: 'notSpecified', options: [ ... ]      // noPush -> notSpecified
};
```

### 2. `src/webview/sharedDefaults.js` — `DEFAULT_ROLE_CONFIG` addons defaults

Change the hardcoded git strategy values in `DEFAULT_ROLE_CONFIG` for `lead` (line 24), `coder` (line 25), `intern` (line 28), and `claude_designer` (line 32):

```js
/* BEFORE */
addons: { ..., gitBranchStrategy: 'current', gitCommitStrategy: 'whenDone', gitPushStrategy: 'noPush', ... }

/* AFTER */
addons: { ..., gitBranchStrategy: 'notSpecified', gitCommitStrategy: 'notSpecified', gitPushStrategy: 'notSpecified', ... }
```

### 3. `src/webview/kanban.html` — custom-agent fallback defaults + remove `incremental`

In the custom-agent fallback array (`kanban.html:3398-3413`):

```js
/* BEFORE */
{ id: 'gitBranchStrategy', ..., default: 'current', options: [ ... ] },
{ id: 'gitCommitStrategy', ..., default: 'whenDone', options: [
    { value: 'whenDone', ... },
    { value: 'incremental', label: 'Incremental Commits', tooltip: 'Commit at each logical checkpoint with a clear message' },
    { value: 'dontCommit', ... },
    { value: 'notSpecified', ... }
] },
{ id: 'gitPushStrategy', ..., default: 'noPush', options: [ ... ] },

/* AFTER */
{ id: 'gitBranchStrategy', ..., default: 'notSpecified', options: [ ... ] },
{ id: 'gitCommitStrategy', ..., default: 'notSpecified', options: [
    { value: 'whenDone', ... },
    // incremental removed
    { value: 'dontCommit', ... },
    { value: 'notSpecified', ... }
] },
{ id: 'gitPushStrategy', ..., default: 'notSpecified', options: [ ... ] },
```

### 4. `src/services/KanbanProvider.ts` — server-side fallbacks to `notSpecified`

```ts
/* BEFORE — KanbanProvider.ts:4206-4208 */
if (mergedAddons.gitBranchStrategy === undefined) mergedAddons.gitBranchStrategy = 'current';
if (mergedAddons.gitCommitStrategy === undefined) mergedAddons.gitCommitStrategy = 'whenDone';
if (mergedAddons.gitPushStrategy === undefined) mergedAddons.gitPushStrategy = 'noPush';

/* AFTER */
if (mergedAddons.gitBranchStrategy === undefined) mergedAddons.gitBranchStrategy = 'notSpecified';
if (mergedAddons.gitCommitStrategy === undefined) mergedAddons.gitCommitStrategy = 'notSpecified';
if (mergedAddons.gitPushStrategy === undefined) mergedAddons.gitPushStrategy = 'notSpecified';
```

And the per-role override fallbacks (`KanbanProvider.ts:4561-4590`):

```ts
/* BEFORE */
gitBranchStrategyByRole: { lead: leadConfig?.addons?.gitBranchStrategy ?? 'current', ... }
gitCommitStrategyByRole: { lead: leadConfig?.addons?.gitCommitStrategy ?? 'whenDone', ... }
gitPushStrategyByRole:   { lead: leadConfig?.addons?.gitPushStrategy ?? 'noPush', ... }

/* AFTER */
gitBranchStrategyByRole: { lead: leadConfig?.addons?.gitBranchStrategy ?? 'notSpecified', ... }
gitCommitStrategyByRole: { lead: leadConfig?.addons?.gitCommitStrategy ?? 'notSpecified', ... }
gitPushStrategyByRole:   { lead: leadConfig?.addons?.gitPushStrategy ?? 'notSpecified', ... }
```

(Update all four roles: lead, coder, intern, claude_designer in each block.)

### 5. `src/services/KanbanProvider.ts` — normalise stale `incremental` on read

Add a normalisation step mapping any persisted `gitCommitStrategy === 'incremental'` to `'notSpecified'`. **Pin the insertion point** to the per-role override map at `KanbanProvider.ts:4573-4578` (the `gitCommitStrategyByRole` block) — this is the single read site that feeds `buildGitPolicyBlock` for built-in code roles, and it reads the raw saved `leadConfig?.addons?.gitCommitStrategy` value. Apply the normaliser to each of the four code-role reads (lead / coder / intern / claude_designer):

```ts
const NORMALISE_GIT_COMMIT = (v: string | undefined): string | undefined =>
    v === 'incremental' ? 'notSpecified' : v;
// Applied at the per-role map (KanbanProvider.ts:4575-4578):
//   lead:      NORMALISE_GIT_COMMIT(leadConfig?.addons?.gitCommitStrategy)      ?? 'notSpecified',
//   coder:     NORMALISE_GIT_COMMIT(coderConfig?.addons?.gitCommitStrategy)     ?? 'notSpecified',
//   intern:    NORMALISE_GIT_COMMIT(internConfig?.addons?.gitCommitStrategy)    ?? 'notSpecified',
//   claude_designer: NORMALISE_GIT_COMMIT(claudeDesignerConfig?.addons?.gitCommitStrategy) ?? 'notSpecified',
```

(Note: the `?? 'notSpecified'` fallbacks themselves change from `'whenDone'` per §4, so the final expression is `NORMALISE_GIT_COMMIT(<raw>) ?? 'notSpecified'`. The merge-fallback site at `KanbanProvider.ts:4207` only fires when the field `=== undefined`, so a defined stale `incremental` skips it and is caught here instead. The dispatch read at `4284` already uses `?? 'notSpecified'` and reads from the per-role map — so normalising at the map source covers both paths.)

### 6. `src/services/agentConfig.ts` — remove `incremental` from allow-list + type

```ts
/* BEFORE — agentConfig.ts:9-11 */
gitBranchStrategy?: 'current' | 'newBranch' | 'notSpecified';
gitCommitStrategy?: 'whenDone' | 'incremental' | 'dontCommit' | 'notSpecified';
gitPushStrategy?: 'noPush' | 'pushWhenDone' | 'notSpecified';

/* AFTER */
gitBranchStrategy?: 'current' | 'newBranch' | 'notSpecified';
gitCommitStrategy?: 'whenDone' | 'dontCommit' | 'notSpecified';
gitPushStrategy?: 'noPush' | 'pushWhenDone' | 'notSpecified';
```

And the sanitisation allow-list (`agentConfig.ts:220`):

```ts
/* BEFORE */
if (s.gitCommitStrategy && ['whenDone', 'incremental', 'dontCommit', 'notSpecified'].includes(s.gitCommitStrategy as string)) {

/* AFTER */
if (s.gitCommitStrategy && ['whenDone', 'dontCommit', 'notSpecified'].includes(s.gitCommitStrategy as string)) {
```

### 7. `src/services/agentPromptBuilder.ts` — remove `incremental` clause + type

```ts
/* BEFORE — agentPromptBuilder.ts:188 */
gitCommitStrategy?: 'whenDone' | 'incremental' | 'dontCommit' | 'notSpecified';

/* AFTER */
gitCommitStrategy?: 'whenDone' | 'dontCommit' | 'notSpecified';
```

```ts
/* BEFORE — agentPromptBuilder.ts:409-413 */
const GIT_COMMIT_CLAUSES: Record<string, string> = {
    whenDone: 'When you have finished the task, stage all your changes and create a single descriptive commit.',
    incremental: 'Commit at each logical checkpoint with a clear message so progress is captured incrementally.',
    dontCommit: 'Do NOT commit. Leave all changes in the working tree for the user to review.'
};

/* AFTER */
const GIT_COMMIT_CLAUSES: Record<string, string> = {
    whenDone: 'When you have finished the task, stage all your changes and create a single descriptive commit.',
    dontCommit: 'Do NOT commit. Leave all changes in the working tree for the user to review.'
};
```

### 8. `src/services/KanbanProvider.ts` — rewrite the "locked decision #2" comments

This plan reverses the prior "work-on-main default" (locked decision #2): the code-role git strategies now default to `'notSpecified'` (emit no clause) instead of `current`/`whenDone`/`noPush`. The comments that ENCODE the old decision must be rewritten, or a future maintainer will read "locked decision #2: work-on-main default," see the code emitting nothing, and "fix" it back — reverting the user's explicit intent.

```ts
/* BEFORE — KanbanProvider.ts:4201-4205 */
// §Git — work-on-main defaulting for custom agents. The UI radio `default`
// only governs rendering, not persistence; a custom agent whose Prompts-tab
// UI was never opened would otherwise get `undefined` strategies and emit no
// Branch/Commit/Push clauses, violating the work-on-main default (locked
// decision #2). Apply defaults to absent strategy fields after merging.

/* AFTER — KanbanProvider.ts:4201-4205 */
// §Git — neutral defaulting for custom agents. The UI radio `default` only
// governs rendering, not persistence; a custom agent whose Prompts-tab UI was
// never opened gets `undefined` strategies. Per the user's explicit decision
// (reversing former locked decision #2), absent strategy fields default to
// 'notSpecified' so NO git-policy clause is emitted unless the user opts in.
// Apply the default to absent strategy fields after merging.
```

```ts
/* BEFORE — KanbanProvider.ts:4556-4560 */
// §Git — granular git-policy strategy maps. The `?? '<default>'` here is
// the SINGLE source of the work-on-main default for built-in code roles
// (locked decision #2). Non-code roles get 'notSpecified' so they emit no
// clause. buildGitPolicyBlock treats `undefined` and `'notSpecified'`
// identically (pure builder).

/* AFTER — KanbanProvider.ts:4556-4560 */
// §Git — granular git-policy strategy maps. The `?? 'notSpecified'` here is
// the SINGLE source of the neutral default for built-in code roles: per the
// user's explicit decision (reversing former locked decision #2), code roles
// emit NO git-policy clause unless the user explicitly opts in. Non-code roles
// also get 'notSpecified'. buildGitPolicyBlock treats `undefined` and
// 'notSpecified' identically (pure builder). Stale persisted 'incremental'
// values are normalised to 'notSpecified' on read (see §5).
```

## Verification Plan

1. **Fresh config defaults (manual):** Reset/clear a Lead Coder role config (or test on a clean workspace). Open Kanban → Prompts → Lead Coder. Confirm all three git radios show **Not Specified** selected. Confirm the prompt preview contains **no `GIT POLICY:` block** (only the Git Safety Guardrail directive if that checkbox is on, but no branch/commit/push clauses).
2. **Explicit choice still emits:** Select "Current Branch" + "Commit When Done" + "Do Not Push"; confirm the `GIT POLICY:` block emits all three clauses. Switch back to "Not Specified" on each; confirm the block shrinks accordingly and disappears entirely when all three are Not Specified (and guardrail off).
3. **Incremental removed:** Confirm the Git Commit Strategy radio group has only three options: Commit When Done, Do Not Commit, Not Specified. No "Incremental Commits" option.
4. **Stale `incremental` migration:** On a workspace with a previously-saved `gitCommitStrategy: 'incremental'`, open the Prompts tab — confirm the radio shows **Not Specified** (normalised) and no clause is emitted. Confirm no crash in the renderer (no orphan checked radio).
5. **Custom agent parity:** Configure a custom agent; confirm its git radios default to Not Specified and have no Incremental option.
6. **TypeScript compile (type narrowing):** After removing `'incremental'` from the unions in `agentConfig.ts:10` and `agentPromptBuilder.ts:188`, the project must compile cleanly with no remaining `'incremental'` type references. Per `CLAUDE.md`, `dist/` is NOT used during development or testing (all testing via installed VSIX) and `dist/` staleness is never a verification gate — so the check is "TS compiles," not "`dist/` regenerates." Also confirm `AgentSkillExporter.ts:104,193` (which passes `gitCommitStrategy` straight through to `buildGitPolicyBlock`) still compiles — it contains no `'incremental'` literal, so it should narrow cleanly, but verify explicitly. (Compilation is skipped this session per directive.)
7. **Grep guard:** `grep -rn "incremental" src/` should return no git-strategy references — only the unrelated `projectContextSync.ts:17` comment ("cut incremental design") and the `TaskViewerProvider.ts` `_incrementallyRegisterPlan` method name, neither of which is a git-strategy reference.
8. **Comment rewrite check:** Confirm the comment blocks at `KanbanProvider.ts:4201-4205` and `4556-4560` no longer reference "locked decision #2" as the active work-on-main default — they now record the reversed neutral-default decision (see §8). A future reader should not be misled into reverting the `notSpecified` defaults.

### Automated Tests

None — verification is manual via an installed VSIX plus a TypeScript compile check, per project convention (`dist/` is not used in dev; automated tests are skipped this session per directive).

## Recommendation

**Complexity 3 → Send to Intern.** Five-site default change (`'current'`/`'whenDone'`/`'noPush'` → `'notSpecified'`), one option removal (`incremental`) across type unions + clause vocabulary + sanitisation allow-list, a stale-value normalisation pinned to one read site, and a comment rewrite. All sites are identified with line numbers; no new architecture. The only migration concern (stale persisted `incremental`) is handled by allow-list narrowing + read-time normalisation + the `GIT_COMMIT_CLAUSES` map no longer containing the key. Land before the sibling layout plan (see `## Dependencies`).

**Stage Complete:** LEAD CODED

## Review Findings

Reviewed commit `04fa5e9`. Files changed: `sharedDefaults.js` (radio defaults + `DEFAULT_ROLE_CONFIG` → `notSpecified`, `incremental` option removed), `kanban.html` (custom-agent fallback defaults + `incremental` removed), `KanbanProvider.ts` (merge fallback 4230-4232, per-role maps 4587-4620 → `notSpecified`, inline `incremental`→`notSpecified` normalisation for all four code roles, locked-decision-#2 comments rewritten), `agentConfig.ts` and `agentPromptBuilder.ts` (`incremental` dropped from type unions, allow-list, and `GIT_COMMIT_CLAUSES`). Grep guard confirms no stray git-strategy `incremental` references remain; the custom-agent path degrades gracefully to no clause for stale `incremental` (allow-list drop + missing clause key, no crash). No CRITICAL/MAJOR findings; no code fixes applied. Remaining risk (documented, acceptable): a custom agent with a previously-saved `incremental` shows no radio selected rather than snapping to Not Specified. Compile/tests skipped per session directive.

**Stage Complete:** CODE REVIEWED
