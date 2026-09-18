# External-Agent Skill Launchers in the Connections Panel

## Goal

Surface a set of pre-written, one-click skill hand-offs in the Connections panel so long-running authoring and review work — memo processing, plan writing, plan/feature review — can be run on an **external AI surface** (Gemini Spark and equivalents) that writes its results straight back into `.switchboard/`, where the existing watchers import them.

### Problem & background

**The motivation is quota, not convenience.** Gemini Spark runs on Google's web-AI quota — a completely separate pool from the Anthropic spend that drives the local agents. Moving long-running authoring and review work onto that pool is the point of this plan. Speed is explicitly *not* the goal: Spark is slow, designed for long-running tool calls, which makes it a poor fit for synchronous control and a good fit for asynchronous, file-producing work.

**The hand-off mechanism already exists and ships.** `PlanningPanelProvider.ts:4734-4800+` (`case 'improveFeature'`) does exactly this:

1. Selects a skill file by context — `.agents/skills/improve-feature/SKILL.md` when the feature has subtasks, `.agents/skills/refine_feature.md` when it does not — with `.agent/` legacy fallback and an inline fallback prompt if neither is readable.
2. Reads the skill content and the current artifact content.
3. Composes `## Skill Instructions` + the artifact + the instruction **"Write the result back to the local file path provided."**
4. Hands the prompt to the user for pasting into any external agent.

That is a complete external-agent skill launcher. It is currently reachable from exactly one button, aimed at no particular surface, and is not described anywhere as a general capability.

**Why the return path needs no new transport.** Spark's *Connected Folders* grants read/write access to approved local directories using native macOS permissions — the Gemini app on the user's own machine, not a cloud fetch. So Spark can write directly to the path the prompt already names. `GlobalPlanWatcherService` (`src/services/GlobalPlanWatcherService.ts:141, 186`) watches plan files via `createFileSystemWatcher` and imports on write. Prompt out → external agent grinds on someone else's quota → file written → watcher imports → card appears on the board. No MCP server, no HTTPS tunnel, no OAuth, no new listener.

**Root cause of the gap:** the pattern is buried in one feature button, hard-codes a single skill-selection rule, and has no surface that presents "here are the jobs you can hand to an external agent." This plan generalises it and gives it a home.

**Scope boundary.** This plan does **not** add synchronous board control from an external agent — no tool calling, no MCP. It is a one-way prompt hand-off with a file-based return. Anything needing live board mutation from Spark remains parked in the MCP bridge plan.

---

## Metadata
**Complexity:** 5
**Tags:** ui, ux, feature, backend
**Project:** browser-switchboard

---

## User Review Required

**None.** Launcher set for v1 is decided: **process memo**, **write plans from a brief**, **review a plan**, **review a feature**. These map to skills that already exist. Additional launchers are cheap to add once the registry pattern is in place.

---

## Complexity Audit
* **Score:** 5 / 10

### Routine
* Generalising an existing, working prompt-composition path into a small registry keyed by launcher id.
* Rendering a list of launchers in a panel that the sibling plan is already creating.
* Reusing the existing clipboard verb (`copyTextToClipboard`, `TaskViewerProvider.ts:12148`) for delivery.

### Complex / Risky
* **Prompt correctness is the whole product.** The external agent has no Switchboard context beyond what the prompt carries. A launcher that omits the target file path, the plan-file conventions, or the "write the result back" instruction produces output the user must hand-place — which is worse than not offering the launcher.
* **Skill files must resolve in a packaged install.** The existing code reads `.agents/skills/…` from the **workspace root**, with a `.agent/` legacy fallback and an inline fallback constant. Any new launcher needs the same three-tier resolution or it silently degrades to a generic prompt on installs whose `.agents/` differs.
* **Write-back is unvalidated by construction.** An external agent writing directly into `.switchboard/plans/` bypasses every schema the local pipeline applies at creation time. The watcher will import whatever lands, including a malformed plan.
* **Two hosts.** Launchers must work in the browser cockpit and the extension; clipboard access differs between them and goes through the seam, never `vscode.*` directly (PRD contract #3).

---

## Edge-Case & Dependency Audit

### Race Conditions
* **Concurrent edit.** The external agent may write a plan file while a local agent or the user is editing the same file. The plan watcher is last-write-wins and there is no lock. Mitigation for v1 is procedural, not technical: launchers target artifacts the user has explicitly selected, and the prompt names one file. Do not add a locking scheme in this plan.
* **Import timing.** The file appears on the board when the watcher fires, not when the external agent finishes. There is no completion signal — the user learns it worked by seeing the card. Say so in the panel copy rather than implying a callback exists.

### Security
* Prompts are assembled from local skill files and local artifact content and handed to the user's clipboard. Nothing is transmitted by Switchboard; the user chooses where to paste.
* **Do not interpolate secrets, tokens or absolute paths outside the workspace into a prompt.** The prompt is destined for a third-party AI service, so treat everything it carries as published. Absolute workspace paths are necessary for the write-back instruction and are acceptable; anything else is not.
* Write-back arrives as untrusted file content. It is imported by the same watcher that imports any hand-edited plan, which is the existing trust boundary — but note that this plan meaningfully increases the volume of machine-authored files entering it.

### Side Effects
* **Board fills with externally-authored plans.** That is the intent. **Do not add provenance metadata** — no "authored by" line, no surface tag, no badge. Authorship of a plan is not meaningful information: a plan is judged on its content, and an externally-written one is no different from a locally-written one. Decided, not open.
* Memo processing rewrites `.switchboard/memo.md` and produces plan files; the sibling memo-watcher plan is what makes the memo half visible without a reload.

### Dependencies & Conflicts
* **Sibling plan — Connections panel.** This plan renders into it. Buildable against a stub, but not shippable until the panel exists.
* **Sibling plan — memo write-back watcher.** Only the memo launcher depends on it; the plan and review launchers do not.
* Existing prompt-composition path — `src/services/PlanningPanelProvider.ts:4734-4800+`.
* Clipboard verb — `copyTextToClipboard` (`TaskViewerProvider.ts:12148`, schema at `verbSchemas.ts:1316`).
* Skills on disk — `.agents/skills/improve-plan/SKILL.md`, `improve-feature/SKILL.md`, `refine_feature.md`, `.agents/workflows/switchboard-memo.md`, `.agents/skills/review/`.
* Plan watcher — `src/services/GlobalPlanWatcherService.ts:141, 186`.
* Memo path — `TaskViewerProvider.ts:4674` (`<workspaceRoot>/.switchboard/memo.md`).

---

## Dependencies
* None in `sess_…` form. Sequencing note: land the Connections panel plan first, or build against a stub container.

---

## Adversarial Synthesis

Key risks: (1) **prompt quality is the deliverable** — an external agent has zero Switchboard context, so a launcher that drops the target path, the plan-file conventions or the write-back instruction produces output the user has to place by hand, which is worse than no launcher; (2) **silent degradation** — skill files are read from the workspace `.agents/` with legacy and inline fallbacks, so a resolution miss yields a generic prompt that looks fine and produces weaker results; (3) **unvalidated write-back** — externally authored files enter through the plan watcher with no schema gate, and a malformed plan imports as readily as a good one. Mitigations: build every launcher on the existing three-tier skill resolution and assert the composed prompt contains the absolute target path and the write-back sentence; log which tier resolved so a fallback is visible rather than silent; verify each launcher end to end by actually running its prompt through an external agent and importing the result, not by eyeballing the prompt text.

---

## Resolved Assumptions

Confirmed by the user (2026-08-05) — treat as settled; do not re-research:

1. **Write access exists.** Apps with local file-system access — macOS Spark and macOS Claude Cowork both confirmed — can write directly into approved local folders, including hidden directories like `.switchboard/`. The file-based return path (prompt out → external agent writes back → watcher imports) works as designed. Cowork is a confirmed second surface alongside Spark.
2. **No programmatic prompt submission.** Spark cannot be pushed a prompt. Clipboard copy is the easiest and fastest delivery — the plan's clipboard-only design is correct, not a compromise. The only alternative path is an **inbox pattern**: leave instructions in a file the external agent is told to check — via a scheduled cron job (Spark and Cowork both support these) or a "check inbox" skill the user activates. **Out of scope for v1** — recorded here as the documented upgrade path if clipboard delivery ever becomes the bottleneck.
3. **No relevant platform limits.** Spark and Cowork can find hidden directories; no known timeouts — Spark is explicitly designed for long-running tasks. Spark runs on web quota, which is substantially larger than API or coding quota — confirming the quota motivation behind this whole feature.

---

## Proposed Changes

**Build order:** (1) extract the composer → (2) registry → (3) panel UI → (4) copy.

### 1. `src/services/externalAgentPrompts.ts` (new) — extract the composer

**Context:** the composition logic is currently inline in the `improveFeature` arm (`PlanningPanelProvider.ts:4734-4800+`) and is not reusable.

**Implementation:** extract a host-agnostic function:

```ts
export interface LauncherSpec {
    id: string;
    label: string;
    description: string;
    skillPaths: string[];        // tried in order, e.g. ['.agents/skills/improve-plan/SKILL.md', '.agent/skills/improve-plan/SKILL.md']
    fallbackPrompt: string;      // used when no skill file resolves
    targetKind: 'plan' | 'feature' | 'memo' | 'none';
}

export function composeExternalPrompt(
    spec: LauncherSpec,
    workspaceRoot: string,
    target?: { absPath: string; content: string }
): { prompt: string; resolvedSkillPath: string | null };
```

Preserve the existing prompt shape — `## Skill Instructions`, the artifact body, and the explicit write-back instruction naming the **absolute** target path.

**Logic:** keeping the shape identical means the existing Improve button can be repointed at this function with no behaviour change, which is the cheapest possible proof the extraction is faithful.

**Edge cases:** return `resolvedSkillPath: null` when every candidate misses so the caller can log the fallback. A silent fallback is the failure this field exists to prevent.

### 2. Launcher registry

**Implementation:** define the v1 set as data:

| id | label | Skill source | Target |
| --- | --- | --- | --- |
| `memo-process` | Process memo into plans | `.agents/workflows/switchboard-memo.md` | `.switchboard/memo.md` |
| `plan-write` | Write plans from a brief | `.agents/skills/improve-plan/SKILL.md` (authoring conventions + required sections) | none — agent creates new files in `.switchboard/plans/` |
| `plan-review` | Review a plan | `.agents/skills/improve-plan/SKILL.md` | selected plan file |
| `feature-review` | Review a feature | `.agents/skills/improve-feature/SKILL.md` | selected feature file |

**Logic:** `plan-write` has no target artifact, so its prompt must carry the plan-file conventions explicitly — the filename pattern, the required sections, and the rule that the agent writes into `.switchboard/plans/` and does **not** attempt to create board cards. Without that the external agent invents a shape the importer will not parse cleanly.

**Edge cases:** every launcher's prompt must state that the plan/feature `**Project:**` pin is set by the user on the board and that the external agent should not guess one — the AGENTS.md pinning protocol applies to externally authored plans exactly as it does to local ones, and an external agent has no way to resolve the active project.

### 3. Connections panel UI

**Implementation:** a "Hand off to an external AI" section listing each launcher with its label, one-line description, an artifact picker where `targetKind` requires one, and a **Copy prompt** button routed through the existing `copyTextToClipboard` verb.

**Logic:** clipboard, not auto-send. There is no API to push a prompt into Spark, and pretending otherwise would be a dead button (PRD contract #6).

**Edge cases:** where `targetKind` needs a selection and none is made, the button is **disabled with a reason**, never enabled-and-failing.

### 4. Panel copy — set expectations honestly

State plainly in the section header: the prompt is copied for pasting into an external AI; that AI must have write access to this workspace folder (in Gemini, *Settings → Connected Folders*); results appear on the board when the file lands and the watcher imports it; **there is no completion notification**.

---

## Verification Plan

### Automated Tests
Tests are skipped per session directive, and compilation is skipped per session directive. Target coverage for the coding pass:
* `composeExternalPrompt` unit tests: skill resolution across all three tiers (primary path, `.agent/` legacy, inline fallback) with `resolvedSkillPath` reported correctly; the composed prompt contains the absolute target path and the write-back sentence for every registry entry.
* A regression test asserting the existing `improveFeature` prompt is byte-identical before and after the extraction.

### Manual Verification
1. **Launchers render** in Connections with labels, descriptions and working artifact pickers.
2. **Copy works** in both hosts — browser cockpit and extension.
3. **End-to-end on the real surface (the only test that matters):** copy `plan-review`, paste into Gemini Spark with the workspace as a Connected Folder, let it run, confirm the file is rewritten in place and the board reflects the change after the watcher fires. Repeat for `feature-review`.
4. **`plan-write` from a brief:** the external agent produces plan files that the importer parses — correct filename shape, required sections present, no invented `**Project:**` pin.
5. **`memo-process`:** produces one plan per memo entry and clears the memo. Board shows the new cards. (Memo panel refresh depends on the sibling watcher plan.)
6. **Skill-resolution fallback is visible:** temporarily rename a skill file and confirm the fallback path is logged, not silent.
7. **Disabled state:** a launcher needing a target with none selected is disabled and says why.
8. **No secrets in prompts:** inspect a composed prompt and confirm it carries only skill text, artifact content and workspace-relative context.
9. **Plan import:** confirm the importer registers this plan on the board.

---

## Recommendation

Complexity 5 → **Send to Coder.**

---

## Review Findings

**Not complete — the code exists but is unreachable.** `src/services/externalAgentPrompts.ts` was created with `composeExternalPrompt` and the four-entry `LAUNCHER_REGISTRY`, but a repo-wide grep finds **zero callers**: no verb, no allowlist entry, no schema, no panel binding, and the Connections Hand-offs tab is an empty container. CRITICAL: dead code, so none of the plan's manual verification steps are even runnable. MAJOR: this is a *copy*, not the extraction the plan specified — `PlanningPanelProvider.ts:4734+` (`improveFeature`) is untouched, so the "repoint the Improve button, prompt byte-identical" proof was never performed and the shapes have already diverged (the new composer prepends `You are running an external AI task for Switchboard: <label>`). MAJOR: `resolvedSkillPath: null` is returned but never logged, so the silent-fallback failure the field exists to prevent is still silent; and `plan-write` (`targetKind: 'none'`) carries no plan-file conventions block — no filename pattern, no required sections, no "do not create board cards" rule. No fixes applied here: wiring a launcher surface is implementation, not review repair, and the panel it renders into is itself unwired (see the Connections panel plan's routing finding). Validation: `tsc --noEmit` and `npm run lint` pass; the plan's named unit tests (three-tier resolution, prompt-contains-absolute-path, `improveFeature` byte-identity) do not exist and are wired into no CI job.

### Second review pass (post-coder)

**Now reachable, with one CRITICAL fixed in this pass.** `SetupPanelProvider` gained a `getLauncherPrompt` arm calling `composeExternalPrompt`, so the composer is no longer dead code. But the arm was added without `npm run catalog:generate`, so the verb was absent from `SETUP_VERBS` — and `SetupPanelProvider.ts:51` throws `Unknown Setup verb` for anything not in that set, making the launcher a guaranteed dead click in both hosts. Catalog regenerated; the verb now dispatches. Two further defects fixed here: the arm called `composeExternalPrompt(spec, workspaceRoot)` with **no target**, so `plan-review` / `feature-review` / `memo-process` composed prompts whose write-back sentence said "write to the local file path provided" while providing none — the exact CRITICAL this plan names; it now reads the target file and returns `{success:false}` with a reason when a `targetKind !== 'none'` launcher gets no `targetPath`. And `LAUNCHER_REGISTRY.find(...) || LAUNCHER_REGISTRY[1]` silently ran `plan-write` for any unknown id — now an error. `resolvedSkillPath` is logged on fallback and returned in the body. **Still outstanding:** no Hand-offs UI (no artifact picker exists to supply `targetPath`, so no user can reach the arm yet), `improveFeature` is still not repointed at the composer, and none of the plan's unit tests exist.

### Third review pass (post-coder)

`connections.js` (452 lines) now carries the panel controller and the Hand-offs UI, and the launcher verb dispatches. No new defects in the launcher path itself this pass. A contract test (`src/test/scheduled-jobs-and-connections.test.js`, wired as `test:contract:scheduled-jobs` in `package.json` and `.github/workflows/integration-tests.yml`) now pins that every registry entry's composed prompt carries the absolute target path, a write-back instruction and the no-guessed-pin rule. Still outstanding: `improveFeature` in `PlanningPanelProvider` has not been repointed at `composeExternalPrompt`, so the extraction remains unproven against the original prompt shape.
