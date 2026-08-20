import * as fs from 'fs';
import * as path from 'path';

export interface LauncherSpec {
    id: string;
    label: string;
    description: string;
    skillPaths: string[];        // tried in order, e.g. ['.switchboard/protocols/improve-plan/SKILL.md', '.agent/skills/improve-plan/SKILL.md']
    fallbackPrompt: string;      // used when no skill file resolves
    targetKind: 'plan' | 'feature' | 'memo' | 'none';
}

export function composeExternalPrompt(
    spec: LauncherSpec,
    workspaceRoot: string,
    target?: { absPath: string; content: string }
): { prompt: string; resolvedSkillPath: string | null } {
    let skillContent = '';
    let resolvedSkillPath: string | null = null;

    for (const relPath of spec.skillPaths) {
        const fullPath = path.join(workspaceRoot, relPath);
        if (fs.existsSync(fullPath)) {
            try {
                skillContent = fs.readFileSync(fullPath, 'utf8');
                resolvedSkillPath = relPath;
                break;
            } catch {
                // Ignore read failure and continue
            }
        }
    }

    if (!resolvedSkillPath) {
        skillContent = spec.fallbackPrompt;
    }

    let prompt = `You are running an external AI task for Switchboard: ${spec.label}\n\n## Skill Instructions\n${skillContent}\n\n`;

    if (target && target.absPath) {
        prompt += `## Target Artifact\n- **Local File Path (write result here):** ${target.absPath}\n\n`;
        prompt += `## Current Content\n${target.content || '(empty or file does not exist yet)'}\n\n`;
    }

    prompt += `## Write-Back Requirement\nWrite the resulting markdown content directly to the local file path provided. Do not invent board cards, modify kanban.db, or create API calls. Do not guess a **Project:** pin if none is specified.`;

    return { prompt, resolvedSkillPath };
}

export const LAUNCHER_REGISTRY: LauncherSpec[] = [
    {
        id: 'memo-process',
        label: 'Process memo into plans',
        description: 'Process .switchboard/memo.md into individual plan files in .switchboard/plans/',
        skillPaths: [
            path.join('.agents', 'workflows', 'switchboard-memo.md'),
            path.join('.agent', 'workflows', 'switchboard-memo.md')
        ],
        fallbackPrompt: 'Read .switchboard/memo.md. Process each entry into a distinct plan file under .switchboard/plans/. Clear or truncate .switchboard/memo.md after processing. Do not assign project pins unless specified.',
        targetKind: 'memo'
    },
    {
        id: 'plan-write',
        label: 'Write plans from a brief',
        description: 'Generate complete, shippable plan files under .switchboard/plans/ from brief notes or requirements',
        skillPaths: [
            path.join('.switchboard', 'protocols', 'improve-plan', 'SKILL.md'),
            path.join('.agent', 'skills', 'improve-plan', 'SKILL.md')
        ],
        fallbackPrompt: 'Author complete implementation plans in .switchboard/plans/ following Switchboard plan authoring conventions. Include Goal, Metadata, Problem Analysis, and Verification Plan sections. Omit **Project:** unless requested.',
        targetKind: 'none'
    },
    {
        id: 'plan-review',
        label: 'Review a plan',
        description: 'Perform adversarial review of a plan file and append/update findings in place',
        skillPaths: [
            path.join('.switchboard', 'protocols', 'improve-plan', 'SKILL.md'),
            path.join('.agent', 'skills', 'improve-plan', 'SKILL.md')
        ],
        fallbackPrompt: 'Review the specified plan file for accuracy, completeness, and edge cases. Write updated plan content directly back to the file path provided.',
        targetKind: 'plan'
    },
    {
        id: 'feature-review',
        label: 'Review a feature',
        description: 'Reconcile feature subtasks, flesh out spec, and write updated feature content back to disk',
        skillPaths: [
            path.join('.switchboard', 'protocols', 'improve-feature', 'SKILL.md'),
            path.join('.agent', 'skills', 'improve-feature', 'SKILL.md')
        ],
        fallbackPrompt: 'Review and refine feature specification and subtasks. Write updated content directly back to the feature file path provided.',
        targetKind: 'feature'
    }
];
