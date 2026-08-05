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

    let content = `# Switchboard Spark Context Skill — Uploadable AI Surface Protocol\n\n`;
    content += `**Extension Version:** ${extensionVersion}\n`;
    content += `**Generated At:** ${new Date().toISOString()}\n`;
    content += `**Workspace:** ${path.basename(workspaceRoot)}\n\n`;
    content += `> [!IMPORTANT]\n`;
    content += `> Upload this single file to Gemini Spark or Claude Cowork as persistent context. When Switchboard updates, re-generate and re-upload this file.\n\n`;

    // 1. Include AGENTS.md core protocols
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
        try {
            const agentsRaw = fs.readFileSync(agentsPath, 'utf8');
            content += `## Core Switchboard Protocol (from AGENTS.md)\n\n${agentsRaw}\n\n`;
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
                content += `## Skill: ${skill.name}\n\n${body}\n\n`;
                sections.push(skill.name);
            } catch {
                skippedSections.push(skill.name);
            }
        } else {
            skippedSections.push(skill.name);
        }
    }

    // 3. Write-Back Convention & Rules
    content += `## Write-Back Convention & File-Based Return\n`;
    content += `- All generated plan files must be written directly into \`.switchboard/plans/\` using absolute path given or \`feature_plan_<timestamp>_<slug>.md\` format.\n`;
    content += `- Do not write to database files (e.g. \`kanban.db\`) directly.\n`;
    content += `- Do not attempt to run local CLI scripts or shell tools directly.\n`;
    content += `- Do not guess or invent a **Project:** pin. Omit it if not specified.\n\n`;

    // 4. Scheduled Jobs & Instruction Inbox Protocol
    content += `## Scheduled Jobs & Instruction Inbox Protocol\n`;
    content += `Check \`.switchboard/instructions/\` on scheduled runs:\n`;
    content += `- **Inbox:** \`.switchboard/instructions/inbox/\` contains one-shot tasks.\n`;
    content += `- **Claim Markers:** Write \`inbox/claimed/<filename>.claim\` before processing an item to prevent duplicate execution.\n`;
    content += `- **Standing Jobs:** Read definitions in \`.switchboard/instructions/standing/\` (e.g. \`memo-to-plans.md\`, \`nightly-code-review.md\`, \`research-unknowns.md\`, \`pipeline-manager.md\`).\n`;
    content += `- **Declared Board Moves:** To move cards on the board, write a file in \`.switchboard/instructions/moves/moves-<timestamp>.md\` containing lines: \`- planId: <id> to: <COLUMN_NAME>\`. Switchboard will validate and apply the moves.\n`;
    content += `- **Run Log:** Append one line per completed run to \`.switchboard/instructions/run-log.md\`.\n\n`;

    // 5. Exclusions & Research Override
    content += `## Exclusions & Overrides\n`;
    content += `### What You Cannot Do\n`;
    content += `- You cannot execute local terminal commands, invoke node scripts, or query kanban.db.\n`;
    content += `- You cannot directly mutate board column states (use declared moves files instead).\n\n`;

    content += `### Research Directive Override\n`;
    content += `When a prompt tells you to emit a research prompt for the user, or POST to a research endpoint: **Dispatch your own research sub-agent**, fold findings directly into the artifact, and record resolved/open items in \`## Uncertain Assumptions\`. Do NOT leave research homework for the user.\n`;

    // `.switchboard/` is guaranteed to exist — the early return above is the only
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
