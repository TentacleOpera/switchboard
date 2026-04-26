import * as vscode from 'vscode';

export type RelayMode = 'settings-only' | 'context-gatherer-column';

export interface RelayConfig {
    planPath: string;
    planContent: string;
    estimatedComplexity: number;
    dependencies: string[];
}

/**
 * Service for generating Windsurf Relay prompts.
 * Supports two-stage workflow: gather context with cheap agent, then execute with premium agent.
 */
export class RelayPromptService {
    
    /**
     * Generate the context gathering prompt for the cheap agent.
     */
    generateGatherPrompt(config: RelayConfig): string {
        const codeBlock = '```';
        return `You are a context gathering agent. Your ONLY job is to explore the codebase and produce a structured brief.

DO NOT write code. DO NOT suggest fixes. ONLY gather and summarize.

## Target Plan
File: ${config.planPath}

${config.planContent}

## Your Task
1. Read the plan file above carefully
2. Identify all file paths, function names, and class names mentioned
3. Locate these in the codebase
4. Explore related files (imports, callers, tests)
5. Produce a CONTEXT BRIEF in this EXACT format:

---
**CONTEXT BRIEF for ${config.planPath.split('/').pop()}**

**Key Files:**
- \`path/to/file.ts\` — [one-line purpose]
- \`path/to/test.ts\` — [test coverage note]

**Key Functions/Classes:**
- \`functionName()\` in \`file.ts\` — [what it does, relation to plan]

**Dependencies:**
- ${config.dependencies.join(', ') || 'None specified'}

**Relevant Code Sections:**
${codeBlock}typescript
// From: path/to/file.ts (lines X-Y)
[Critical 10-30 line excerpt with key logic]
${codeBlock}

**Unknowns / Ambiguities:**
- [List any unclear requirements or missing context]

**Estimated Complexity:** ${config.estimatedComplexity}/10
---

RULES:
- Keep excerpts SHORT (10-30 lines max each)
- Include 3-5 key files maximum
- Be SPECIFIC with file paths and line numbers where possible
- If a mentioned file doesn't exist, note it under Unknowns
- Total brief should be 2000-3000 tokens maximum`;
    }
    
    /**
     * Generate the execute prompt for the premium agent.
     */
    generateExecutePrompt(config: RelayConfig): string {
        return `You are a senior engineer. You have received a context brief from a relay agent.

## Original Plan
File: ${config.planPath}

${config.planContent}

## Context Brief from Relay Agent
[PASTE CONTEXT BRIEF HERE — the relay agent's output]

## Your Task
Using ONLY the context above, implement the plan. Do not re-explore unless the brief is clearly insufficient.

**Dependencies to consider:** ${config.dependencies.join(', ') || 'None'}

Begin implementation now.`;
    }
}
