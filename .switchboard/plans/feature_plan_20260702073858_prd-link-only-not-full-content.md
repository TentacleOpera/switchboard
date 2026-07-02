# Project Context should link the PRD file, not embed its entire content

**Plan ID:** b6181d56-1c39-447c-9831-3245010a62b5

## Goal

Make the per-project PRD reference **link-only**: when PROJECT CONTEXT is ON, the dispatched prompt carries the PRD file path (which the agent reads itself) instead of embedding the entire PRD document verbatim. This reduces per-prompt token bloat and aligns the PRD path with the link-only convention used by the design-system-doc resolver and workflow-file references.

### Problem
When the **PROJECT CONTEXT** toggle is ON in `project.html`, the planner prompt does not link the agent to the PRD file. Instead it copies the **entire PRD document** verbatim into the dispatched prompt. This bloats every prompt with the full PRD text when all that is needed is a file path/link the agent can read itself.

### Background
The per-project PRD feature (`project_context_enabled` toggle) resolves the active project's PRD file and injects it into the shared dispatch prefix (`dispatchPrefixCore`) so it reaches every role. The resolver `_resolveProjectPrd` reads the file from disk and returns **both** `prdLink` (the file path) and `prdContent` (the full file contents). The prompt builder `buildPrdReferenceBlock` then prefers `prdContent` over `prdLink` — embedding the entire document inline.

### Root Cause
`_resolveProjectPrd` (KanbanProvider.ts:3179) reads the file and returns `prdContent`. `buildPrdReferenceBlock` (agentPromptBuilder.ts:376) checks `if (content)` first and embeds the full text, only falling back to the link when content is absent. The same content-preference pattern is duplicated in the tester acceptance-baseline block (agentPromptBuilder.ts:945) and the custom-agent path (agentPromptBuilder.ts:1402).

The fix is to make the PRD reference **link-only**: the agent receives the file path and reads the PRD itself, exactly as it does for workflow files and the design-system-doc link path.

## Metadata
- **Tags**: `planner`, `prompt-builder`, `project-context`, `prd`, `token-reduction`
- **Complexity**: 3/10

> Note: `planner`, `prompt-builder`, `project-context`, `prd`, `token-reduction` are descriptive tags carried over from the original plan. The allowed-tag list in the workflow schema is a constrained vocabulary; these descriptive tags do not all map onto it. Closest allowed-list equivalents: `backend`, `api`, `refactor`, `performance`. The plan keeps the original descriptive tags for continuity; if the ingestor enforces the allowed list strictly, substitute `backend, refactor, performance`.

## User Review Required
No — the agent always runs against the workspace repo and has file-read access to `.switchboard/projects/<slug>/prd.md`. Link-only is safe across the entire dispatch surface.

## Complexity Audit

### Routine
- Targeted removal of content-embedding across three call sites in `agentPromptBuilder.ts` (lines 376, 945, 1402) and one resolver in `KanbanProvider.ts` (line 3179).
- No new state, no schema changes, no migration.
- The link-only resolver pattern already exists for design-system-doc (`_resolveDesignSystemDoc`, KanbanProvider.ts:3192 returns only the link).
- No tests assert on `prdContent` (verified: zero matches for `prdContent` across `src/**/*.test.ts`), so the change is test-safe.
- `PromptBuilderOptions.prdContent` (agentPromptBuilder.ts:251) and `agentConfig.ts:41` field can be left in place (harmless, avoids touching fixtures) — simply stop populating it.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions**: `_resolveProjectPrd` already tolerates a partially-written file via try/catch around `readFile`. Link-only removes the read entirely, so the race window shrinks to `fs.existsSync` — a benign TOCTOU that at worst returns `{}` (no PRD injected), same as today's missing-file branch.
- **Security**: The PRD path is produced by `getProjectPrdPath` (prdUtils.ts:33), which sanitises the project name into `[a-z0-9_-]` and joins under `.switchboard/projects/<slug>/prd.md`. No `..` traversal is possible. Injecting the path as a link (vs. content) does not change the trust boundary — the agent already had the path in the content-preference fallback.
- **Side Effects**: Prompts shrink (token reduction — the intended effect). No persistence, no kanban DB writes, no config changes.
- **Dependencies & Conflicts**:
  - **Notion-sourced PRDs**: `_resolveProjectPrd` currently only reads local files (`getProjectPrdPath`). A link-only approach works because the path is always a local file path. If Notion PRDs are added later, the link would be a Notion URL — still valid for link-only injection. No blocker.
  - **Tester role**: The tester acceptance-baseline block (agentPromptBuilder.ts:945) also embeds `prdContent`. It must be converted to link-only too, otherwise the tester still gets the full doc while other roles get the link — inconsistent.
  - **Custom agents**: `buildCustomAgentPrompt` (agentPromptBuilder.ts:1402) has its own PRD block. Must be converted as well.
  - **Empty/missing PRD**: `_resolveProjectPrd` already returns `{}` when the file is missing or empty — no change needed.
  - **`prdContent` field on `PromptBuilderOptions`**: Left in the interface (harmless) to avoid touching `agentConfig.ts` and test fixtures. Simply stop populating it.
  - **Constitution precedent**: The constitution block (agentPromptBuilder.ts:951) uses the same content-preference pattern. This plan does NOT touch the constitution path — only the PRD path, per the user's request.
  - **Design-system-doc framing correction**: The original plan claimed "design-system-doc returns only a link; workflow files are referenced by path" as a precedent. Verified: `_resolveDesignSystemDoc` (KanbanProvider.ts:3192) is link-only at the resolver, but `agentPromptBuilder.ts` still retains dead content-preference branches for it (lines 810-812, 1388-1389). The resolver precedent holds; the builder is not yet fully link-only for design-system-doc. This does not affect the PRD fix but is noted for accuracy.

## Dependencies
- None — self-contained refactor of the PRD injection path.

## Adversarial Synthesis
Key risks: (1) the tester and custom-agent call sites must be converted alongside the planner path or the prompt becomes inconsistent across roles; (2) leaving `prdContent` on the interface is harmless but creates a dead field that future contributors may re-populate. Mitigations: convert all three builder call sites in one pass; add a one-line comment on `prdContent` marking it deprecated/link-only.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — stop reading file content into `prdContent`
In `_resolveProjectPrd` (line 3179), return only the link; do not read the file contents.

```ts
// BEFORE (line 3179-3190)
private async _resolveProjectPrd(workspaceRoot: string, projectName: string | null | undefined): Promise<{ prdLink?: string; prdContent?: string }> {
    if (!projectName || projectName === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return {};
    const { getProjectPrdPath } = require('./prdUtils');
    const filePath = getProjectPrdPath(workspaceRoot, projectName);
    if (fs.existsSync(filePath)) {
        try {
            const prdContent = await fs.promises.readFile(filePath, 'utf8');
            if (prdContent.trim()) return { prdLink: filePath, prdContent };
        } catch { /* non-fatal */ }
    }
    return {};
}

// AFTER
private async _resolveProjectPrd(workspaceRoot: string, projectName: string | null | undefined): Promise<{ prdLink?: string }> {
    if (!projectName || projectName === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return {};
    const { getProjectPrdPath } = require('./prdUtils');
    const filePath = getProjectPrdPath(workspaceRoot, projectName);
    if (fs.existsSync(filePath)) {
        return { prdLink: filePath };
    }
    return {};
}
```

Update the two call sites (lines 3243, 3304) that destructure `prdContent` — they no longer need to read it, but the destructuring can stay (it will just be `undefined`). The `if (prdLink || prdContent)` guards become `if (prdLink)`.

### 2. `src/services/agentPromptBuilder.ts` — `buildPrdReferenceBlock` emits link only (line 376)
```ts
// BEFORE (line 376-389)
export function buildPrdReferenceBlock(options: PromptBuilderOptions | undefined, role: string): string {
    if (role === 'tester') return '';
    if (!options?.prdEnabled) return '';
    const link = options.prdLink?.trim();
    const content = options.prdContent?.trim();
    if (!link && !content) return '';
    if (content) {
        return `PROJECT REQUIREMENTS (PRD):\nThe following product requirements apply to the active project and must be respected throughout this work:\n\n${content}`;
    }
    return `PROJECT REQUIREMENTS (PRD):\nThe following product requirements document applies to the active project and must be respected throughout this work:\n${link}`;
}

// AFTER
export function buildPrdReferenceBlock(options: PromptBuilderOptions | undefined, role: string): string {
    if (role === 'tester') return '';
    if (!options?.prdEnabled) return '';
    const link = options.prdLink?.trim();
    if (!link) return '';
    return `PROJECT REQUIREMENTS (PRD):\nRead the following product requirements document and respect it throughout this work:\n${link}`;
}
```

### 3. `src/services/agentPromptBuilder.ts` — tester acceptance-baseline block (line 945)
```ts
// BEFORE (line 945-949)
if (options?.prdContent) {
    blocks.push(`PRODUCT REQUIREMENTS (PRD) — primary acceptance baseline:\n\n${options.prdContent.trim()}`);
} else if (options?.prdLink) {
    blocks.push(`PRODUCT REQUIREMENTS (PRD) — primary acceptance baseline:\n${options.prdLink.trim()}`);
}

// AFTER
if (options?.prdLink) {
    blocks.push(`PRODUCT REQUIREMENTS (PRD) — primary acceptance baseline:\nRead ${options.prdLink.trim()} and accept against it.`);
}
```

### 4. `src/services/agentPromptBuilder.ts` — custom-agent PRD block (line 1402)
```ts
// BEFORE (line 1402-1406)
if (addons?.prdContent) {
    prompt += `\n\nPROJECT REQUIREMENTS (PRD):\nThe following product requirements apply to the active project and must be respected throughout this work:\n\n${addons.prdContent}`;
} else if (addons?.prdLink) {
    prompt += `\n\nPROJECT REQUIREMENTS (PRD):\nThe following product requirements document applies to the active project and must be respected throughout this work:\n${addons.prdLink}`;
}

// AFTER
if (addons?.prdLink) {
    prompt += `\n\nPROJECT REQUIREMENTS (PRD):\nRead the following product requirements document and respect it throughout this work:\n${addons.prdLink}`;
}
```

### 5. `src/services/KanbanProvider.ts` — drop `prdContent` assignment at call sites (lines 3246, 3308)
Remove the `mergedAddons.prdContent` / `resolvedOptions.prdContent` assignments since content is no longer resolved. Keep `prdLink` assignments. The `if (prdLink || prdContent)` guards at 3244 and 3305 collapse to `if (prdLink)`.

### 6. `src/services/agentPromptBuilder.ts` — mark `prdContent` field deprecated (line 251) [Clarification]
Add a one-line comment on the `prdContent` interface field noting it is no longer populated (link-only). Do not remove the field — removal would touch `agentConfig.ts:41` and any fixtures for no functional gain.
```ts
/** Full content of the active project's PRD, embedded verbatim. [DEPRECATED — link-only as of PRD-link-only plan; no longer populated.] */
prdContent?: string;
```

## Verification Plan
1. **Manual**: Enable PROJECT CONTEXT on a project with a PRD. Dispatch a planner prompt for a plan in that project. Confirm the prompt contains only the PRD file **path** (e.g. `.switchboard/projects/<slug>/prd.md`), not the PRD body text.
2. **Manual**: Dispatch a tester prompt for the same plan. Confirm the acceptance-baseline block references the PRD by path, not inline content.
3. **Manual**: Dispatch via a custom agent role with project context on. Confirm the custom-agent prompt also uses the link-only form.
4. **Manual**: Disable PROJECT CONTEXT. Confirm no PRD block appears at all (existing gating unchanged).
5. **Automated Tests**: Run `npm test`. No test asserts on `prdContent` (verified), so the suite should pass unchanged. If a fixture happens to populate `prdContent` for setup purposes, it remains harmless (the field is still on the interface); only assertions on embedded content would need updating, and none exist.
