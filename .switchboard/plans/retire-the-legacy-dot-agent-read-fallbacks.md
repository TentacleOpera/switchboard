# Retire the Legacy `.agent/` Read-Fallbacks, Keep the Config Migration

## Goal

Delete the 11 read-only fallback lookups (12 lines across 4 files) that resolve agent assets out of the singular `.agent/` directory, because activation-time seeding makes them unreachable. Keep the two `.agent/` mechanisms that are load-bearing — the persisted-config path migration and the guarded Setup-tab cleanup — and stop conflating them with the fallbacks.

### Problem & background

`.agent/` (singular) is the pre-rename scaffold directory; Switchboard now ships and seeds `.agents/` (plural). Three unrelated mechanisms still reference the old name, and they have been treated as one thing:

1. **Read-fallbacks (11 lookups, 12 lines, 4 files).** Every agent-asset lookup tries `.agents/…` and then a singular `.agent/…` sibling. A 13th match, `extension.ts:3764`, is a setup-*detection* leg rather than an asset lookup and is deliberately out of scope (see Proposed Changes).
2. **A persisted-config migration.** `TaskViewerProvider._normalizeAgentToAgents` (`:2686`) rewrites a leading `.agent/` segment in stored `workflowFilePath` values.
3. **A guarded, opt-in directory delete.** The Setup tab's cleanup card.

The confusion is that (1) is justified by the reasoning that actually only applies to (3). CLAUDE.md's migration rule protects *the user's directory on disk* — their edits, their custom personas — and (3) honours it correctly. `extension.ts:4216` states the contract: *"A pre-existing `.agent/` belongs to the user and must be left byte-for-byte untouched — the only sanctioned way to remove it is the guarded, opt-in Setup-tab cleanup button."* That is a rule about **not deleting files**. It says nothing about whether code should still *read* from there, and (1) has been carried along under its cover.

The cost of carrying (1) is not the dead branches themselves — it is that the fallback is copy-pasted inline at each call site instead of resolved in one place, so coverage has drifted with no policy behind it. `src/` holds 68 `.agents/protocols` references and only 7 legacy `.agent/skills` siblings. `improve-plan`, `improve-feature` and `refine_feature` have one; `accuracy`, `terminal-coder-dispatch`, `dispatch-analysis`, the mission-control set and every ClickUp/Linear/Notion protocol do not. Nobody decided that. The next protocol reference inherits whichever variant its author copied.

### Root cause — why the fallbacks cannot fire

`refreshWorkspaceControlPlane` (`extension.ts:328`, called at `:851`) runs on every activation for each managed root. It crawls the bundled `.agents/skills` and `.agents/workflows` and content-hash-copies every missing or differing file into the workspace's `.agents/`. When `needsAgentRefresh || agentsChanged` it then runs `scaffoldProtocolLayers` → `performSetup` (`:4318`), which crawls **all** of bundled `.agents` — `protocols/`, `personas/`, `rules/`, `plan-authoring-protocol.md` included. `.vscodeignore:57` (`!.agents/**`) confirms the whole tree ships.

So a `.agent/`-era user who upgrades has `.agents/` populated on the first activation of the new version. From that point the `.agents/` primary always resolves and the singular sibling is never consulted. The gate is `isSwitchboardManagedFolder`, which requires `.switchboard/` plus `kanban.db` or `db-pointer` — present in any workspace whose board actually works.

A second, independent reason the fallbacks do not protect what they appear to: once seeding creates `.agents/personas/coder.md` from the bundle, a user who had *customised* `.agent/personas/coder.md` gets the bundled copy, because the primary now exists and the fallback is skipped. The fallback cannot preserve a customised legacy asset even in principle.

### Residual risk — stated, not waved away

One reachable path survives the seeding argument. `isSwitchboardManagedFolder` skips a root with `.agent/` and `.switchboard/` but no `kanban.db`/`db-pointer` yet — a legacy workspace whose board has never been opened in the new version. The Setup tab's launcher (`SetupPanelProvider:372`) calls `composeExternalPrompt` and is reachable in such a root. There, removing the fallback changes behaviour: the launcher falls through to the spec's inline `fallbackPrompt`.

That is a degradation, not a break — every `LauncherSpec` carries a real `fallbackPrompt`, and `SetupPanelProvider:380` already logs the miss. The persona lookup is the one exception with no inline fallback: `_getPersonaForRole` returns `undefined`, so a role loses its persona block. Verification below tests this case rather than assuming it.

### Non-goals

- Removing or auto-deleting any user's `.agent/` directory. Out of scope; the opt-in Setup cleanup stays the only remover.
- Touching `_normalizeAgentToAgents` or its test. Load-bearing — see Proposed Changes.
- Introducing a shared `resolveProtocolPath()` helper. Tempting, but the point of this plan is that the thing the helper would centralise should not exist. Adding an abstraction over dead code is the wrong direction.
- The `.agents/protocols/` → `control_plane` rows migration (`protocols-as-db-rows-not-scaffolded-files.md`). Independent; this plan neither blocks nor depends on it.

---

## Metadata

**Tags:** cleanup, migration, tech-debt
**Complexity:** 3

---

## User Review Required

**None.** The scope is confined to removing unreachable branches, and the two mechanisms with real install-base consequences are explicitly preserved.

---

## Complexity Audit

* **Score:** 3 / 10

### Routine

- Deleting array entries from `skillPaths` / `relPaths` candidate lists.
- Collapsing one `if (!fs.existsSync(primary))` fallback branch in the persona lookup.

### Complex / Risky

- **The persona lookup** is the only site whose failure mode is a missing block rather than a weaker prompt. It must be verified against a real legacy-shaped workspace, not reasoned about.
- **`SparkContextExporter:140-149`** carries a comment stating its `AGENTS.md` candidate is load-bearing *"until the control-plane re-seeds"* — an explicit acknowledgement of a pre-re-seed window. That candidate is the root-level `AGENTS.md`, not a `.agent/` path, and **must survive**. Only the two singular `.agent/` entries in that list go.

---

## Edge-Case & Dependency Audit

### Race Conditions

- **Pre-re-seed window.** Panel actions cannot fire before activation completes, and `refreshWorkspaceControlPlane` is awaited at `extension.ts:851` during activation, so no panel action can observe an unseeded `.agents/` in a managed root. In an *unmanaged* root the refresh never runs at all — that is the Residual Risk case above, not a race.

### Side Effects

- A legacy-only unmanaged workspace using the Setup launcher gets the inline `fallbackPrompt` instead of the full protocol body. Already logged at `SetupPanelProvider:380`.

### Dependencies & Conflicts

- `src/test/planner-workflow-path-migration.test.js` exercises `_normalizeAgentToAgents` and seeds `.agent/workflows/...` config values. It stays green and untouched — this plan does not change that code path.
- `src/test/spark-context-exporter-contract.test.js` builds its fixture entirely under `.agents/` (`:84-90`), so it does not depend on any fallback being present.

---

## Proposed Changes

### `src/services/externalAgentPrompts.ts` — drop 4 candidates

Remove the singular sibling from each `skillPaths` array, leaving the `.agents/` primary:

- `:57` — `.agent/workflows/switchboard-memo.md` (spec `memo-process`)
- `:68` — `.agent/skills/improve-plan/SKILL.md` (spec `plan-write`)
- `:79` — `.agent/skills/improve-plan/SKILL.md` (spec `plan-review`)
- `:90` — `.agent/skills/improve-feature/SKILL.md` (spec `feature-review`)

Update the `skillPaths` doc comment at `:8`, which cites the two-entry legacy pair as its example. `composeExternalPrompt` keeps its loop and its `fallbackPrompt` behaviour — a one-element list is still a list, and the resolver stays honest about a total miss.

### `src/services/SparkContextExporter.ts` — drop 5 candidates, keep `AGENTS.md`

- `:145` — remove `.agent/plan-authoring-protocol.md`
- `:147` — remove `.agent/AGENTS.md`
- **Keep** `.agents/plan-authoring-protocol.md` and root `AGENTS.md`. Preserve the `:138-149` comment explaining why `AGENTS.md` is load-bearing, trimming only its reference to the singular paths.
- `:182` — remove `.agent/skills/improve-plan/SKILL.md`
- `:189` — remove `.agent/skills/improve-feature/SKILL.md`
- `:196` — remove `.agent/workflows/switchboard-memo.md`

### `src/services/PlanningPanelProvider.ts` — drop the legacy branch

`:5084-5085` computes `skillRelPathLegacy` as the singular twin of `skillRelPath` (branching on `subtaskCount` for improve-feature vs `refine_feature.md`). Delete the variable and reduce the `skillPaths` array at `:5100` to `[skillRelPath]`. The `hasSubtasks` selection logic, both `fallbackContent` strings, and the `:5111` warn are unaffected.

### `src/services/TaskViewerProvider.ts` — collapse the persona fallback

`_getPersonaForRole` (`:23264`) currently, on a missing `.agents/personas/<file>`, retries `.agent/personas/<file>` (`:23274-23279`) and returns `undefined` if that also misses. Reduce to a single read of the `.agents/` path, returning `undefined` when absent. Net behaviour is identical for every seeded workspace.

**Do not touch** `_normalizeAgentToAgents` (`:2686`) or its call sites (`:2703, 2721, 2727, 2780, 2794`). This is the one genuinely load-bearing `.agent/` mechanism: a `workflowFilePath` of `.agent/workflows/improve-plan.md` persisted in `kanban.db` never self-heals, because seeding writes files and does not rewrite config rows. Delete it and those installs point the planner at a path that has never existed under either name.

### `src/services/SetupPanelProvider.ts` — no change

`_getAgentDirCleanupState` (`:1842`), `_performAgentDirCleanup` (`:1931`) and `_configReferencesLegacyAgent` (`:1993`) all stay, including the three refusal guards (no `.agents/` present, symlink, config still references `.agent/`). This is the sanctioned remover and the only place that touches the user's directory.

### `src/extension.ts` — leave the detection leg alone

`hasSwitchboardProtocolFiles` (`:3759`) accepts a legacy `.agent/workflows` as evidence of setup. Its only consumer is the `needsSetup` flag at `:2419`, which drives a status-bar badge and the sidebar onboarding hint — nothing functional. Removing it would surface "Setup Required" to a legacy-only workspace, which is arguably the *correct* signal, but that is a UX decision with its own blast radius. Out of scope; noted so the next reader knows it was considered, not missed.

### Migration

None required. The change removes read paths that resolve to nothing on a seeded workspace, and preserves the one migration (`_normalizeAgentToAgents`) that the install base still depends on. No files are written, moved, or deleted on any user's disk.

---

## Verification Plan

### Goal Invariants

1. `grep -rn "'\.agent', 'skills'\|'\.agent', 'workflows'\|'\.agent', 'personas'\|'\.agent', 'plan-authoring-protocol.md'\|'\.agent', 'AGENTS.md'" src/ --exclude=extension.ts` returns **zero** matches (13 before the change, 12 of them in scope). The `--exclude` is load-bearing: `extension.ts:3764` is the detection leg this plan keeps, and an unscoped grep would demand its removal.
2. `grep -rn "normalizeAgentToAgents" src/` still returns the definition at `TaskViewerProvider.ts` plus its 5 call sites.
3. `grep -rn "'\.agent'" src/services/SetupPanelProvider.ts` still returns the cleanup-path matches.
4. The root `AGENTS.md` candidate remains in `SparkContextExporter`'s `resolveSourceFile` list.

### Automated Tests

- `src/test/planner-workflow-path-migration.test.js` — must pass unchanged. This is the regression guard for the migration this plan deliberately spares.
- `src/test/spark-context-exporter-contract.test.js` — must pass unchanged; its fixture is `.agents/`-only.
- **New test — legacy workspace seeds `.agents/`.** Build a temp root shaped like a pre-rename install: populated `.agent/{skills,workflows,personas}/`, **no** `.agents/`, and `.switchboard/kanban.db` present so `isSwitchboardManagedFolder` returns true. Assert that after `refreshWorkspaceControlPlane` + `scaffoldProtocolLayers`, `.agents/protocols/improve-feature/SKILL.md`, `.agents/personas/coder.md` and `.agents/workflows/switchboard-memo.md` all exist. This is the empirical claim the whole plan rests on; assert it rather than reason about it.
- **New test — persona resolution after the collapse.** With the seeded root above, `getPersonaForRole` returns content for every role in `ROLE_TO_PERSONA_FILE`. With a root that has neither directory, it returns `undefined` without throwing.

### Static checks

- `npx tsc --noEmit` clean — catches an orphaned `skillRelPathLegacy` or an unused import left by the persona collapse.
- Lint clean on the four touched files.

---

## Recommendation

Do it. The deletion is small and the reasoning behind keeping the fallbacks turned out to be borrowed from a different rule. The value is not the removed lines — it is that `.agent/` stops looking like a location the code supports, so nobody adds an eleventh inconsistent fallback to match the ten they found.

**Do this before** `protocols-as-db-rows-not-scaffolded-files.md` if both are queued. That plan rewrites protocol resolution wholesale; carrying ten dead legacy siblings into it means porting them into the new resolver and re-deciding this question under more pressure.

**Follow-up, not in scope:** the `hasSwitchboardProtocolFiles` legacy detection leg (see Proposed Changes) — a small UX call about whether a legacy-only workspace should see "Setup Required". Worth its own decision, not worth bundling here.
