import * as fs from 'fs';
import * as path from 'path';

export interface SparkContextResult {
    path: string;
    bytes: number;
    sections: string[];
    skippedSections: string[];
}

export function generateSparkContext(workspaceRoot: string, extensionVersion: string): SparkContextResult {
    const sbDir = path.join(workspaceRoot, '.switchboard');
    const outputPath = path.join(sbDir, 'switchboard-spark.md');
    const sections: string[] = [];
    const skippedSections: string[] = [];

    // Never create `.switchboard/` here. This runs on activation for every
    // workspace root (extension.ts, refreshWorkspaceControlPlane), so a
    // mkdir would scaffold a Switchboard directory into folders that have
    // never used Switchboard — the documented scaffold-litter failure, and the
    // same rule bootstrapInstructionsDirectory already follows.
    if (!fs.existsSync(sbDir)) {
        return { path: outputPath, bytes: 0, sections: [], skippedSections: ['(skipped — no .switchboard/ in this workspace)'] };
    }

    let content = `# Switchboard Spark Context Skill — Uploadable AI Surface Protocol

`;
    content += `**Extension Version:** ${extensionVersion}
`;
    content += `**Generated At:** ${new Date().toISOString()}
`;
    content += `**Workspace:** ${path.basename(workspaceRoot)}

`;
    content += `> [!IMPORTANT]
`;
    content += `> Upload this single file to Gemini Spark or Claude Cowork as persistent context. When Switchboard updates, re-generate and re-upload this file.

`;

    // 1. Include AGENTS.md core protocols
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
        try {
            let agentsRaw = fs.readFileSync(agentsPath, 'utf8');
            // Filter out local terminal commands and sqlite3 DB queries that external AI surfaces cannot run
            agentsRaw = agentsRaw
                .replace(/^.*sqlite3\b.*$/gmi, '<!-- [Stripped local sqlite3 command for external Spark context] -->')
                .replace(/^.*npm (run|test|build)\b.*$/gmi, '<!-- [Stripped local npm command for external Spark context] -->')
                .replace(/^.*npx tsc\b.*$/gmi, '<!-- [Stripped local tsc command for external Spark context] -->');
            content += `## Core Switchboard Protocol (from AGENTS.md)

${agentsRaw}

`;
            sections.push('AGENTS.md');
        } catch {
            skippedSections.push('AGENTS.md');
        }
    } else {
        skippedSections.push('AGENTS.md');
    }

    // 2. Include Authoring & Review Skills
    const skillList = [
        { name: 'improve-plan', relPath: path.join('.agents', 'skills', 'improve-plan', 'SKILL.md') },
        { name: 'improve-feature', relPath: path.join('.agents', 'skills', 'improve-feature', 'SKILL.md') },
        { name: 'memo', relPath: path.join('.agents', 'workflows', 'switchboard-memo.md') }
    ];

    for (const skill of skillList) {
        const fullSkillPath = path.join(workspaceRoot, skill.relPath);
        if (fs.existsSync(fullSkillPath)) {
            try {
                const body = fs.readFileSync(fullSkillPath, 'utf8');
                content += `## Skill: ${skill.name}

${body}

`;
                sections.push(skill.name);
            } catch {
                skippedSections.push(skill.name);
            }
        } else {
            skippedSections.push(skill.name);
        }
    }

    // 3. Write-Back Convention & Rules
    content += `## Write-Back Convention & File-Based Return
`;
    content += `- All generated plan files must be written directly into \`.switchboard/plans/\` using absolute path given or \`feature_plan_<timestamp>_<slug>.md\` format.
`;
    content += `- Do not write to database files (e.g. \`kanban.db\`) directly.
`;
    content += `- Do not attempt to run local CLI scripts or shell tools directly.
`;
    content += `- Do not guess or invent a **Project:** pin. Omit it if not specified.

`;

    // 4. Scheduled Jobs & Instruction Inbox Protocol
    content += `## Scheduled Jobs & Instruction Inbox Protocol
`;
    content += `Check \`.switchboard/instructions/\` on scheduled runs:
`;
    content += `- **Inbox:** \`.switchboard/instructions/inbox/\` contains one-shot tasks.
`;
    content += `- **Claim Markers:** Write \`inbox/claimed/<filename>.claim\` before processing an item to prevent duplicate execution.
`;
    content += `- **Standing Jobs:** Read definitions in \`.switchboard/instructions/standing/\` (e.g. \`memo-to-plans.md\`, \`nightly-code-review.md\`, \`research-unknowns.md\`, \`pipeline-manager.md\`).
`;
    content += `- **Declared Board Moves:** To move cards on the board, write a file in \`.switchboard/instructions/moves/moves-<timestamp>.md\` containing lines: \`- planId: <id> to: <COLUMN_NAME>\`. Switchboard will validate and apply the moves.
`;
    content += `- **Run Log:** Append one line per completed run to \`.switchboard/instructions/run-log.md\`.

`;

    // 5. Exclusions & Overrides
    content += `## Exclusions & Overrides
`;
    content += `### What You Cannot Do
`;
    content += `- You cannot execute local terminal commands, invoke node scripts, or query kanban.db.
`;
    content += `- You cannot directly mutate board column states (use declared moves files instead).

`;

    content += `### Research Directive Override
`;
    content += `When a prompt tells you to emit a research prompt for the user, or POST to a research endpoint: **Dispatch your own research sub-agent**, fold findings directly into the artifact, and record resolved/open items in \`## Uncertain Assumptions\`. Do NOT leave research homework for the user.
`;

    // \`.switchboard/\` is guaranteed to exist — the early return above is the only
    // gate, and creating it here would defeat it.
    fs.writeFileSync(outputPath, content, 'utf8');
    const stats = fs.statSync(outputPath);

    return {
        path: outputPath,
        bytes: stats.size,
        sections,
        skippedSections
    };
}
