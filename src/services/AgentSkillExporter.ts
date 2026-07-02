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
        try {
            const skillsDir = path.join(workspaceRoot, '.agents', 'skills');
            await fs.promises.mkdir(skillsDir, { recursive: true });

            const skillFileName = `switchboard-${agent.id}.md`;
            const skillPath = path.join(skillsDir, skillFileName);
            const markdown = this.generateSkillMarkdown(agent.name, agent.role, agent.promptInstructions, agent.addons);

            await fs.promises.writeFile(skillPath, markdown, 'utf8');
            return { success: true, skillPath };
        } catch (e: any) {
            return { success: false, error: e.message || String(e) };
        }
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
        try {
            const skillsDir = path.join(workspaceRoot, '.agents', 'skills');
            await fs.promises.mkdir(skillsDir, { recursive: true });

            const skillFileName = `switchboard-${role}.md`;
            const skillPath = path.join(skillsDir, skillFileName);
            const normalizedAddons = this.normalizeBuiltinAddons(roleConfig?.addons, role);
            const markdown = this.generateSkillMarkdown(label, role, roleConfig?.prompt, normalizedAddons);

            await fs.promises.writeFile(skillPath, markdown, 'utf8');
            return { success: true, skillPath };
        } catch (e: any) {
            return { success: false, error: e.message || String(e) };
        }
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
     */
    private static normalizeBuiltinAddons(
        builtinAddons: any | undefined,
        role: BuiltInAgentRole
    ): CustomAgentAddons | undefined {
        if (!builtinAddons) return undefined;
        const out: CustomAgentAddons = {};
        // Fields with DIFFERENT names between built-in and CustomAgentAddons schemas
        if (builtinAddons.advancedRegression !== undefined) out.advancedReviewerEnabled = !!builtinAddons.advancedRegression;
        if (builtinAddons.reviewerConciseMode !== undefined) out.reviewerConciseModeEnabled = !!builtinAddons.reviewerConciseMode;
        if (builtinAddons.reviewerCompactPlanUpdate !== undefined) out.reviewerCompactPlanUpdateEnabled = !!builtinAddons.reviewerCompactPlanUpdate;
        if (builtinAddons.leadChallenge !== undefined) out.includeInlineChallenge = !!builtinAddons.leadChallenge;
        if (builtinAddons.accurateCoding !== undefined) out.accurateCodingEnabled = !!builtinAddons.accurateCoding;
        if (builtinAddons.pairProgramming !== undefined) out.pairProgrammingEnabled = !!builtinAddons.pairProgramming;
        if (builtinAddons.aggressivePairProgramming !== undefined) out.aggressivePairProgramming = !!builtinAddons.aggressivePairProgramming;
        if (builtinAddons.adviseResearch !== undefined) out.researchEnabled = !!builtinAddons.adviseResearch;
        if (builtinAddons.gitProhibition !== undefined) out.gitProhibitionEnabled = !!builtinAddons.gitProhibition;
        // Fields with SAME name in both schemas — pass through directly
        if (builtinAddons.switchboardSafeguards !== undefined) out.switchboardSafeguards = !!builtinAddons.switchboardSafeguards;
        if (builtinAddons.cavemanOutput !== undefined) out.cavemanOutput = !!builtinAddons.cavemanOutput;
        if (builtinAddons.suppressWalkthrough !== undefined) out.suppressWalkthrough = !!builtinAddons.suppressWalkthrough;
        if (builtinAddons.useWorktreesPerPlan !== undefined) out.useWorktreesPerPlan = !!builtinAddons.useWorktreesPerPlan;
        if (builtinAddons.ticketUpdateMode !== undefined) out.ticketUpdateMode = builtinAddons.ticketUpdateMode;
        if (builtinAddons.researchEnabled !== undefined) out.researchEnabled = !!builtinAddons.researchEnabled;
        if (builtinAddons.subagentPolicy !== undefined) {
            out.subagentPolicy = builtinAddons.subagentPolicy;
            // Derive useSubagents boolean so the renderer's gate condition fires
            if (builtinAddons.subagentPolicy === 'useSubagents' || builtinAddons.subagentPolicy === 'customSubagent') {
                out.useSubagents = true;
            }
        }
        if (builtinAddons.customSubagentName !== undefined) out.customSubagentName = builtinAddons.customSubagentName;
        // Design system doc
        if (builtinAddons.designSystemDoc !== undefined) out.designSystemDoc = !!builtinAddons.designSystemDoc;
        if (builtinAddons.designSystemDocLink) out.designSystemDocLink = builtinAddons.designSystemDocLink;
        if (builtinAddons.designSystemDocContent) out.designSystemDocContent = builtinAddons.designSystemDocContent;
        // Constitution (link/content may be present on role configs that reference project-level docs)
        if (builtinAddons.constitutionLink) out.constitutionLink = builtinAddons.constitutionLink;
        if (builtinAddons.constitutionContent) out.constitutionContent = builtinAddons.constitutionContent;
        if (builtinAddons.workflowFilePathEnabled !== undefined) out.workflowFilePathEnabled = !!builtinAddons.workflowFilePathEnabled;
        if (builtinAddons.workflowFilePath) {
            out.workflowFilePathEnabled = true;
            out.workflowFilePath = builtinAddons.workflowFilePath;
        }
        // skipCompilation / skipTests / clearAntigravityContext have no CustomAgentAddons equivalent — intentionally omitted.
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
        if (addons.useSubagents || addons.subagentPolicy) {
            const policy = addons.subagentPolicy || 'default';
            // Mirror buildCustomAgentPrompt: useSubagents===true with no explicit policy
            // still triggers parallel dispatch
            const parallelDispatch = policy === 'useSubagents'
                || (policy === 'default' && addons.useSubagents === true);
            lines.push('### Subagent Usage');
            lines.push(`- Policy: ${policy}.`);
            if (policy === 'noSubagents') {
                lines.push('```');
                lines.push(NO_SUBAGENTS_DIRECTIVE);
                lines.push('```');
            } else if (parallelDispatch) {
                lines.push('- If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.');
            } else if (policy === 'customSubagent' && addons.customSubagentName) {
                lines.push(`- Use the "${addons.customSubagentName}" subagent.`);
                lines.push('- If your platform supports parallel sub-agents, dispatch one such sub-agent per plan to execute them concurrently. If not, process them sequentially.');
            }
            if (addons.customSubagentName && policy !== 'customSubagent') {
                lines.push(`- Custom subagent name: ${addons.customSubagentName}`);
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
