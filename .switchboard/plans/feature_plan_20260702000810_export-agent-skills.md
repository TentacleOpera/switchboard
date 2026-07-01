# Export Skills for Each Configured Agent

## Goal

Switchboard should export a skill file (`.agents/skills/<agent-id>.md`) for each configured agent — both built-in roles and custom agents — so that a remote web agent can faithfully recreate that agent's approach without being inside the VS Code extension. For example, if a Code Reviewer agent is active with review prompt add-ons, a skill like `/switchboard-reviewer` gets written to `.agents/skills/` containing all the active prompt add-ons and instructions, allowing a web-based agent (e.g. claude.ai) to follow the same review methodology.

### Problem Analysis & Root Cause

**Current state:** Agent configurations live entirely in VS Code extension state (`.switchboard/state.json` under the `agents.customAgents` key, and built-in roles are hardcoded in `agentConfig.ts`). The prompt that gets sent to a terminal-based agent is built at runtime by `agentPromptBuilder.ts`'s `buildCustomAgentPrompt()` function, which assembles the base role prompt + enabled add-on directives + prompt overrides into a single text blob. This prompt is never persisted to disk — it exists only ephemerally in the terminal session.

**The gap:** Remote agents (claude.ai, ChatGPT, etc.) have no way to access these prompts. They cannot read VS Code extension state, and there is no export mechanism that writes the assembled agent prompt to a skill file. The `.agents/skills/` directory contains only hand-written skills distributed with the plugin — none are generated from agent configurations. The `ClaudeCodeMirrorService` mirrors `.agents/skills/` to `.claude/skills/`, but it only mirrors pre-defined files in `MIRROR_MANIFEST`; it does not generate new skills from agent configs.

**Root cause:** There is no code path that converts a `CustomAgentConfig` (or built-in agent role + add-ons) into a standalone skill markdown file. The prompt assembly logic in `agentPromptBuilder.ts` is tightly coupled to the terminal-dispatch flow and was never designed to output to a file.

## Metadata
- **Tags:** backend, feature, agents, skills, remote-agents
- **Complexity:** 6

## Complexity Audit

### Routine
- Generating markdown text from a structured config object (straightforward templating)
- Writing a file to `.agents/skills/` (standard `fs.writeFile`)
- Adding a button to the custom agents UI in `kanban.html`
- Wiring an IPC message handler in `KanbanProvider.ts`

### Complex / Risky
- **Reusing `buildCustomAgentPrompt()` logic for file output** — The existing function is designed for terminal dispatch, not file generation. It may include terminal-specific directives (e.g. `sendRobustText` pacing, CLI startup commands) that are irrelevant to a web agent. Need to either refactor to extract the pure prompt-building logic, or create a parallel function that produces a web-agent-friendly version.
- **Built-in agent export** — Built-in roles (lead, coder, reviewer, etc.) don't have a `CustomAgentConfig` object; their prompts are assembled from `BUILT_IN_AGENT_LABELS` + add-on state stored separately. Need to handle both custom and built-in agents.
- **Skill file format compliance** — Generated skills should follow the same format as existing skills (frontmatter with `name`, `description`, optional `allowed-tools`) so they integrate with the Claude Code mirror system.
- **Stale skill cleanup** — When an agent config changes or an agent is deleted, the exported skill file should be updated/removed. Need a lifecycle hook.
- **Mirror integration** — Exported skills should optionally be added to `MIRROR_MANIFEST` so they get mirrored to `.claude/skills/` automatically.

## Edge-Case & Dependency Audit

- **Agent with no add-ons:** Should still export a skill with just the base role prompt and instructions.
- **Agent with `defaultPromptOverride`:** The override (prepend/append/replace) must be reflected in the exported skill.
- **Agent deleted after export:** The stale skill file remains in `.agents/skills/`. Need cleanup logic on agent deletion.
- **Agent config modified after export:** Skill file becomes stale. Need re-export on config save (or at least a manual re-export button).
- **Name collisions:** A custom agent named "reviewer" would collide with any existing skill. Need to namespace as `switchboard-<agent-id>` or `switchboard-<role>`.
- **Constitution/PRD/Design System doc add-ons:** These reference file paths (`constitutionLink`, `prdLink`, `designSystemDocLink`). A remote web agent cannot read local files. The skill should either embed the content (if available in `constitutionContent`, `prdContent`, `designSystemDocContent`) or instruct the agent to ask the user to paste the content.
- **`.agents/skills/` directory may not exist** in a fresh workspace — need to create it if missing.
- **Dependencies:** `agentConfig.ts` (data model), `agentPromptBuilder.ts` (prompt assembly logic), `ClaudeCodeMirrorService.ts` (optional mirror integration).

## Proposed Changes

### 1. New service: `src/services/AgentSkillExporter.ts`

Create a new service that converts agent configurations into skill markdown files.

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { CustomAgentConfig, CustomAgentAddons, BuiltInAgentRole } from './agentConfig';

export class AgentSkillExporter {
    /**
     * Export a custom agent config as a skill file.
     * Writes to .agents/skills/switchboard-<agent-id>.md
     */
    static async exportCustomAgent(
        agent: CustomAgentConfig,
        workspaceRoot: string
    ): Promise<{ success: boolean; skillPath?: string; error?: string }> {
        const skillsDir = path.join(workspaceRoot, '.agents', 'skills');
        await fs.promises.mkdir(skillsDir, { recursive: true });
        
        const skillFileName = `switchboard-${agent.role}.md`;
        const skillPath = path.join(skillsDir, skillFileName);
        const markdown = this.generateSkillMarkdown(agent.name, agent.role, agent.promptInstructions, agent.addons);
        
        await fs.promises.writeFile(skillPath, markdown, 'utf8');
        return { success: true, skillPath };
    }

    /**
     * Export a built-in agent role + add-ons as a skill file.
     */
    static async exportBuiltinAgent(
        role: BuiltInAgentRole,
        label: string,
        addons: CustomAgentAddons | undefined,
        promptInstructions: string | undefined,
        workspaceRoot: string
    ): Promise<{ success: boolean; skillPath?: string; error?: string }> {
        const skillsDir = path.join(workspaceRoot, '.agents', 'skills');
        await fs.promises.mkdir(skillsDir, { recursive: true });
        
        const skillFileName = `switchboard-${role}.md`;
        const skillPath = path.join(skillsDir, skillFileName);
        const markdown = this.generateSkillMarkdown(label, role, promptInstructions, addons);
        
        await fs.promises.writeFile(skillPath, markdown, 'utf8');
        return { success: true, skillPath };
    }

    /**
     * Remove an exported skill file (called on agent deletion).
     */
    static async removeExportedSkill(
        role: string,
        workspaceRoot: string
    ): Promise<void> {
        const skillPath = path.join(workspaceRoot, '.agents', 'skills', `switchboard-${role}.md`);
        try {
            await fs.promises.unlink(skillPath);
        } catch (e) {
            // File may not exist — ignore
        }
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
            lines.push('- Do NOT perform git commit, push, branch operations. Focus on code changes only.');
            lines.push('');
        }
        if (addons.workspaceTypeDetection) {
            lines.push('### Workspace Type Detection');
            lines.push('- Detect the workspace type (monorepo, single-package, etc.) and adapt your approach accordingly.');
            lines.push('');
        }
        if (addons.switchboardSafeguards) {
            lines.push('### Switchboard Safeguards');
            lines.push('- Execute in focused batches. Do not attempt all changes at once.');
            lines.push('- Stay focused on the current task; do not scope-creep.');
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
            lines.push('- Use terse, abbreviated output style.');
            lines.push('');
        }
        if (addons.useSubagents) {
            lines.push('### Subagent Usage');
            lines.push(`- Use subagents for parallelizable tasks. Policy: ${addons.subagentPolicy || 'default'}.`);
            if (addons.customSubagentName) {
                lines.push(`- Custom subagent: ${addons.customSubagentName}`);
            }
            lines.push('');
        }
        if (addons.useWorktreesPerPlan) {
            lines.push('### Worktrees Per Plan');
            lines.push('- Use git worktrees for each plan to isolate changes.');
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

### 2. Add "Export as Skill" button to custom agent UI

**File:** `src/webview/kanban.html` (in the custom agent list rendering, ~line 3540-3683)

Add an "Export as Skill" button next to each custom agent in the rendered list. In the `agentsTabRenderCustomAgentList` function, add:

```html
<button class="agent-export-skill-btn strip-btn" data-agent-id="${agent.id}" data-agent-role="${agent.role}">Export as Skill</button>
```

Add event listener in the same area:
```javascript
document.querySelectorAll('.agent-export-skill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const agentId = btn.dataset.agentId;
        postKanbanMessage({ type: 'exportAgentAsSkill', agentId, workspaceRoot });
        btn.textContent = 'Exported!';
        setTimeout(() => { btn.textContent = 'Export as Skill'; }, 2000);
    });
});
```

### 3. Add export handler for built-in agents

**File:** `src/webview/kanban.html` (in the agent configuration section, ~line 2806-2831)

Add an "Export as Skill" button next to each built-in role configuration. When clicked, it sends the current add-on state for that role to the backend.

### 4. Add IPC handler in KanbanProvider.ts

**File:** `src/services/KanbanProvider.ts` (near line 7642-7653, alongside `saveCustomAgent` handler)

```typescript
case 'exportAgentAsSkill': {
    const agentId = msg.agentId;
    const workspaceRoot = msg.workspaceRoot;
    const role = msg.role; // for built-in agents
    
    try {
        if (agentId) {
            // Custom agent
            const customAgents = this.getCustomAgents(workspaceRoot);
            const agent = customAgents.find(a => a.id === agentId);
            if (!agent) {
                this._kanbanWebview?.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: 'Agent not found' });
                break;
            }
            const result = await AgentSkillExporter.exportCustomAgent(agent, workspaceRoot);
            this._kanbanWebview?.postMessage({ type: 'exportAgentAsSkillResult', ...result });
        } else if (role) {
            // Built-in agent
            const addons = this.getBuiltinAgentAddons(role, workspaceRoot);
            const promptInstructions = this.getBuiltinAgentPromptInstructions(role, workspaceRoot);
            const label = BUILT_IN_AGENT_LABELS[role as BuiltInAgentRole] || role;
            const result = await AgentSkillExporter.exportBuiltinAgent(role, label, addons, promptInstructions, workspaceRoot);
            this._kanbanWebview?.postMessage({ type: 'exportAgentAsSkillResult', ...result });
        }
    } catch (e) {
        this._kanbanWebview?.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: String(e) });
    }
    break;
}
```

### 5. Add cleanup on agent deletion

**File:** `src/services/TaskViewerProvider.ts` (in `handleDeleteCustomAgent()`, ~line 8105-8128)

After deleting the agent config, also remove the exported skill:
```typescript
await AgentSkillExporter.removeExportedSkill(agent.role, workspaceRoot);
```

### 6. Optional: Auto-export on agent save

**File:** `src/services/TaskViewerProvider.ts` (in `handleSaveCustomAgent()`, ~line 8087-8103)

After saving an agent config, automatically re-export the skill so it stays in sync:
```typescript
await AgentSkillExporter.exportCustomAgent(savedAgent, workspaceRoot);
```

## Verification Plan

1. **Custom agent export:** Create a custom agent with several add-ons enabled → click "Export as Skill" → verify `.agents/skills/switchboard-<role>.md` is created with correct frontmatter, all enabled add-ons documented, and prompt instructions included.
2. **Built-in agent export:** Configure a built-in reviewer with advanced reviewer + concise mode add-ons → click "Export as Skill" → verify the skill file contains those add-on directives.
3. **Agent deletion cleanup:** Export a skill for an agent → delete the agent → verify the skill file is removed from `.agents/skills/`.
4. **Agent config update:** Export a skill → modify the agent's add-ons → re-export → verify the skill file is updated with the new add-ons.
5. **Name collision:** Create a custom agent with role "reviewer" → verify the file is named `switchboard-reviewer.md` (namespaced) and does not overwrite any existing skill.
6. **Missing `.agents/skills/` dir:** Delete the `.agents/skills/` directory → export an agent → verify the directory is recreated and the skill file is written.
7. **Constitution/PRD content embedding:** Configure an agent with constitution content → export → verify the constitution content is embedded in the skill markdown (not just a file path reference).
8. **Remote agent usability:** Copy the exported skill content into a claude.ai session → ask it to perform a code review → verify it follows the add-on directives (e.g. concise mode, advanced reviewer techniques).
