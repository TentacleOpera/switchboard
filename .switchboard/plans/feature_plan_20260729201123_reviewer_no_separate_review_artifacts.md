# Add Default Reviewer Prompt Add-on Prohibiting Separate Review Artifact Files

## Goal
The goal of this task is to enforce a default-on prompt directive for the Reviewer Agent in Switchboard that explicitly prohibits creating separate review artifact markdown files (e.g., `review.md`, `review_artifact.md`, or standalone notes files in `.switchboard/plans/` or the workspace root).

### Problem Analysis & Root Cause
When the Reviewer Agent executes a code review pass, LLM agents frequently default to creating new markdown artifacts (such as `review_notes.md` or `review_artifact.md`) to record their evaluation findings. 

In Switchboard, the `PlanWatcher` service monitors the `.switchboard/plans/` directory for any new `.md` files. When a reviewer agent creates a standalone `.md` file inside or near `.switchboard/plans/` (or in watched workspace directories), `PlanWatcher` detects the file creation event and automatically imports the file as a brand new Plan card on the Kanban board.

This results in unwanted, duplicate, and confusing cards flooding the Kanban board whenever a review runs.

Root cause analysis reveals:
1. `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` in `agentPromptBuilder.ts` instructs reviewers to update the original plan file, but does NOT explicitly forbid creating separate markdown review files or review artifacts.
2. There is no explicit, default-enabled reviewer prompt addon option in `CustomAgentAddons` and `agentPromptBuilder.ts` that provides a clear directive warning the LLM about the file watcher behavior and forbidding standalone review artifact creation.

**Clarification — verified ingestion scope (code-read, 2026-07-30).** The mechanism is real, and the two root causes above are confirmed, but the blast radius is narrower than "watched workspace directories" implies. Verified facts:
- The watcher glob is `.switchboard/{plans,features}/**/*.md` (`GlobalPlanWatcherService.ts:140`), and the 10s periodic sweep walks **only** `.switchboard/plans` and `.switchboard/features` (`PlanIngestionEngine._scanForNewFiles`, `PlanIngestionEngine.ts:270-295`). A `review.md` written at the **workspace root** is therefore *not* ingested by this watcher.
- Inside those two directories there is effectively **no filter**: the only filename guard in `_handlePlanFile` is `isRuntimeMirrorPlanFile` (`PlanFileImporter.ts:238`), which matches only `brain_<64-hex>.md` / `ingested_<64-hex>.md`. Every other new `.md` is inserted as a fresh card in `CREATED` (`PlanIngestionEngine.ts:638-745`).
- A separate ingestion path (the Antigravity brain-dir scan) *does* already carry an artifact denylist — `TaskViewerProvider.EXCLUDED_BRAIN_FILENAMES` (`TaskViewerProvider.ts:556-562`) lists `grumpy_critique.md`, `balanced_review.md`, `review_response.md`, `post_mortem.md`. The `.switchboard/plans/` path has no equivalent. This asymmetry is the deterministic gap; see **Follow-Up (Out of Scope)** below.

The directive keeps the broader wording (workspace root included) because prohibiting stray artifacts anywhere is harmless and desirable — but the *reason* clause must name the two directories that actually trigger ingestion, or the agent is being told something it can check and find false.

## Metadata
- **Complexity:** 5
- **Tags:** backend, bugfix, feature

> **Superseded:** **Complexity:** 3 — "Low risk. Must ensure custom prompt overrides do not accidentally drop the anti-artifact directive."
> **Reason:** Not a single-file localized change. It spans six files across three key namespaces (persisted UI addon keys, `CustomAgentAddons`, `PromptBuilderOptions`), requires a *default-true* boolean — which the existing addon parser and skill exporter both mishandle by default (`=== true` / `!== undefined` gates silently drop the "off" state) — and its dominant failure mode is **silent**: a key-name mismatch makes the toggle a no-op that every default-on test still passes. Multi-file coordination plus a silent-failure mode is the definition of Mixed (5-6).
> **Replaced with:** **Complexity:** 5 → Send to Coder.

## User Review Required
- None. The directive wording, the default-on choice, and the file-set are all determined by the plan's stated goal. The one genuinely external question (optimal phrasing of a prohibition directive) is recorded under **Uncertain Assumptions** with a research hand-off rather than left as a decision gate.

## Complexity Audit

### Routine
- Adding a `NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE` string constant to `agentPromptBuilder.ts`.
- Adding `noSeparateReviewArtifactsEnabled?: boolean` to `PromptBuilderOptions` and `CustomAgentAddons`.
- Adding one `ROLE_ADDONS.reviewer` checkbox entry and one `DEFAULT_ROLE_CONFIG.reviewer.addons` default in `src/webview/sharedDefaults.js`.
- Adding assertions to `agentPromptBuilder.test.ts` and `autoban-reviewer-prompt-regression.test.js`.

### Complex / Risky
- **Two key namespaces must be wired in lockstep.** Persisted role-config addons use short names (`advancedRegression`, `reviewerConciseMode`, `reviewerCompactPlanUpdate`); `CustomAgentAddons` / `PromptBuilderOptions` use `*Enabled` names; `AgentSkillExporter.normalizeBuiltinAddons` (`AgentSkillExporter.ts:90-92`) translates between them. Getting one name wrong yields a toggle that reads `undefined` forever and — because the default is `true` — fails *silently in the on direction*: the checkbox appears to work, the directive never turns off, and every default-on test still passes.
- **Default-true round-trip.** `parseCustomAgentAddons` (`agentConfig.ts:198-200`) uses `if (s.X === true) a.X = true`, which discards an explicit `false`. A default-true addon added that way cannot be disabled for custom agents. The correct precedent already in the file is `if (s.useSubagents === false) a.useSubagents = false;` (`agentConfig.ts:214`).
- **Override survivability.** The directive must survive a `replace`-mode `defaultPromptOverride`, which wholesale replaces the reviewer `base` string (`resolveBaseInstructions`, `agentPromptBuilder.ts:325-333`).
- **Prohibition-vs-completion collision.** The reviewer's completion handshake *is* an edit to the plan file inside `.switchboard/plans/` (mtime advance clears the card's activity light). A directive that reads as "do not touch .md files in .switchboard/plans/" can suppress that edit and break completion detection. The directive must forbid **creation**, explicitly permitting the in-place edit.
- **Existing-install exporter divergence.** `normalizeBuiltinAddons` gates on `!== undefined`, so installs whose persisted reviewer addons predate this key export a skill file *without* the directive while dispatch *includes* it.
- **Neither target test file is wired to any gate** (see Verification Plan) — assertions added without wiring are inert.

## Edge-Case & Dependency Audit

### Race Conditions
- None. The add-on is resolved synchronously at prompt-build time from already-loaded role config; there is no async read, no file write, and no shared mutable state introduced.

### Security
- None. The change adds a static string to a prompt and one boolean to config. No new input is interpolated into the prompt, no path is constructed from user data, and no new file/network access is introduced.

### Side Effects
- **Reviewer prompt length grows** by ~11 lines / ~110 tokens on every reviewer dispatch (default-on). Acceptable; `cavemanOutput` and concise mode are unaffected (neither touches this block).
- **Newline hygiene:** `src/test/minimal-prompt.test.js` asserts no `\n\n\n` in any role × option combination. The directive constant must not begin or end with a newline, and must be joined with the existing `'\n\n'` separator — not concatenated with its own leading break.
- **Exported skill files** (`.agents/skills/switchboard-reviewer.md`) change content once the exporter branch is added; that is intended parity, not a regression.
- **Prompts-tab preview** picks the directive up for free — `_getDefaultPromptPreviews` (`KanbanProvider.ts:4265-4320`) delegates to `generateUnifiedPrompt`, which is the same path dispatch uses. No separate preview wiring is needed.

### Dependencies & Conflicts
- **Custom prompt overrides:** `replace` mode drops everything inside `base`. Placement must be outside `base` (see Proposed Changes). `prepend`/`append` are unaffected either way.
- **Concise / Compact-plan-update modes:** both operate by `String.replace` against the exact text of `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` (`agentPromptBuilder.ts:1308-1325`, guarded by an explicit WARNING comment). Do **not** insert the directive into that literal — any edit to that text risks silently breaking those two replacements. Keeping the directive out of `base` also satisfies this constraint.
- **`buildCustomAgentPrompt` (`agentPromptBuilder.ts:1831-1940`) is a second, independent prompt path.** Custom agents doing review work will not receive this directive unless their addon is set. Deliberately out of scope for this plan (the ask is the built-in `reviewer` role); noted so it is a known limitation rather than a surprise.
- **Batch dispatches:** one prompt covers the whole batch, so batch uniformity is automatic — no per-plan handling required.
- **Migration:** none needed, and none is safe to skip. Existing installs simply lack the key; both the read side (`?? true` in `_getPromptsConfig`) and the UI side (`roleConfigs[role]?.addons?.[addon.id] ?? addon.default` at `kanban.html:3783`) resolve absent → default. The two defaults **must agree on `true`** — a `default: false` in `sharedDefaults.js` paired with `?? true` in `_getPromptsConfig` would render the checkbox unchecked while the directive fires anyway.

## Dependencies
- None.

## Adversarial Synthesis
Key risks: (1) a key-name mismatch between the persisted addon (`noSeparateReviewArtifacts`) and the builder option (`noSeparateReviewArtifactsEnabled`) makes the toggle a silent no-op that every default-on test still passes; (2) appending the directive to `reviewerBaseInstructions` puts it inside `base`, where a `replace`-mode override deletes it — the exact hole `ensureCompletionDirective` exists to patch; (3) both target test files are unwired from `npm test` and CI, so added assertions never execute. Mitigations: wire both key names explicitly and assert the *off* path as well as the on path; emit the directive as its own `promptParts` element (override-proof by construction) and assert it survives a `replace` override; add a `test:contract:reviewer-prompt` script plus a CI step, and register the compiled builder test in `.vscode-test.mjs`. Residual risk: a prompt directive is advisory — it reduces but does not eliminate stray artifacts, and no other role receives it (see Follow-Up).

## Proposed Changes

### [Backend Services]

#### [MODIFY] [agentPromptBuilder.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentPromptBuilder.ts)

**Context.** `buildKanbanBatchPrompt` is the canonical builder every prompt surface routes through (Copy Prompt, Advance, autoban, previews). The reviewer branch starts at line 1261. Option defaults are read in a block at lines 1032-1060. The reviewer prompt is assembled from a `promptParts` array at lines 1355-1363.

**Logic.** Add an exported directive constant, an option flag defaulting to `true`, and emit the directive as its **own element of `promptParts`** — not appended to `reviewerBaseInstructions`.

> **Superseded:** Step 3 of the original plan — append to the base string:
> ```typescript
> const noSeparateReviewArtifactsEnabled = options?.noSeparateReviewArtifactsEnabled ?? true;
> if (noSeparateReviewArtifactsEnabled) {
>     reviewerBaseInstructions += '\n\n' + NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE;
> }
> ```
> **Reason:** `reviewerBaseInstructions` is fed to `resolveBaseInstructions('reviewer', …)` (line 1331), and a `replace`-mode `defaultPromptOverride` replaces that whole string (line 329) — the directive vanishes for exactly the users who customised their reviewer prompt. This is the same failure the file already documents and works around for the completion directive (`agentPromptBuilder.ts:1339-1345`, `ensureCompletionDirective`), and it directly contradicts this plan's own Edge-Case requirement that the directive survive `replace` mode. Appending to `base` also drops it *before* the concise/compact `String.replace` passes at lines 1312-1325, whose WARNING comment forbids perturbing that text.
> **Replaced with:** emit the directive as a separate `promptParts` element, mirroring `advancedReviewerBlock` (line 1302) — which is override-proof because it lives outside `base`.

**Implementation.**

1. Directive constant — place beside `ADVANCED_REVIEWER_DIRECTIVE` (line 903).

> **Superseded:** an earlier draft of this directive as ALL-CAPS-labelled prose (`REVIEW OUTPUT LOCATION (on by default): … REASON: Switchboard's plan watcher ingests every new .md file under .switchboard/plans/ and .switchboard/features/ …`).
> **Reason:** web research (see **Resolved Assumptions**) identified three defects. (a) An entangled permit/forbid pair on the same object class (`.md` files) is the documented trigger for *collateral suppression* — the model over-generalises the prohibition and stops editing the plan file too; XML enclosure of the two rules is the measured mitigation (~25–30% error reduction on structured prompts, and the pattern Anthropic's own guidance prescribes). (b) Enumerating the two watched directories inside the *reason* clause hands a reasoning model a navigable escape hatch ("then I'll write it at the repo root instead") — the documented CoT-over-reasoning pitfall. (c) The prohibition was keyed to file *extension* rather than file *operation*, where action-verb disambiguation (instantiate vs. mutate-in-place) is what actually separates the forbidden action from the required one.
> **Replaced with:** the XML-structured, verb-disambiguated block below. Paths are named in the *prohibition* (`anywhere in the repository`), never as a scoped list in the reason.

```typescript
export const NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE = `<file_modification_policy>
  <required_action>
    Record your review findings in your response, and in the existing target plan file listed under PLANS TO PROCESS — edit that file in place. This edit is expected and required: it is the completion signal that clears the card's activity light.
  </required_action>
  <forbidden_action>
    You MUST NOT create any new file for this review, anywhere in the repository — no review.md, review_notes.md, review_artifact.md, grumpy_critique.md, balanced_review.md, no temporary notes file, no scratch file under any name or directory.
  </forbidden_action>
  <reason>
    Switchboard's plan watcher ingests newly created .md files as Kanban cards, so a review artifact file becomes a duplicate plan card on the board.
  </reason>
</file_modification_policy>`;
```

**Convention note for the reviewer of this change:** every other directive in this file is `ALL_CAPS_LABEL: prose`. The departure is deliberate and confined to this one block — it is the only directive in the reviewer prompt carrying an entangled permit/forbid pair over one object class, which is precisely the case XML delimitation is documented to fix. Do not "normalise" it back to prose, and do not convert the other directives to XML.

2. Option flag — add to `PromptBuilderOptions` next to `reviewerCompactPlanUpdateEnabled` (line 169):

```typescript
    /** When true (default), the reviewer prompt forbids creating separate .md review artifact files. */
    noSeparateReviewArtifactsEnabled?: boolean;
```

3. Default read — in the option-defaults block (after line 1038). **Default `true`**, unlike its neighbours:

```typescript
    const noSeparateReviewArtifactsEnabled = options?.noSeparateReviewArtifactsEnabled ?? true;
```

4. Block + emission — in the reviewer branch, after `advancedReviewerBlock` (line 1302):

```typescript
        const noSeparateReviewArtifactsBlock = noSeparateReviewArtifactsEnabled
            ? NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE
            : '';
```

then insert it into `promptParts` (lines 1355-1363) as the **last instruction element — immediately after `featureDirectiveBlock` and immediately before the `PLANS TO PROCESS` data block**:

```typescript
        const promptParts = [
            reviewerExecutionBlock,
            safeguardsBlock,
            advancedReviewerBlock,
            baseInstructions,
            suffixBlock,
            featureDirectiveBlock,
            // Tail-anchored deliberately — see the placement note below. Keep this the
            // last instruction element; PLANS TO PROCESS is data, not instruction.
            noSeparateReviewArtifactsBlock,
            `PLANS TO PROCESS:\n${planList}`
        ].filter(Boolean).join('\n\n');
```

**Placement rationale (do not "tidy" this into the middle).** The assembled reviewer prompt runs ~1.5–4k tokens across ~8 blocks, which is squarely inside the range where positional-bias research measures a large adherence drop for constraints landing in the middle third; both Anthropic's and Google's published guidance put hard output constraints at the final lines before execution. Placing the block after `baseInstructions` — where an earlier draft of this plan had it — buries it mid-prompt, behind the longest block in the prompt (the 10-step base instructions).

The research also describes *dual anchoring* (head **and** tail). **Decision: single tail anchor.** Recency is the stronger of the two for a constraint that must bind at tool-call time, and a second copy would mean two literals that can silently drift apart — the failure this file already carries scars from (the `String.replace` coupling at lines 1308-1325 exists behind a WARNING comment for exactly that reason). One copy, correctly placed, no drift. If field evidence later shows the tail anchor alone is insufficient, add the head anchor by referencing the same exported constant — never by re-typing the text.

**Edge Cases.** `''` when disabled is stripped by the existing `.filter(Boolean)` — no stray blank line, so `minimal-prompt.test.js`'s no-`\n\n\n` assertion holds. The XML block's internal lines are single-newline separated; do not add a leading or trailing newline inside the template literal, and do not blank-line-separate the tags. Do not touch `DEFAULT_REVIEWER_BASE_INSTRUCTIONS` (lines 1262-1297) at all — root cause #1 is addressed by the new block, not by editing that literal, which two `String.replace` call sites are coupled to. Do **not** add a `CRITICAL:` prefix: the reviewer prompt already carries two (`agentPromptBuilder.ts:1297` and `BATCH_EXECUTION_RULES`), and stacking a third is the documented *constraint poisoning* regime where added emphasis degrades adjacent task performance. The single `MUST NOT` inside the XML is the intended emphasis budget.

#### [MODIFY] [agentConfig.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/agentConfig.ts)

**Context.** `CustomAgentAddons` (line 3) is the addon shape for custom-agent definitions; `parseCustomAgentAddons` (line 187) is its allowlist parser.

**Logic.** Add the field, and parse it with the **`=== false`** form so an explicit disable survives a reload.

**Implementation.** In the interface, after line 22:

```typescript
    noSeparateReviewArtifactsEnabled?: boolean; // Default ON: prohibit creating separate .md review artifacts
```

In `parseCustomAgentAddons`, after line 200 — note the inverted test, matching the `useSubagents` precedent at line 214:

```typescript
    // Default-ON addon: only an explicit `false` is meaningful to persist. Using the
    // `=== true` form here (as the neighbouring addons do) would discard the user's
    // "off" choice on every reload, because absent === enabled for this flag.
    if (s.noSeparateReviewArtifactsEnabled === false) a.noSeparateReviewArtifactsEnabled = false;
```

**Edge Cases.** `parseCustomAgentAddons` returns `undefined` when the result object is empty (line 260) — writing `false` is the only key this addon ever contributes, which is correct and harmless.

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

**Context.** Two coupled sites, both already handling the three sibling reviewer addons:
- `_getPromptsConfig` (line 4848) reads persisted role config via `_getRoleConfig('reviewer')` → `getScopedRoleConfig`, and maps **short** addon keys to `*Enabled` config keys (lines 4900-4902).
- `generateUnifiedPrompt`'s `role === 'reviewer'` branch (lines 4726-4729) copies those into `resolvedOptions`.

**Logic.** Wire both, using the short key `noSeparateReviewArtifacts` on the persisted side and `noSeparateReviewArtifactsEnabled` on the config/options side. **Default `true` at the read site.**

**Implementation.** In `_getPromptsConfig`, after line 4902:

```typescript
            noSeparateReviewArtifactsEnabled: reviewerConfig?.addons?.noSeparateReviewArtifacts ?? true,
```

In the reviewer branch of `generateUnifiedPrompt`, after line 4729:

```typescript
            resolvedOptions.noSeparateReviewArtifactsEnabled = promptsConfig.noSeparateReviewArtifactsEnabled;
```

**Edge Cases.** Pass the resolved value straight through — do **not** re-apply `?? true` here. The `?? true` belongs at the single read site so that an explicit `false` from the Prompts tab reaches the builder intact; double-defaulting is harmless today but becomes a bug the moment anything writes `null`. No `vscode.workspace.getConfiguration` fallback is needed: this add-on has no legacy VS Code setting (unlike `advancedReviewerEnabled` → `reviewer.advancedMode`), so there is nothing to migrate from.

#### [MODIFY] [AgentSkillExporter.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/AgentSkillExporter.ts)

**Context.** `normalizeBuiltinAddons` (line 83) translates persisted short keys → `CustomAgentAddons`; the renderer emits one `###` section per enabled addon (lines 238-252).

**Logic.** Normalize with a default-true fallback, then render.

**Implementation.** In `normalizeBuiltinAddons`, after line 92:

```typescript
        // Default-ON: absent key means enabled, so this cannot use the `!== undefined`
        // gate the sibling addons use — installs predating this key would export a skill
        // file missing a directive that dispatch does include.
        out.noSeparateReviewArtifactsEnabled = builtinAddons.noSeparateReviewArtifacts ?? true;
```

In the renderer, after line 252:

```typescript
        if (addons.noSeparateReviewArtifactsEnabled) {
            lines.push('### No Separate Review Artifacts');
            lines.push('```');
            lines.push(NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE);
            lines.push('```');
            lines.push('');
        }
```

Import `NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE` alongside the existing `CAVEMAN_OUTPUT_DIRECTIVE` / `SUPPRESS_WALKTHROUGH_DIRECTIVE` imports (used verbatim at lines 263-274).

**Edge Cases.** `normalizeBuiltinAddons` returns early when `builtinAddons` is falsy (line 87) — a role with no persisted addons exports no addon sections at all, unchanged behaviour. The directive renders inside a fenced block, matching the caveman/walkthrough precedent, so its internal newlines are safe.

### [Webview / Configuration UI]

#### [MODIFY] [sharedDefaults.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/sharedDefaults.js)

**Context.** This file is the **only** source of the Prompts-tab addon checkboxes: `ROLE_ADDONS` (line 110) is consumed by `renderRoleAddons` in `kanban.html` (line 3604), and `DEFAULT_ROLE_CONFIG` (line 19) supplies per-role addon defaults. The original plan omitted this file entirely, which would have shipped an add-on with no UI — unsettable, therefore never disableable, so the "default-on **add-on**" requirement would be unmet.

The file header reads `// CRITICAL: DO NOT CHANGE DEFAULTS UNLESS SPECIFICALLY ASKED`. **This plan is that specific ask:** the goal states the directive must be default-on. Add the entry with `default: true` and do not alter any other default.

**Logic.** Two additions, both using the short key `noSeparateReviewArtifacts`.

**Implementation.** In `DEFAULT_ROLE_CONFIG.reviewer.addons` (line 26), after `reviewerCompactPlanUpdate: false`:

```javascript
noSeparateReviewArtifacts: true,
```

In `ROLE_ADDONS.reviewer` (line 168), after the `reviewerCompactPlanUpdate` entry (line 172):

```javascript
        { id: 'noSeparateReviewArtifacts', label: 'No Separate Review Artifacts', tooltip: 'Forbid creating new .md review files — the plan watcher would import them as duplicate Kanban cards. Findings go in the response and in the existing plan file.', default: true },
```

**Edge Cases.** `renderRoleAddons` computes `isChecked = roleConfigs[role]?.addons?.[addon.id] ?? addon.default` (`kanban.html:3783`), so existing installs with no persisted key render **checked** — matching the `?? true` read in `_getPromptsConfig`. Both defaults must be `true`; a mismatch produces a checkbox whose state contradicts the emitted prompt. The custom-agent fallback addon list (`kanban.html:3607-3640`) is deliberately left alone — custom agents are out of scope (see Dependencies & Conflicts).

### [Tests]

#### [MODIFY] [agentPromptBuilder.test.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/__tests__/agentPromptBuilder.test.ts)

**Context.** Mocha **TDD** interface (`suite`/`test`), imports `buildKanbanBatchPrompt` directly. Existing reviewer add-on precedent at lines 134-143; `replace`-override precedent at lines 95-105.

**Logic.** Four tests — the *off* and *override* cases are the ones that actually discriminate; a default-on-only test passes even if the whole config chain is mis-wired.

**Implementation.** Add to the reviewer suite. Sentinel string: `<file_modification_policy>`.
1. Default (no options) → prompt includes `<file_modification_policy>`.
2. `noSeparateReviewArtifactsEnabled: false` → prompt does **not** include it.
3. `defaultPromptOverrides: { reviewer: { mode: 'replace', text: '…' } }` → prompt **still** includes it (the override-survivability guarantee).
4. Prompt includes the in-place-edit carve-out (`it is the completion signal that clears the card's activity light`) so the completion handshake can't be phrased away by a later edit.
5. **Tail-anchor position guard:** `prompt.indexOf('<file_modification_policy>') > prompt.indexOf('For each plan:')` **and** `prompt.indexOf('<file_modification_policy>') < prompt.indexOf('PLANS TO PROCESS')`. Without this, a future refactor can silently relocate the block into the mid-prompt dead zone the placement rationale exists to avoid — and no other assertion would notice.

#### [MODIFY] [autoban-reviewer-prompt-regression.test.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/test/autoban-reviewer-prompt-regression.test.js)

**Context.** This is a plain `node` script that reads `agentPromptBuilder.ts` **as text** and asserts `builderSource.includes(...)`.

> **Superseded:** "Update reviewer prompt snapshot assertions to reflect the anti-artifact directive inclusion."
> **Reason:** There are no snapshots in this file — it is a source-text presence checker (lines 11-68), so there is nothing to re-baseline. It is also not a mocha test; the original plan's `npx mocha src/test/autoban-reviewer-prompt-regression.test.js` command would not run it correctly.
> **Replaced with:** add two new `builderSource.includes(...)` assertions in the same style, and run the file with `node`.

**Implementation.** Add, following the existing pattern:

```javascript
    assert.ok(
        builderSource.includes('NO_SEPARATE_REVIEW_ARTIFACTS_DIRECTIVE'),
        'Expected the no-separate-review-artifacts directive constant to exist.'
    );
    assert.ok(
        builderSource.includes('<file_modification_policy>'),
        'Expected the reviewer prompt to carry the XML-delimited file modification policy.'
    );
    assert.ok(
        builderSource.includes('You MUST NOT create any new file for this review'),
        'Expected the reviewer prompt to forbid creating new review artifact files.'
    );
    assert.ok(
        builderSource.includes('it is the completion signal that clears the card'),
        'Expected the policy to explicitly permit the in-place plan-file edit.'
    );
```

#### [MODIFY] [package.json](file:///Users/patrickvuleta/Documents/GitHub/switchboard/package.json) and [.vscode-test.mjs](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.vscode-test.mjs)

**Context — this is the gate-wiring fix, and it is not optional.** Verified at HEAD:
- `src/test/autoban-reviewer-prompt-regression.test.js` appears in **no** `package.json` script (lines 762-802) and **no** CI step (`.github/workflows/integration-tests.yml`).
- `src/services/__tests__/agentPromptBuilder.test.ts` is **not** in `.vscode-test.mjs`'s `files` array (only `pair-programming-*`, `KanbanProvider`, `GlobalPlanWatcherService`, `kanban-complexity`), so `npm test` never runs it.

Both target files are therefore defined-but-not-invoked. Adding assertions without wiring them is the "green while incomplete" hole.

**Implementation.**
1. `package.json` scripts — add beside the other `test:contract:*` entries:
   ```json
   "test:contract:reviewer-prompt": "node src/test/autoban-reviewer-prompt-regression.test.js",
   ```
2. `.github/workflows/integration-tests.yml` — add a step running `npm run test:contract:reviewer-prompt`, alongside the existing `test:contract:*` steps.
3. `.vscode-test.mjs` — add `'out/services/__tests__/agentPromptBuilder.test.js'` to the `files` array so `npm test` (`vscode-test`, after `compile-tests`) executes it.

**Edge Cases.** Registering `agentPromptBuilder.test.js` may surface pre-existing failures in that previously-unrun file. Treat any such failure as a separate finding: report it, do not silently "fix" unrelated assertions to make the gate green.

## Verification Plan

### Automated Tests
Per the dispatch directives active for this plan, automated tests and compilation are **authored but not executed** in this pass. The commands below are the gate a subsequent pass (or CI) must run; the verdict until then is provisional.

- `npm run test:contract:reviewer-prompt` — source-presence assertions (new script, plain `node`).
- `npm run compile-tests && npm test` — runs `agentPromptBuilder.test.ts` via `vscode-test` once it is registered in `.vscode-test.mjs`. Note the TDD interface: if invoking mocha directly instead, `--ui tdd` is required or `suite`/`test` are undefined.
- `node src/test/minimal-prompt.test.js` — newline-hygiene guard (no `\n\n\n` in any role × option combination).
- `node src/test/kanban-default-prompt-previews.test.js` — requires `out/` (run `npm run compile-tests` first); confirms the mocked preview path still builds.

### Manual Verification
1. Prompts tab → Reviewer: the **No Separate Review Artifacts** checkbox is present and **checked** on an existing install that has never seen this key.
2. The reviewer prompt preview contains the `<file_modification_policy>` block, including the in-place-edit carve-out, and it appears as the **last block before `PLANS TO PROCESS:`**.
3. Untick the checkbox → the block disappears from the preview. Reload the window → it stays unticked (this is the round-trip that catches a key-name mismatch and the `=== true` parser trap).
4. Set a `replace`-mode reviewer prompt override → the block is **still** present in the preview.
5. Dispatch a real reviewer pass: the reviewer edits the target plan file in place, the card's activity light clears, and no new `.md` file appears in `.switchboard/plans/` or `.switchboard/features/` — and no new card appears on the board.
6. Re-export agent skills → `.agents/skills/switchboard-reviewer.md` contains the `### No Separate Review Artifacts` section.

## Resolved Assumptions
The one external uncertainty in this plan — the reliable phrasing and placement of a prohibition directive that must coexist with a nearly identical permission — was researched and **closed on 2026-07-30**. This section is authoritative: do not re-open it, and do not commission further research on it.

Findings applied to the directive above:
1. **Pure negative phrasing is unreliable; positive-only phrasing leaks.** Bare prohibitions suffer *negation decay* (the forbidden concept activates, the negation operator under-weights); positive-only redirection is read as additive, so the agent does the edit *and* writes the artifact. Hybrid framing — positive destination + explicit negative boundary + literal filenames — is the measured optimum (~40% fewer violations than bare-negative). **Applied:** `<required_action>` precedes `<forbidden_action>`, with the specific filenames enumerated.
2. **An entangled permit/forbid pair over one object class is the documented trigger for *collateral suppression*** — the model over-generalises "no new .md files" into "don't touch .md files" and skips the required plan-file edit, which here would break completion detection. XML enclosure of the two rules is the measured mitigation and matches Anthropic's published guidance. **Applied:** the two rules sit in separate XML elements, and the prohibition is keyed to the *operation* (create) not the *extension*.
3. **Position dominates in prompts of this size.** Mid-prompt constraints in a ~1.5–4k-token, ~8-block prompt lose substantial adherence; vendor guidance places hard constraints at the final lines before execution. **Applied:** tail anchor, with a position-guard test. Dual anchoring was considered and rejected on drift risk — rationale recorded inline at the placement note.
4. **A brief, declarative, system-oriented reason improves compliance; a verbose or navigable one invites workarounds.** A reasoning model given the specific watched directories will reason its way to an unwatched directory. **Applied:** the reason states the mechanism without enumerating paths; the prohibition itself says "anywhere in the repository". The verified path list stays in this plan's **Clarification** section, for humans, not in the agent-facing text.
5. **Emphasis markers work only sparingly; stacking them causes *constraint poisoning*.** The reviewer prompt already carries two `CRITICAL:` markers. **Applied:** no third `CRITICAL:`; one `MUST NOT` is the whole emphasis budget. Threat-style language ("you will be penalised") is cargo cult and is not used.
6. **Cross-model note.** Gemini is the family most vulnerable to mid-prompt constraint drops, and Google's guidance is the most explicit about tail placement — so the tail anchor is the right call for a multi-host product, not just a Claude optimisation. XML delimitation is documented as cross-model stable.

## Follow-Up (Out of Scope — Recommend a Companion Plan)
A prompt directive is advisory. It reduces stray review artifacts; it cannot guarantee their absence, and it reaches only the built-in `reviewer` role. Every other writer — coder/lead/intern/tester/analyst dispatches, custom agents, human-driven review sessions, fleet/orchestrator agents — can still drop an `.md` into `.switchboard/plans/` and mint a card.

The deterministic complement, which the codebase already precedents on its *other* ingestion path, is an artifact-filename/shape guard in `PlanIngestionEngine._handlePlanFile` (`PlanIngestionEngine.ts:638`) mirroring `TaskViewerProvider.EXCLUDED_BRAIN_FILENAMES` (`TaskViewerProvider.ts:556-562`). That would stop the card regardless of which agent, host, or prompt produced the file. It is genuinely separate scope (ingestion behaviour, not prompt content) and carries its own risk — a denylist can reject a legitimately-named plan — so it belongs in its own plan rather than being folded in here.

---

**Recommendation:** Complexity 5 → **Send to Coder.**
