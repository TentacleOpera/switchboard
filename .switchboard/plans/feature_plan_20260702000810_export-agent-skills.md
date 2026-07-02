# Export Skills for Each Configured Agent

**Plan ID:** 7a3c1f2e-9b84-4d2a-a617-5e1f0c8b9d44

## Goal

Switchboard should export a skill file (`.agents/skills/switchboard-<key>.md`) for each configured agent — both built-in roles and custom agents — so that a remote web agent can faithfully recreate that agent's approach without being inside the VS Code extension. For example, if a Code Reviewer agent is active with review prompt add-ons, a skill like `/switchboard-reviewer` gets written to `.agents/skills/` containing all the active prompt add-ons and instructions, allowing a web-based agent (e.g. claude.ai) to follow the same review methodology.

### Problem Analysis & Root Cause

**Current state:** Agent configurations live entirely in VS Code extension state (`.switchboard/state.json` under the `agents.customAgents` key, and built-in roles are hardcoded in `agentConfig.ts`). The prompt that gets sent to a terminal-based agent is built at runtime by `agentPromptBuilder.ts`'s `buildCustomAgentPrompt()` function, which assembles the base role prompt + enabled add-on directives + prompt overrides into a single text blob. This prompt is never persisted to disk — it exists only ephemerally in the terminal session.

**The gap:** Remote agents (claude.ai, ChatGPT, etc.) have no way to access these prompts. They cannot read VS Code extension state, and there is no export mechanism that writes the assembled agent prompt to a skill file. The `.agents/skills/` directory contains only hand-written skills distributed with the plugin — none are generated from agent configurations. The `ClaudeCodeMirrorService` mirrors `.agents/skills/` to `.claude/skills/`, but it only mirrors pre-defined files in `MIRROR_MANIFEST`; it does not generate new skills from agent configs.

**Root cause:** There is no code path that converts a `CustomAgentConfig` (or built-in agent role + add-ons) into a standalone skill markdown file. The prompt assembly logic in `agentPromptBuilder.ts` is tightly coupled to the terminal-dispatch flow and was never designed to output to a file.

### Schema Mismatch (Critical Finding from Review)

Built-in role configs and custom agent configs use **different add-on field schemas**. Built-in role configs (loaded via `_getRoleConfig(role)`, stored under `switchboard.prompts.roleConfig_<role>`) use fields like `addons.advancedRegression`, `addons.reviewerConciseMode`, `addons.leadChallenge`, `addons.accurateCoding`, `addons.skipCompilation`. The `CustomAgentAddons` interface uses `advancedReviewerEnabled`, `reviewerConciseModeEnabled`, `includeInlineChallenge`, `accurateCodingEnabled`, etc. A naive pass-through of built-in addons into a `CustomAgentAddons`-shaped renderer produces an **empty add-on section**. The exporter MUST normalize built-in role addons into the `CustomAgentAddons` shape before rendering.

## Metadata
- **Tags:** backend, feature, agents, skills, remote-agents
- **Complexity:** 6

## User Review Required

- [ ] Confirm that custom-agent skill files should be keyed by `agent.id` (UUID, guaranteed unique) rather than `agent.role` (free-form string, not unique). Built-in agents remain keyed by enum role.
- [ ] Confirm that exported skills should reuse the real `*_DIRECTIVE` constants from `agentPromptBuilder.ts` (faithful recreation) rather than paraphrased one-liners.
- [ ] Confirm the dynamic mirror-scan approach for `ClaudeCodeMirrorService` (scan `.agents/skills/switchboard-*.md` at mirror time) is acceptable vs. deferring mirror integration to a follow-up.

## Complexity Audit

### Routine
- Generating markdown text from a structured config object (straightforward templating)
- Writing a file to `.agents/skills/` (standard `fs.writeFile`)
- Adding a button to the custom agents UI in `kanban.html`
- Wiring an IPC message handler in `KanbanProvider.ts`
- Adding import statements for `AgentSkillExporter`, `BUILT_IN_AGENT_LABELS`, `BuiltInAgentRole`, and directive constants

### Complex / Risky
- **Built-in addon schema translation** — Built-in role configs (`roleConfig_<role>.addons`) use a different field schema than `CustomAgentAddons` (e.g. `advancedRegression` vs `advancedReviewerEnabled`, `leadChallenge` vs `includeInlineChallenge`, `accurateCoding` vs `accurateCodingEnabled`). A `normalizeBuiltinAddons()` mapper is required; without it, built-in exports are hollow. This is the single most important risk.
- **Reusing directive constants for file output** — The existing `*_DIRECTIVE` constants (`GIT_PROHIBITION_DIRECTIVE`, `FOCUS_DIRECTIVE`, `NO_SUBAGENTS_DIRECTIVE`, `WORKTREES_PER_PLAN_DIRECTIVE`, `CAVEMAN_OUTPUT_DIRECTIVE`, `SUPPRESS_WALKTHROUGH_DIRECTIVE`) are designed for terminal dispatch. Reusing them verbatim in a skill file is desirable for fidelity but must be exported from `agentPromptBuilder.ts` (currently module-scoped consts; some are exported, some are not).
- **Stale skill cleanup** — When an agent config changes or an agent is deleted, the exported skill file should be updated/removed. The deletion path must capture the role BEFORE the state mutation (the current `handleDeleteCustomAgent` computes `deletedRole` inside the `updateState` callback where it is out of scope for a post-deletion cleanup call).
- **Mirror integration** — `MIRROR_MANIFEST` is a static `const` array; runtime-generated skills cannot be pushed into it. The mirror service must be extended to dynamically scan `.agents/skills/switchboard-*.md`.

## Edge-Case & Dependency Audit

- **Agent with no add-ons:** Should still export a skill with just the base role prompt and instructions.
- **Agent with `defaultPromptOverride`:** The override (prepend/append/replace) must be reflected in the exported skill.
- **Agent deleted after export:** The stale skill file remains in `.agents/skills/`. Cleanup must capture `deletedRole` before the `updateState` callback and call `removeExportedSkill` after.
- **Agent config modified after export:** Skill file becomes stale. Re-export on config save (auto-export hook in `handleSaveCustomAgent`).
- **Name collisions (custom vs custom):** Two custom agents sharing the same `role` string would collide. Mitigated by keying custom-agent files on `agent.id` (UUID). Built-in agents use the fixed `BuiltInAgentRole` enum (unique by definition).
- **Name collisions (custom vs built-in):** A custom agent whose `id` happens to equal a built-in role string is impossible (`agent.id` is a UUID; built-in roles are short enum strings). No collision.
- **Constitution/PRD/Design System doc add-ons:** These reference file paths (`constitutionLink`, `prdLink`, `designSystemDocLink`). A remote web agent cannot read local files. The skill embeds the content (if available in `constitutionContent`, `prdContent`, `designSystemDocContent`) or instructs the agent to ask the user to paste the content.
- **Per-project PRD references (`prdReferences`):** Array of `{ projectName, prdLink }`. The skill must list each project's PRD link and instruct the agent to ask the user to paste content per project.
- **`ticketUpdateMode` and `suppressWalkthrough`:** Real `CustomAgentAddons` fields that the renderer must handle (previously missed).
- **`.agents/skills/` directory may not exist** in a fresh workspace — `fs.promises.mkdir(skillsDir, { recursive: true })` handles this.
- **Dependencies:** `agentConfig.ts` (data model, `BUILT_IN_AGENT_LABELS`, `BuiltInAgentRole`, `CustomAgentConfig`, `CustomAgentAddons`), `agentPromptBuilder.ts` (directive constants, `buildCustomAgentPrompt` reference), `KanbanProvider.ts` (`_getRoleConfig`, IPC handler, `saveCustomAgent` handler at line 7723), `TaskViewerProvider.ts` (`handleSaveCustomAgent` at line 8124, `handleDeleteCustomAgent` at line 8142, `getRoleConfig`), `ClaudeCodeMirrorService.ts` (`MIRROR_MANIFEST` at line 41, mirror loop at line 283), `kanban.html` (`agentsTabRenderCustomAgentList` at line 3639, custom agents section at line 2806).

## Dependencies

_None — this plan is self-contained and does not depend on other in-progress plans._

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) built-in role addon schema mismatch producing empty exports — mitigated by a `normalizeBuiltinAddons()` mapper; (2) deletion cleanup referencing an out-of-scope variable — mitigated by capturing `deletedRole` before `updateState`; (3) custom-agent filename collisions on non-unique `role` strings — mitigated by keying on `agent.id`; (4) directive fidelity divergence — mitigated by reusing the real `*_DIRECTIVE` constants. The schema-translation layer is the one new moderate risk; all other changes are routine wiring against verified accessors (`_getRoleConfig`, `vscode.postMessage`, `getActiveWorkspaceRoot`).

## Proposed Changes

### 1. New service: `src/services/AgentSkillExporter.ts`

Create a new service that converts agent configurations into skill markdown files. Custom agents are keyed by `agent.id` (UUID); built-in agents are keyed by their `BuiltInAgentRole` enum value.

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { CustomAgentConfig, CustomAgentAddons, BuiltInAgentRole } from './agentConfig';
import {
    GIT_PROHIBITION_DIRECTIVE,
    FOCUS_DIRECTIVE,
    NO_SUBAGENTS_DIRECTIVE,
    WORKTREES_PER_PLAN_DIRECTIVE,
    CAVEMAN_OUTPUT_DIRECTIVE,
    SUPPRESS_WALKTHROUGH_DIRECTIVE
} from './agentPromptBuilder';

export class AgentSkillExporter {
    /**
     * Export a custom agent config as a skill file.
     * Writes to .agents/skills/switchboard-<agent.id>.md (keyed by UUID for uniqueness).
     */
    static async exportCustomAgent(
        agent: CustomAgentConfig,
        workspaceRoot: string
    ): Promise<{ success: boolean; skillPath?: string; error?: string }> {
        const skillsDir = path.join(workspaceRoot, '.agents', 'skills');
        await fs.promises.mkdir(skillsDir, { recursive: true });

        const skillFileName = `switchboard-${agent.id}.md`;
        const skillPath = path.join(skillsDir, skillFileName);
        const markdown = this.generateSkillMarkdown(agent.name, agent.role, agent.promptInstructions, agent.addons);

        await fs.promises.writeFile(skillPath, markdown, 'utf8');
        return { success: true, skillPath };
    }

    /**
     * Export a built-in agent role + add-ons as a skill file.
     * Writes to .agents/skills/switchboard-<role>.md (role is a fixed enum, unique).
     */
    static async exportBuiltinAgent(
        role: BuiltInAgentRole,
        label: string,
        roleConfig: { addons?: any; prompt?: string } | undefined,
        workspaceRoot: string
    ): Promise<{ success: boolean; skillPath?: string; error?: string }> {
        const skillsDir = path.join(workspaceRoot, '.agents', 'skills');
        await fs.promises.mkdir(skillsDir, { recursive: true });

        const skillFileName = `switchboard-${role}.md`;
        const skillPath = path.join(skillsDir, skillFileName);
        const normalizedAddons = this.normalizeBuiltinAddons(roleConfig?.addons, role);
        const markdown = this.generateSkillMarkdown(label, role, roleConfig?.prompt, normalizedAddons);

        await fs.promises.writeFile(skillPath, markdown, 'utf8');
        return { success: true, skillPath };
    }

    /**
     * Remove an exported skill file (called on agent deletion).
     * For custom agents, key is the agent id; for built-ins, key is the role.
     */
    static async removeExportedSkill(
        key: string,
        workspaceRoot: string
    ): Promise<void> {
        const skillPath = path.join(workspaceRoot, '.agents', 'skills', `switchboard-${key}.md`);
        try {
            await fs.promises.unlink(skillPath);
        } catch (e) {
            // File may not exist — ignore
        }
    }

    /**
     * Normalize built-in role config addons (roleConfig_<role>.addons) into the
     * CustomAgentAddons shape used by the renderer.
     *
     * Built-in schema -> CustomAgentAddons schema:
     *   advancedRegression       -> advancedReviewerEnabled
     *   reviewerConciseMode       -> reviewerConciseModeEnabled
     *   reviewerCompactPlanUpdate -> reviewerCompactPlanUpdateEnabled
     *   leadChallenge             -> includeInlineChallenge
     *   accurateCoding            -> accurateCodingEnabled
     *   pairProgramming           -> pairProgrammingEnabled
     *   aggressivePairProgramming -> aggressivePairProgramming
     *   constitution              -> (sets constitutionLink handling; content embedded if present)
     *   designSystemDoc           -> designSystemDoc
     *   skipCompilation           -> (no CustomAgentAddons equivalent; omitted — web agents don't compile)
     *   workflowFilePath          -> workflowFilePath (with workflowFilePathEnabled = true)
     *   adviseResearch            -> researchEnabled
     */
    private static normalizeBuiltinAddons(
        builtinAddons: any | undefined,
        role: BuiltInAgentRole
    ): CustomAgentAddons | undefined {
        if (!builtinAddons) return undefined;
        const out: CustomAgentAddons = {};
        if (builtinAddons.advancedRegression !== undefined) out.advancedReviewerEnabled = !!builtinAddons.advancedRegression;
        if (builtinAddons.reviewerConciseMode !== undefined) out.reviewerConciseModeEnabled = !!builtinAddons.reviewerConciseMode;
        if (builtinAddons.reviewerCompactPlanUpdate !== undefined) out.reviewerCompactPlanUpdateEnabled = !!builtinAddons.reviewerCompactPlanUpdate;
        if (builtinAddons.leadChallenge !== undefined) out.includeInlineChallenge = !!builtinAddons.leadChallenge;
        if (builtinAddons.accurateCoding !== undefined) out.accurateCodingEnabled = !!builtinAddons.accurateCoding;
        if (builtinAddons.pairProgramming !== undefined) out.pairProgrammingEnabled = !!builtinAddons.pairProgramming;
        if (builtinAddons.aggressivePairProgramming !== undefined) out.aggressivePairProgramming = !!builtinAddons.aggressivePairProgramming;
        if (builtinAddons.adviseResearch !== undefined) out.researchEnabled = !!builtinAddons.adviseResearch;
        if (builtinAddons.constitution !== undefined) {
            // constitution flag presence implies constitution content/link should be rendered
            // if the roleConfig carries constitutionLink/constitutionContent, copy them through
        }
        if (builtinAddons.designSystemDoc !== undefined) out.designSystemDoc = !!builtinAddons.designSystemDoc;
        if (builtinAddons.designSystemDocLink) out.designSystemDocLink = builtinAddons.designSystemDocLink;
        if (builtinAddons.designSystemDocContent) out.designSystemDocContent = builtinAddons.designSystemDocContent;
        if (builtinAddons.constitutionLink) out.constitutionLink = builtinAddons.constitutionLink;
        if (builtinAddons.constitutionContent) out.constitutionContent = builtinAddons.constitutionContent;
        if (builtinAddons.workflowFilePath) {
            out.workflowFilePathEnabled = true;
            out.workflowFilePath = builtinAddons.workflowFilePath;
        }
        // skipCompilation has no CustomAgentAddons equivalent — intentionally omitted.
        return out;
    }

    /**
     * Generate the skill markdown content from agent parameters.
     */
    private static generateSkillMarkdown(
        name: string,
        role: string,
        promptInstructions: string | undefined,
        addons: CustomAgentAddons | undefined
    ): string {
        const lines: string[] = [];

        // Frontmatter
        lines.push('---');
        lines.push(`name: Switchboard ${name}`);
        lines.push(`description: Recreate the Switchboard "${name}" agent approach. Use when acting as a ${name.toLowerCase()} on a Switchboard-managed project.`);
        lines.push('---');
        lines.push('');
        lines.push(`# Skill: Switchboard ${name}`);
        lines.push('');
        lines.push('## Overview');
        lines.push(`This skill recreates the behavior of the Switchboard **${name}** agent (role: \`${role}\`).`);
        lines.push('It includes all active prompt add-ons and instructions so a web-based agent can faithfully follow the same methodology as the VS Code extension agent.');
        lines.push('');

        // Prompt instructions
        if (promptInstructions?.trim()) {
            lines.push('## Prompt Instructions');
            lines.push('');
            lines.push(promptInstructions.trim());
            lines.push('');
        }

        // Add-ons
        if (addons) {
            lines.push('## Active Add-ons');
            lines.push('');
            this.appendAddonSection(lines, addons);
        }

        // Usage
        lines.push('## Usage');
        lines.push('');
        lines.push(`Invoke this skill when you need to act as a **${name}** on a Switchboard-managed project.`);
        lines.push('Follow all instructions and add-on directives above. If any referenced file content is not available, ask the user to paste it.');
        lines.push('');

        return lines.join('\n');
    }

    private static appendAddonSection(lines: string[], addons: CustomAgentAddons): void {
        if (addons.gitProhibitionEnabled) {
            lines.push('### Git Safety Guardrail');
            lines.push('```');
            lines.push(GIT_PROHIBITION_DIRECTIVE);
            lines.push('```');
            lines.push('');
        }
        if (addons.workspaceTypeDetection) {
            lines.push('### Workspace Type Detection');
            lines.push('- Detect the workspace type (monorepo, single-package, etc.) and adapt your approach accordingly.');
            lines.push('');
        }
        if (addons.switchboardSafeguards) {
            lines.push('### Switchboard Safeguards');
            lines.push('```');
            lines.push(FOCUS_DIRECTIVE);
            lines.push('```');
            lines.push('');
        }
        if (addons.includeInlineChallenge) {
            lines.push('### Inline Challenge');
            lines.push('- Proactively challenge assumptions and flag potential issues inline.');
            lines.push('');
        }
        if (addons.accurateCodingEnabled) {
            lines.push('### Accurate Coding');
            lines.push('- Follow the high-accuracy workflow: investigate, plan, implement, self-review.');
            lines.push('');
        }
        if (addons.pairProgrammingEnabled) {
            lines.push('### Pair Programming');
            lines.push('- Engage in pair programming mode: explain your reasoning step by step.');
            lines.push('');
        }
        if (addons.aggressivePairProgramming) {
            lines.push('### Aggressive Pair Programming');
            lines.push('- Be proactive and aggressive in suggesting changes and improvements.');
            lines.push('');
        }
        if (addons.advancedReviewerEnabled) {
            lines.push('### Advanced Reviewer');
            lines.push('- Apply advanced code review techniques: check for edge cases, security, performance, maintainability.');
            lines.push('');
        }
        if (addons.reviewerConciseModeEnabled) {
            lines.push('### Reviewer Concise Mode');
            lines.push('- Keep review output concise and focused on actionable findings.');
            lines.push('');
        }
        if (addons.reviewerCompactPlanUpdateEnabled) {
            lines.push('### Reviewer Compact Plan Update');
            lines.push('- When updating plans, use compact format.');
            lines.push('');
        }
        if (addons.researchEnabled) {
            lines.push('### Research Enabled');
            lines.push('- Perform web research when needed to validate assumptions.');
            lines.push('');
        }
        if (addons.complexityScoringSkill) {
            lines.push('### Complexity Scoring');
            lines.push('- Assess and assign numeric complexity scores (1-10) to plans and tasks.');
            lines.push('');
        }
        if (addons.cavemanOutput) {
            lines.push('### Caveman Output');
            lines.push('```');
            lines.push(CAVEMAN_OUTPUT_DIRECTIVE);
            lines.push('```');
            lines.push('');
        }
        if (addons.suppressWalkthrough) {
            lines.push('### Suppress Walkthrough');
            lines.push('```');
            lines.push(SUPPRESS_WALKTHROUGH_DIRECTIVE);
            lines.push('```');
            lines.push('');
        }
        if (addons.ticketUpdateMode && addons.ticketUpdateMode !== 'disabled') {
            lines.push('### Ticket Update Mode');
            lines.push(`- Ticket update behavior: ${addons.ticketUpdateMode}.`);
            lines.push('');
        }
        if (addons.useSubagents) {
            lines.push('### Subagent Usage');
            lines.push('```');
            lines.push(NO_SUBAGENTS_DIRECTIVE); // NOTE: only emit when policy is noSubagents; see branch below
            lines.push('```');
            lines.push(`- Policy: ${addons.subagentPolicy || 'default'}.`);
            if (addons.customSubagentName) {
                lines.push(`- Custom subagent: ${addons.customSubagentName}`);
            }
            lines.push('');
        }
        if (addons.useWorktreesPerPlan) {
            lines.push('### Worktrees Per Plan');
            lines.push('```');
            lines.push(WORKTREES_PER_PLAN_DIRECTIVE);
            lines.push('```');
            lines.push('');
        }
        if (addons.designSystemDoc) {
            lines.push('### Design System Document');
            if (addons.designSystemDocContent) {
                lines.push('**Content:**');
                lines.push('```');
                lines.push(addons.designSystemDocContent);
                lines.push('```');
            } else if (addons.designSystemDocLink) {
                lines.push(`Reference: ${addons.designSystemDocLink}`);
                lines.push('(Ask the user to paste this content if you cannot access the file.)');
            }
            lines.push('');
        }
        if (addons.constitutionContent) {
            lines.push('### Constitution');
            lines.push('**Content:**');
            lines.push('```');
            lines.push(addons.constitutionContent);
            lines.push('```');
            lines.push('');
        } else if (addons.constitutionLink) {
            lines.push('### Constitution');
            lines.push(`Reference: ${addons.constitutionLink}`);
            lines.push('(Ask the user to paste this content if you cannot access the file.)');
            lines.push('');
        }
        if (addons.prdContent) {
            lines.push('### PRD');
            lines.push('**Content:**');
            lines.push('```');
            lines.push(addons.prdContent);
            lines.push('```');
            lines.push('');
        } else if (addons.prdLink) {
            lines.push('### PRD');
            lines.push(`Reference: ${addons.prdLink}`);
            lines.push('(Ask the user to paste this content if you cannot access the file.)');
            lines.push('');
        }
        if (addons.prdReferences && addons.prdReferences.length > 0) {
            lines.push('### Per-Project PRD References');
            for (const ref of addons.prdReferences) {
                lines.push(`- **${ref.projectName}**: ${ref.prdLink}`);
            }
            lines.push('(Ask the user to paste the relevant PRD content if you cannot access a file.)');
            lines.push('');
        }
        if (addons.workflowFilePathEnabled && addons.workflowFilePath) {
            lines.push('### Workflow File');
            lines.push(`Follow the workflow defined in: ${addons.workflowFilePath}`);
            lines.push('(Ask the user to paste this content if you cannot access the file.)');
            lines.push('');
        }
        if (addons.applyEpicDirectives) {
            lines.push('### Epic Directives');
            lines.push('- Apply epic-level directives when working on plans that belong to an epic.');
            lines.push('');
        }
        if (addons.defaultPromptOverride) {
            lines.push('### Prompt Override');
            lines.push(`Mode: ${addons.defaultPromptOverride.mode}`);
            lines.push('');
            lines.push(addons.defaultPromptOverride.text);
            lines.push('');
        }
    }
}
```

**Implementation note — directive exports:** `GIT_PROHIBITION_DIRECTIVE`, `FOCUS_DIRECTIVE`, `NO_SUBAGENTS_DIRECTIVE`, `WORKTREES_PER_PLAN_DIRECTIVE`, `CAVEMAN_OUTPUT_DIRECTIVE`, and `SUPPRESS_WALKTHROUGH_DIRECTIVE` must be exported from `agentPromptBuilder.ts`. `CAVEMAN_OUTPUT_DIRECTIVE` and `SUPPRESS_WALKTHROUGH_DIRECTIVE` are already exported (imported in `KanbanProvider.ts` line 21). The others (`GIT_PROHIBITION_DIRECTIVE`, `FOCUS_DIRECTIVE`, `NO_SUBAGENTS_DIRECTIVE`, `WORKTREES_PER_PLAN_DIRECTIVE`) must be added to the export list of their `const` declarations. The subagent branch above must be refined at implementation time: only emit `NO_SUBAGENTS_DIRECTIVE` when `subagentPolicy === 'noSubagents'`; otherwise emit the appropriate parallel-dispatch instruction (mirror the logic in `buildCustomAgentPrompt` lines 1336–1351).

### 2. Export directive constants from `src/services/agentPromptBuilder.ts`

**File:** `src/services/agentPromptBuilder.ts`

Add `export` to the `const` declarations for `GIT_PROHIBITION_DIRECTIVE`, `FOCUS_DIRECTIVE`, `NO_SUBAGENTS_DIRECTIVE`, and `WORKTREES_PER_PLAN_DIRECTIVE` (if not already exported). `CAVEMAN_OUTPUT_DIRECTIVE` and `SUPPRESS_WALKTHROUGH_DIRECTIVE` are already exported. This is a non-breaking change (adding `export` to an existing module-scoped const).

### 3. Add "Export as Skill" button to custom agent UI

**File:** `src/webview/kanban.html` (in `agentsTabRenderCustomAgentList`, line 3639)

Add an "Export as Skill" button next to each custom agent in the rendered list, matching the existing inline-listener pattern used by EDIT/DELETE. In the `item.innerHTML` template (line 3651–3654), add a third button:

```html
<div class="agents-tab-custom-agent-item-actions">
    <button class="agents-tab-custom-agent-item-btn edit" data-id="${agent.id}">EDIT</button>
    <button class="agents-tab-custom-agent-item-btn export-skill" data-id="${agent.id}">EXPORT SKILL</button>
    <button class="agents-tab-custom-agent-item-btn delete" data-id="${agent.id}">DELETE</button>
</div>
```

Attach the listener inline (alongside the existing `.edit` and `.delete` listeners, lines 3657–3669):

```javascript
item.querySelector('.export-skill').addEventListener('click', () => {
    vscode.postMessage({ type: 'exportAgentAsSkill', agentId: agent.id, workspaceRoot: getActiveWorkspaceRoot() });
    const btn = item.querySelector('.export-skill');
    const orig = btn.textContent;
    btn.textContent = 'Exported!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
});
```

Note: uses `vscode.postMessage` and `getActiveWorkspaceRoot()` — the actual messaging API used throughout `kanban.html` (see line 3668). Do NOT use a `postKanbanMessage` helper or a bare `workspaceRoot` variable.

### 4. Add "Export as Skill" button for built-in agents

**File:** `src/webview/kanban.html` (PROMPTS tab, in each built-in role configuration header)

The built-in role configuration UI lives in the PROMPTS tab (not the Custom Agents subsection at line 2806). Add an "Export as Skill" button in each built-in role's configuration block. The button sends the role identifier so the backend can load the roleConfig via `_getRoleConfig(role)`:

```javascript
vscode.postMessage({ type: 'exportAgentAsSkill', role: 'reviewer', workspaceRoot: getActiveWorkspaceRoot() });
```

Repeat for each built-in role (`planner`, `lead`, `coder`, `reviewer`, `tester`, `intern`, `analyst`, `ticket_updater`, `researcher`). The exact insertion point is the role header element in the PROMPTS tab; the implementer should locate the role-header render function and append the button alongside any existing per-role controls.

### 5. Add IPC handler in `KanbanProvider.ts`

**File:** `src/services/KanbanProvider.ts` (near line 7723, alongside the `saveCustomAgent` handler)

**Imports to add** (line 11–19 import block from `./agentConfig`):
```typescript
BUILT_IN_AGENT_LABELS,
BuiltInAgentRole,
```
And add a new import:
```typescript
import { AgentSkillExporter } from './AgentSkillExporter';
```

**Handler:**
```typescript
case 'exportAgentAsSkill': {
    const agentId = msg.agentId;
    const role = msg.role; // for built-in agents
    const workspaceRoot = msg.workspaceRoot;

    try {
        if (agentId) {
            // Custom agent — key by agent.id (UUID)
            const customAgents = await this._getCustomAgents(workspaceRoot);
            const agent = customAgents.find(a => a.id === agentId);
            if (!agent) {
                this._panel?.webview.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: 'Agent not found' });
                break;
            }
            const result = await AgentSkillExporter.exportCustomAgent(agent, workspaceRoot);
            this._panel?.webview.postMessage({ type: 'exportAgentAsSkillResult', ...result });
        } else if (role) {
            // Built-in agent — load roleConfig via the existing _getRoleConfig accessor
            const roleConfig: any = this._getRoleConfig(role);
            const label = BUILT_IN_AGENT_LABELS[role as BuiltInAgentRole] || role;
            const result = await AgentSkillExporter.exportBuiltinAgent(role as BuiltInAgentRole, label, roleConfig, workspaceRoot);
            this._panel?.webview.postMessage({ type: 'exportAgentAsSkillResult', ...result });
        } else {
            this._panel?.webview.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: 'Missing agentId or role' });
        }
    } catch (e) {
        this._panel?.webview.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: String(e) });
    }
    break;
}
```

Note: uses `this._getCustomAgents(workspaceRoot)` (the actual async accessor at line 4327) and `this._getRoleConfig(role)` (the actual accessor at line 465). The plan's original `getBuiltinAgentAddons` / `getBuiltinAgentPromptInstructions` methods do NOT exist and must not be used. Uses `this._panel?.webview` (the actual webview reference used by the `saveCustomAgent` handler at line 7726), not `this._kanbanWebview`.

### 6. Add cleanup on agent deletion (restructured)

**File:** `src/services/TaskViewerProvider.ts` (`handleDeleteCustomAgent`, line 8142)

The current implementation computes `deletedRole` INSIDE the `updateState` callback (line 8149), where it is out of scope for a post-deletion cleanup call. Restructure to capture the role BEFORE the state mutation, then remove the exported skill AFTER:

```typescript
public async handleDeleteCustomAgent(agentId: string, workspaceRoot?: string): Promise<void> {
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedRoot) {
        return;
    }
    // Capture the role BEFORE the state mutation so it is available for cleanup.
    const existing = parseCustomAgents(await this.getStateAsync() as any);
    const deletedAgent = existing.find((a: CustomAgentConfig) => a.id === agentId);
    const deletedKey = deletedAgent?.id; // custom-agent skill files are keyed by agent.id

    await this.updateState((state: any) => {
        const current = parseCustomAgents(state.customAgents);
        const deletedRole = current.find((a: CustomAgentConfig) => a.id === agentId)?.role;
        state.customAgents = current.filter((a: CustomAgentConfig) => a.id !== agentId);
        if (deletedRole) {
            if (state.visibleAgents) {
                delete state.visibleAgents[deletedRole];
            }
            if (state.startupCommands) {
                delete state.startupCommands[deletedRole];
            }
        }
    });
    this._kanbanProvider?.sendVisibleAgents();
    await Promise.all([
        this._postSidebarConfigurationState(resolvedRoot),
        this.postSetupPanelState(resolvedRoot)
    ]);

    // Remove the exported skill file (keyed by agent.id). Best-effort — ignore if missing.
    if (deletedKey) {
        try {
            const { AgentSkillExporter } = await import('./AgentSkillExporter');
            await AgentSkillExporter.removeExportedSkill(deletedKey, resolvedRoot);
        } catch (e) {
            // Skill file may not exist — ignore.
        }
    }
}
```

**Implementation note:** `getStateAsync` should be replaced with whatever the existing codebase uses to read state outside `updateState` (the implementer should verify the exact async state-read accessor; if none exists, capture `deletedAgent` by reading `parseCustomAgents` on the state obtained via the existing state-bridge). The dynamic `import('./AgentSkillExporter')` avoids a circular-import risk; if no cycle exists, a top-level import is preferred.

### 7. Auto-export on agent save

**File:** `src/services/TaskViewerProvider.ts` (`handleSaveCustomAgent`, line 8124)

After saving an agent config, automatically re-export the skill so it stays in sync. `handleSaveCustomAgent` receives the full `agent` object, so the hook is straightforward:

```typescript
public async handleSaveCustomAgent(agent: CustomAgentConfig, workspaceRoot?: string): Promise<void> {
    const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
    if (!resolvedRoot) {
        return;
    }
    await this.updateState((state: any) => {
        const existing = parseCustomAgents(state.customAgents);
        const filtered = existing.filter((a: CustomAgentConfig) => a.id !== agent.id);
        filtered.push(agent);
        state.customAgents = filtered;
    });
    this._kanbanProvider?.sendVisibleAgents();
    await Promise.all([
        this._postSidebarConfigurationState(resolvedRoot),
        this.postSetupPanelState(resolvedRoot)
    ]);

    // Auto-export so the skill file stays in sync with the config.
    try {
        const { AgentSkillExporter } = await import('./AgentSkillExporter');
        await AgentSkillExporter.exportCustomAgent(agent, resolvedRoot);
    } catch (e) {
        // Non-fatal — export is a convenience, not a correctness requirement.
    }
}
```

### 8. Dynamic mirror integration for generated skills

**File:** `src/services/ClaudeCodeMirrorService.ts` (mirror loop, line 283)

`MIRROR_MANIFEST` is a static `const` and cannot hold runtime-generated entries. Extend the mirror routine to dynamically scan `.agents/skills/` for `switchboard-*.md` files and mirror them alongside the manifest entries:

```typescript
// After the existing MIRROR_MANIFEST loop, scan for generated agent skills.
const skillsDir = path.join(workspaceRoot, '.agents', 'skills');
try {
    const entries = await fs.promises.readdir(skillsDir);
    for (const entry of entries) {
        if (entry.startsWith('switchboard-') && entry.endsWith('.md')) {
            const name = entry.replace(/^switchboard-/, '').replace(/\.md$/, '');
            // Mirror as a user-invokable, no-model-invocation skill (role-recreation skills
            // are explicitly invoked, not auto-loaded by description).
            await mirrorSkillFile(skillsDir, entry, `switchboard-${name}`, 'no-model', undefined, workspaceRoot);
        }
    }
} catch (e) {
    // .agents/skills/ may not exist — ignore.
}
```

**Implementation note:** `mirrorSkillFile` should be the same helper used by the existing `MIRROR_MANIFEST` loop (extract it if it is currently inlined). The `source` path is `skills/${entry}` (relative to `.agents/`). This is non-breaking — generated skills simply become available as `/switchboard-<name>` slash commands in Claude Code.

## Verification Plan

> **Session constraints:** No compilation (`tsc`/webpack) and no automated tests will be run as part of this verification. The test suite is run separately by the user. Verification below is manual/inspection-based.

### Automated Tests
- _(Skipped per session directive — the user runs the test suite separately.)_

### Manual Verification (inspection + behavior)
1. **Custom agent export:** Create a custom agent with several add-ons enabled → click "EXPORT SKILL" → verify `.agents/skills/switchboard-<agent.id>.md` is created with correct frontmatter, all enabled add-ons documented with the real directive constants, and prompt instructions included.
2. **Built-in agent export (schema translation):** Configure a built-in reviewer with `advancedRegression` + `reviewerConciseMode` enabled in the PROMPTS tab → click "Export as Skill" → verify the skill file contains the Advanced Reviewer and Reviewer Concise Mode sections (proving `normalizeBuiltinAddons` translated the schema correctly — this is the critical regression check).
3. **Agent deletion cleanup:** Export a skill for a custom agent → delete the agent → verify `switchboard-<agent.id>.md` is removed from `.agents/skills/` (proving the restructured cleanup captured the key before the state mutation).
4. **Agent config update (auto-export):** Export a skill → modify the agent's add-ons → save → verify the skill file is updated with the new add-ons (proving the `handleSaveCustomAgent` hook fires).
5. **Name collision (custom vs custom):** Create two custom agents with the same `role` string → export both → verify two distinct files (`switchboard-<id1>.md`, `switchboard-<id2>.md`) exist and neither overwrites the other (proving the `agent.id` keying).
6. **Missing `.agents/skills/` dir:** Delete the `.agents/skills/` directory → export an agent → verify the directory is recreated and the skill file is written.
7. **Constitution/PRD content embedding:** Configure an agent with constitution content → export → verify the constitution content is embedded in the skill markdown (not just a file path reference).
8. **Per-project PRD references:** Configure an agent with `prdReferences` → export → verify each project's PRD link is listed.
9. **Directive fidelity:** Export an agent with `gitProhibitionEnabled` → verify the skill contains the actual `GIT_PROHIBITION_DIRECTIVE` text (not a paraphrased one-liner).
10. **Mirror integration:** Export a skill → trigger a Claude Code mirror → verify `.claude/skills/switchboard-<name>/` is created from the dynamic scan.
11. **Remote agent usability:** Copy the exported skill content into a claude.ai session → ask it to perform a code review → verify it follows the add-on directives (e.g. concise mode, advanced reviewer techniques).

## Recommendation

Complexity is 6 → **Send to Coder**.
