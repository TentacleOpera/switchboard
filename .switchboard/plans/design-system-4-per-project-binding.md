# Plan: Design System #4 — Per-Project Design System Binding, Defaulting to None

## Goal
Replace the workspace-global design-system setting with a **per-project binding whose default is none**. Most projects will never have a design system, and those must emit **no design-system block at all** — not an empty section, not a placeholder. The legacy global setting is honoured via a **one-time migration**, then retired; it does NOT survive as a standing fallback that quietly hands a design system to every project created from then on.

A project having a design system bound becomes the single, sufficient signal that it is a *design project* — which is what #5 gates injection on.

### Problem Context
The active design-system doc is stored as **two global config keys** — `planner.designSystemDocLink` (the path) and `planner.designSystemDocEnabled` (the gate) — written by the Design panel's `setActivePlanningContext` / `disableDesignDoc` handlers (`src/services/DesignPanelProvider.ts:2554`–`:2610`) via `pathConfig.updateConfigWorkspace` / `updateConfigGlobal` (which write VS Code `switchboard.*` configuration, `hostSeams.ts:181`–`:190` — note the handlers deliberately split scopes: link at workspace scope, enabled at global scope), and read back by `KanbanProvider._resolveDesignSystemDoc` (`:4465`), which consults both keys. Two problems follow:

1. **Wrong granularity.** A workspace with two projects in different visual languages cannot give each its own design system — there is exactly one slot.
2. **A global default is the wrong model outright.** Most projects are not design projects and must not receive a design system. Resolving a workspace-wide default for any unbound project means every project — including every project created in future — silently inherits one. That is precisely the behaviour to avoid.

The PRD already solved per-project resolution: `KanbanProvider._resolvePrdReferences(workspaceRoot, plans)` (`:4492`) walks the plans, resolves each plan's project to its PRD link, and produces `prdReferences: [{ projectName, prdLink }]`, emitted per project by the prompt builder (`agentPromptBuilder.ts:607`, and in `buildCustomAgentPrompt` at `:1869`). The design system needs the same resolution shape — but the *opposite* default.

### Root Cause Analysis
- **Modelled as a workspace-wide default rather than a per-project opt-in attribute**, so it cannot scale to multi-project workspaces and cannot express "this project has none".
- **Divergent from the PRD model:** the parallel PRD path already had per-project resolution; the design system never adopted it.

## Metadata
- **Tags:** backend, refactor, feature
- **Complexity:** 6

## User Review Required
- **None.** Settled: **no standing global fallback.** Resolution is per-project binding → else **none**. The legacy global keys are consumed by a one-time migration (below) and then retired. Unbound means no block is emitted.

## Migration & Compatibility (published extension — ~4,000 installs)
`planner.designSystemDocLink` + `planner.designSystemDocEnabled` shipped as released settings, so they cannot simply be dropped. But they must also not become a permanent fallback.

- **The keys are opt-in and unset for the large majority of installs.** Those installs already resolve to "no design system", so the new default changes nothing for them.
- **One-time migration for installs where they ARE set:** on first run of the new version, if the enabled gate is on and a link is present (checking both workspace and global scopes, workspace value winning per VS Code precedence — mirroring what `_resolveDesignSystemDoc` reads today), bind that doc to the projects that exist **at that moment**, then stamp the migration done (DB `config` table key, the blessed home for state) and stop consulting the global keys. Single-project workspaces — the common case — migrate exactly.
- **The distinction that matters:** a standing fallback makes every *future* project inherit the doc forever; a one-time snapshot preserves what the user already had and lets every new project start clean.
- **Do not delete the keys' stored values** — leave them in place (unread after migration) so a downgrade does not lose the user's configuration, and so the migration is idempotent if the stamp is lost.

### Binding storage

> **Superseded:** Store per-project bindings the same way per-project PRD links are stored (project record field), introducing no new persistence mechanism.
> **Reason:** Verified: per-project PRD links are **not** stored in a project record field. There is no such field — the `projects` table is minimal (`id, name, workspace_id, created_at, source`) — and `_resolveProjectPrd` (`KanbanProvider.ts:4455`) *derives* the path by filesystem convention: `getProjectPrdPath()` → `.switchboard/projects/<slug>/prd.md` (`prdUtils.ts`), existence-checked at read time. That convention cannot be copied literally for the design system, because the artifact is a user-chosen file living anywhere (often outside the workspace — the reference file does), so its location cannot be derived from the project name.
> **Replaced with:** Follow the PRD's *directory* convention with a **pointer file**: `.switchboard/projects/<slug>/design-system.json` containing `{ "path": "<bound file>" }` (workspace-relative when the file is inside the workspace, absolute otherwise — resolve at read, matching the plans convention). Bound = pointer file exists and its target resolves; unbound = no file. This reuses `sanitizeProjectSlug`/the existing per-project directory, needs no DB schema migration, survives DB rebuilds, and is readable by remote/DB-less agents.

## Dependencies
- **Depends on #2** (the `DESIGN SYSTEM` block must exist to be emitted per project). Benefits from **#1** (so an HTML artifact can be picked when binding) and **#3** (so the bound artifact's tokens are what gets injected).
- **#5 depends on this** — it gates injection on "is a design system bound to this plan's project", which only becomes answerable here.
- Independently shippable once #2 lands.

## Complexity Audit

### Routine
- Add `designSystemReferences?: Array<{ projectName: string; designSystemLink: string }>` to the addons/options types in `agentPromptBuilder.ts` (paralleling `prdReferences`).
- Add `buildDesignSystemReferencesBlock(refs)`, modeled on `buildPrdReferenceBlockFromRefs` (`:607`), reusing #2's framing per project.

### Complex / Risky
- Add `KanbanProvider._resolveDesignSystemReferences(workspaceRoot, plans)` mirroring `_resolvePrdReferences` (`:4492`). **It must return an empty array — not a global fallback — when no project has a binding.** It must be wired at **both** existing population sites: the custom-agent `mergedAddons` path (`:4543`–`:4544`, where `designSystemDocLink` is populated today) and the built-in-role `resolvedOptions` path (`:4665`) — the PRD equivalent populates at `:4556`–`:4558` and `:4642`–`:4644`. Missing either site silently drops the design system for that dispatch class.
- **Retire the legacy read path**: `_resolveDesignSystemDoc` (`:4465`) and its two call sites are replaced by the new resolver; the old single-doc addon fields stop being populated from global config (the fields themselves stay, per #2, as carriers).
- **The migration itself is the risky part.** It runs once per workspace, writes pointer files, and must be idempotent and stamped. Getting it wrong either loses a user's configured design system or re-applies on every activation. Idempotency is structural: re-running rewrites the same pointer files with the same content (no-op), and the DB-config stamp short-circuits it entirely.
- Extend `AgentSkillExporter` to export `designSystemReferences` the way it exports `prdReferences` (`:351`).
- Design System tab: evolve "Set as Active Design Doc" into a **bind-to-project** action (as the Planning panel's "Save as PRD" binds a PRD to a project), including an explicit **unbind** (delete the pointer file). This touches `DesignPanelProvider.ts` (`_sendActiveDesignDocState` `:2079`, the `setActivePlanningContext`/`disableDesignDoc` handlers at `:2554`–`:2610`, and `_setPlannerDesignSystemAddon`) and the tab UI in `design.{html,js}`. Retire the global-set affordance from the UI once the migration exists — keeping both visible is what made the old model confusing.

## Edge-Case & Dependency Audit

- **Race Conditions:** Migration runs on activation while the board may be creating projects concurrently — a project created mid-migration simply isn't in the snapshot, which is the intended "new projects start clean" semantic, not a bug. The stamp is written after the pointer files, so a crash mid-migration re-runs a structurally idempotent operation. Bind/unbind from the Design panel while a dispatch is building prompts resolves at read time (pointer file read per dispatch) — last write wins, no locking needed.
- **Security:** Pointer targets are user-chosen paths and may point outside the workspace (legitimate — the reference artifact does). The pointer file itself lives under `.switchboard/projects/<slug>/`, with the slug sanitised by the existing `sanitizeProjectSlug` (no traversal). Do not follow the pointer during resolution beyond reading the named file for injection — the same trust boundary as the legacy link.
- **Side Effects:** `AgentSkillExporter` output gains a key (additive). The Design panel UI changes verb ("Set as Active" → "Bind to project"); `_setPlannerDesignSystemAddon`'s auto-toggle of the planner addon must follow the binding model or be retired with the global keys. Multi-workspace: pointer files and migration are per-workspace by construction (each workspace has its own `.switchboard/`), matching per-workspace project scoping.
- **Dependencies & Conflicts:** Depends on #2's block; #5 consumes the resolver's semantics; #6 prefers the project-bound doc; #7 binds its output through this mechanism. Shares `agentPromptBuilder.ts` with #2/#3/#5 (additive symbols only — no contention on the same lines) and `DesignPanelProvider.ts`/`design.{html,js}` with #6/#7 (disjoint handlers/UI regions; coordinate the DS-tab controls strip layout with #6/#7, which add buttons beside this plan's bind control).

## Adversarial Synthesis
Key risks: (1) the migration — mis-stamping either loses configuration or re-applies repeatedly, mitigated by the DB-config stamp, structural idempotency (rewriting identical pointer files is a no-op), and leaving the legacy keys' values intact; (2) regressing to a fallback during implementation, silently reintroducing the rejected behaviour — mitigated by the explicit "empty ⇒ no block" assertion; (3) wiring only one of the two population sites, dropping the block for either custom or built-in dispatches — mitigated by tests covering both paths; (4) UI ambiguity during the transition, mitigated by retiring the global affordance rather than showing both.

## Proposed Changes

### `src/services/agentPromptBuilder.ts`
1. Add `designSystemReferences` to the addons/options types.
2. Add `buildDesignSystemReferencesBlock(refs)` reusing #2's framing (and #3's token table) per project.
3. Emit nothing when `designSystemReferences` is absent or empty. Remove reliance on the global-config-fed `designSystemDocLink`/`Content` addon values once the migration lands (the fields remain as carriers for the per-project content).

### `src/services/KanbanProvider.ts`
1. Add `_resolveDesignSystemReferences(workspaceRoot, plans)` mirroring `_resolvePrdReferences` (`:4492`): distinct projects from the plan batch → pointer-file lookup per project → `[{ projectName, designSystemLink }]`; `[]` when nothing is bound.
2. Populate at **both** sites: `mergedAddons` (`:4543`–`:4544` region) and `resolvedOptions` (`:4665` region), replacing the `_resolveDesignSystemDoc` calls.
3. Retire `_resolveDesignSystemDoc` (`:4465`).

### New: binding store + one-time migration
1. Pointer read/write helpers alongside `prdUtils` (e.g. `designSystemUtils.ts`): `getProjectDesignSystemPointerPath(workspaceRoot, projectName)` → `.switchboard/projects/<slug>/design-system.json`; read resolves the stored path (relative-to-workspace or absolute) and existence-checks it.
2. On activation, if the DB-config stamp is absent and the legacy gate+link resolve (workspace scope beating global, as `_resolveDesignSystemDoc` reads them today): write the pointer file for every project existing in that workspace, then set the stamp. Never consult the legacy keys afterwards. Leave their stored values untouched.

### `src/services/AgentSkillExporter.ts`
1. Export `designSystemReferences` alongside `prdReferences` (`:351`).

### `src/services/DesignPanelProvider.ts` + `src/webview/design.{html,js}`
1. Add a project selector to the bind action so a doc (including an HTML one, per #1) binds as a specific project's design system — writing the pointer file.
2. Add explicit unbind (delete the pointer file). Reflect per-project bound state in `_sendActiveDesignDocState` (`:2079`) / `activeDesignDocUpdated`.
3. Retire the global set/unset affordance (`setActivePlanningContext`/`disableDesignDoc` handlers, `:2554`–`:2610`) from the UI path once binding exists.

## Verification Plan

### Automated Tests
- `npm run compile`.
- `_resolveDesignSystemReferences`: two plans in two projects with different bound systems resolve to two distinct refs; **a plan in a project with no binding contributes nothing, and an all-unbound set returns `[]`**.
- Prompt-builder: an empty `designSystemReferences` emits **no** `DESIGN SYSTEM` block anywhere in the prompt (assert absence of the header string) — for both the built-in-role path and the custom-agent path.
- Migration: with the legacy gate+link set and two projects present, both pointer files are written and the stamp is set; re-running is a no-op; with the keys unset, nothing is bound and the stamp is still set (migration considered done).

### Manual Verification
1. Bind design system A to project X and B to project Y. Dispatch plans from each; confirm each prompt carries only its own project's block.
2. Dispatch a plan from a project with **no** binding; confirm the prompt contains no design-system block and no placeholder text.
3. Create a **new** project after migration; confirm it starts with no design system (this is the behaviour a standing fallback would have broken).
4. Simulate an upgrade with the legacy keys set; confirm existing projects keep working and the keys are not consulted again.

## Risk Assessment
- **Medium.** The resolver mirrors a proven PRD path, lowering that half of the risk. The real risks are (1) the migration — mis-stamping either loses configuration or re-applies repeatedly, mitigated by the stamp pattern, idempotency tests, and leaving the keys' values intact; (2) regressing to a fallback during implementation, which would silently reintroduce the rejected behaviour — mitigated by the explicit "empty ⇒ no block" assertion; (3) UI ambiguity during the transition, mitigated by retiring the global affordance rather than showing both.

**Recommendation:** Send to Coder
