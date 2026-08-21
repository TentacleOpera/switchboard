import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';

export interface SparkContextResult {
    path: string;
    bytes: number;
    sections: string[];
    skippedSections: string[];
}

interface ResolvedSource {
    content: string;
    resolved: string;
}

/**
 * Resolve a source file from a list of candidate relative paths, mirroring the
 * `.agents/` → `.agent/` legacy fallback used by ClaudeCodeMirrorService.
 */
function resolveSourceFile(workspaceRoot: string, relPaths: string[]): ResolvedSource | null {
    for (const rel of relPaths) {
        const fullPath = path.join(workspaceRoot, rel);
        if (fs.existsSync(fullPath)) {
            try {
                return { content: fs.readFileSync(fullPath, 'utf8'), resolved: rel };
            } catch { /* continue to next candidate */ }
        }
    }
    return null;
}

interface ParsedSection {
    heading: string;
    body: string;
}

/**
 * Split a markdown doc into sections at heading level 2 **or 3**.
 *
 * Level 3 is not optional here: in the real `AGENTS.md` every section this
 * generator wants — Plan Authoring & Problem Analysis Protocol, Workspace
 * Detection, Plan Project Pinning, Memo Capture Mode — is an `###`, nested under
 * the single `##`. An H2-only parser finds exactly one section, matches none of
 * the wanted titles, and silently emits an artifact whose "Included" list is empty
 * and whose body carries no protocol at all — emptier than the verbatim dump it
 * replaced, and indistinguishable from success unless you read the output.
 *
 * Matching both levels also means an H2 ends where its first H3 begins. That is
 * correct for this use: the H2 is a container that is not itself wanted, and its
 * preamble is not protocol.
 */
function parseH2Sections(raw: string): ParsedSection[] {
    const lines = raw.split('\n');
    const sections: ParsedSection[] = [];
    let current: { heading: string; lines: string[] } | null = null;
    const isHeading = (line: string) => /^#{2,3}\s+\S/.test(line);
    for (const line of lines) {
        if (isHeading(line)) {
            if (current) {
                sections.push({ heading: current.heading, body: current.lines.join('\n') });
            }
            current = { heading: line, lines: [line] };
        } else if (current) {
            current.lines.push(line);
        }
    }
    if (current) {
        sections.push({ heading: current.heading, body: current.lines.join('\n') });
    }
    return sections;
}

function stripH2Prefix(h: string): string {
    return h.replace(/^#{2,3}\s+/, '').trim();
}

const WANTED_AGENTS_SECTIONS: Set<string> = new Set([
    '📝 Plan Authoring & Problem Analysis Protocol',
    '📂 Workspace Detection for Plan Creation',
    '📌 Plan Project Pinning',
    '📌 Memo Capture Mode — Priority Rule'
]);

function curateAgentsMd(raw: string): { body: string; included: string[]; omitted: string[] } {
    const sections = parseH2Sections(raw);
    const included: string[] = [];
    const omitted: string[] = [];
    let selectedBody = '';
    for (const section of sections) {
        const title = stripH2Prefix(section.heading);
        if (WANTED_AGENTS_SECTIONS.has(title)) {
            included.push(title);
            selectedBody += section.body + '\n\n';
        } else {
            omitted.push(title);
        }
    }
    return { body: selectedBody, included, omitted };
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

    const builtInColumns = DEFAULT_KANBAN_COLUMNS.map((c: any) => String(c.id)).join(', ');

    const now = new Date().toISOString();

    let content = `# Switchboard Spark Context Skill — Uploadable AI Surface Protocol

`;
    content += `**Extension Version:** ${extensionVersion}\n`;
    content += `**Generated At:** ${now}\n`;
    content += `**Workspace:** ${path.basename(workspaceRoot)}\n\n`;
    content += `> [!IMPORTANT]\n`;
    content += `> Upload this single file to Gemini Spark or Claude Cowork as persistent context. When Switchboard updates, re-generate and re-upload this file.\n\n`;

    // 1. Curated AGENTS.md protocol sections
    const agentsSource = resolveSourceFile(workspaceRoot, ['AGENTS.md', path.join('.agent', 'AGENTS.md')]);
    if (agentsSource) {
        const { body, included, omitted } = curateAgentsMd(agentsSource.content);

        content += `## Core Switchboard Protocol (curated from AGENTS.md)\n\n`;
        content += `> This is a curated extract of AGENTS.md. Sections that describe capabilities an external, shell-less surface does not have are omitted by name below.\n\n`;
        content += `### Omitted AGENTS.md sections\n\n`;
        content += `Do **not** attempt to follow these even if a copied prompt refers to them. They require the VS Code extension, local file system access to skills, or direct board mutation — none of which are available here:\n\n`;
        for (const title of omitted) {
            content += `- **${title}** — not available in the Spark context; do not act on its instructions.\n`;
        }
        if (omitted.length === 0) {
            content += `- (none omitted)\n`;
        }
        content += `\n`;
        content += `### Included AGENTS.md sections\n\n`;
        for (const title of included) {
            content += `- **${title}**\n`;
        }
        content += `\n`;
        content += body;
        content += `\n`;
        sections.push('AGENTS.md');
    } else {
        console.warn(`[SparkContextExporter] AGENTS.md not found in ${workspaceRoot}; skipping`);
        skippedSections.push('AGENTS.md');
    }

    // 2. Authoring & Review Skills
    const skillList = [
        {
            name: 'improve-plan',
            relPaths: [
                path.join('.agents', 'protocols', 'improve-plan', 'SKILL.md'),
                path.join('.agent', 'skills', 'improve-plan', 'SKILL.md')
            ]
        },
        {
            name: 'improve-feature',
            relPaths: [
                path.join('.agents', 'protocols', 'improve-feature', 'SKILL.md'),
                path.join('.agent', 'skills', 'improve-feature', 'SKILL.md')
            ]
        },
        {
            name: 'switchboard-memo',
            relPaths: [
                path.join('.agents', 'workflows', 'switchboard-memo.md'),
                path.join('.agent', 'workflows', 'switchboard-memo.md')
            ]
        }
    ];

    for (const skill of skillList) {
        const resolved = resolveSourceFile(workspaceRoot, skill.relPaths);
        if (resolved) {
            content += `## Skill: ${skill.name}\n\n`;
            content += resolved.content;
            content += `\n\n`;
            sections.push(skill.name);
        } else {
            console.warn(`[SparkContextExporter] Skill ${skill.name} not found in ${workspaceRoot}; skipping`);
            skippedSections.push(skill.name);
        }
    }

    // 3. Write-Back Convention & Plan File Conventions
    content += `## Write-Back Convention & Plan File Conventions\n\n`;
    content += `- All results are returned by writing a markdown plan file into \`.switchboard/plans/\`. Do not claim to have moved a card, run a command, or updated a database.\n`;
    content += `- Plan filename shape: \`feature_plan_<14-digit-UTC-timestamp>_<kebab-slug>.md\` (e.g. \`feature_plan_20260805130000_switchboard-spark-curation.md\`). The timestamp is generated by the agent; the importer does not assign the filename.\n`;
    content += `- Required sections, in order: \`## Goal\`, \`## Metadata\` (with Tags, Complexity and **Project:** pin if any), \`## User Review Required\`, \`## Complexity Audit\`, \`## Edge-Case & Dependency Audit\`, \`## Dependencies\`, \`## Adversarial Synthesis\`, \`## Proposed Changes\`, \`## Verification Plan\`.\n`;
    content += `- **Project pinning:** include \`**Project:** <name>\` in \`## Metadata\` only when a project was explicitly named by the user or your prompt carries a PROJECT PIN directive. The workspace/repo name is NOT a project. Never use a placeholder like \`<project>\`. Never read \`kanban.db\` or \`kanban.activeProjectFilter\` to derive a pin. If none is given, omit the line.\n`;
    content += `- **Plan IDs are assigned by the importer.** Do NOT write a \`**Plan ID:**\` line; it is never read. The importer creates the UUID and keys plan identity by the file path.\n`;
    content += `- **Feature links** are carried by a \`**Feature:** <feature-plan-id>\` line in each subtask plan's frontmatter (applied on import with apply-if-empty semantics). Do not hand-write feature files unless the remote-only \`manage-features\` skill (Create section) is explicitly required.\n`;
    content += `- The only legitimate side effect of any plan or review you produce is the file written to the named \`.switchboard/plans/\` path.\n\n`;
    sections.push('write-back-convention');

    // 4. Scheduled Jobs & Instruction Inbox Protocol
    content += `## Scheduled Jobs & Instruction Inbox Protocol\n\n`;
    content += `### Inbox & Claim Markers\n`;
    content += `- One-shot task instructions are placed in \`.switchboard/instructions/inbox/\`.\n`;
    content += `- Before processing an item, write a claim marker to \`.switchboard/instructions/inbox/claimed/<filename>.claim\` with:\n`;
    content += `  \`\`\`\n  claimed_ts: <ISO-8601>\n  agent: <agent-id>\n  \`\`\`\n`;
    content += `- A claim is active for **24 hours** by default. If \`claimed_ts\` is less than 24 hours old, skip the item. If older (or unparseable), the item is considered \`stuck\` and may be retried.\n`;
    content += `- A completed item also writes a \`result:\` line in the \`.claim\` file.\n\n`;
    content += `### Standing Jobs\n`;
    content += `- Definitions live in \`.switchboard/instructions/standing/\`.\n`;
    content += `- A standing job file MUST have YAML frontmatter containing, at minimum:\n`;
    content += `  \`\`\`\n  ---\n  job: <name>\n  schedule: <daily|hourly|...>\n  reads: <path or description>\n  writes: <path>\n  ---\n  \`\`\`\n`;
    content += `- The body is a plain instruction. Switchboard uses the frontmatter \`schedule\` to decide cadence.\n\n`;
    content += `### Declared Board Moves\n`;
    content += `- To move cards on the board, write a file in \`.switchboard/instructions/moves/moves-<timestamp>.md\`.\n`;
    content += `- Required frontmatter:\n`;
    content += `  \`\`\`\n  ---\n  kind: board-moves\n  job: <job-name>\n  created: <ISO-8601>\n  ---\n  \`\`\`\n`;
    content += `- One line per move: \`- planId: <plan-id> to: <column-id>\`\n`;
    content += `- \`<column-id>\` must be an actual column ID currently on the board. Do not use a label or slug. Do not use \`CODED\` as a column id; it is not a built-in id (it is a legacy alias normalised to \`LEAD CODED\`). The built-in column ids are: ${builtInColumns}. Custom columns are also valid if they exist on this board.\n`;
    content += `- A single malformed line rejects the **entire file**; Switchboard validates and applies the rest.\n`;
    content += `- Board-advancing jobs are **user-authored, not shipped by Switchboard**. A job that moves cards must name its column IDs explicitly from the board's real vocabulary (listed above) rather than inferring them.\n\n`;
    content += `### Run Log\n`;
    content += `- Append one line per completed run to \`.switchboard/instructions/run-log.md\`.\n`;
    content += `- Format: \`<timestamp> | <job-name> | <summary>\`\n`;
    content += `- A job reads its own last run-log line as the **mtime-supplement cursor**: it scans \`.switchboard/plans/*.md\` for files whose mtime is newer than that timestamp, then combines those with the \`kanban-state-*.md\` snapshots.\n\n`;
    content += `### Kanban State Files\n`;
    content += `- \`.switchboard/kanban-state-<column-slug>.md\` is a DB-exported mirror and is **only refreshed while Switchboard is running**. Between sessions it is frozen; an unattended job must mtime-scan \`.switchboard/plans/\` as a supplement.\n`;
    content += `- File format per column:\n`;
    content += `  \`\`\`\n  ## <COLUMN_ID>\n  \n  **Label:** <display-label>\n  **Agent:** <agent-name>   <!-- optional -->\n  \n  **Column:** <column-id>\n  - [<plan-file>](<plan-file-or-absolute-path>) — <plan-topic> <!-- planId:<uuid> [feature] [subtask-of:"..."] [project:"..."] -->\n  \`\`\`\n`;
    content += `- Each plan is one list line with an HTML comment carrying \`planId\`, optional \`feature\`, optional \`subtask-of\` and optional \`project\`.\n\n`;
    sections.push('scheduled-jobs-protocol');

    // 5. Exclusions, Overrides and Anti-Confabulation
    content += `## Exclusions & Overrides\n\n`;
    content += `### What you cannot do here\n`;
    content += `- You cannot run local shell commands or scripts, including \`npm run\`, \`npm test\`, \`npx tsc\`, \`sqlite3\`, \`curl\`, \`wget\`, \`node *.js\` or \`python\`.\n`;
    content += `- You cannot query, read or write \`kanban.db\` or any other database file.\n`;
    content += `- You cannot run \`.agents/skills/kanban_operations/*.js\` or any other Switchboard utility script.\n`;
    content += `- You cannot make HTTP calls to Switchboard's LocalApiServer (\`POST /connections/verb/...\`, etc.).\n`;
    content += `- You cannot directly move cards, change board columns, or mutate board state.\n`;
    content += `- You cannot dispatch a Switchboard coding, review, orchestrator or terminal agent. You MAY dispatch your own research or coding sub-agents, but they are not Switchboard agents and cannot access the board.\n\n`;
    content += `### What to do instead\n`;
    content += `- To move a card when explicitly instructed, write a declared board-moves file to \`.switchboard/instructions/moves/\` and let the user apply it.\n`;
    content += `- To perform research, dispatch your own research sub-agent and fold the findings into \`## Uncertain Assumptions\`.\n`;
    content += `- To return a completed plan or review, write the markdown file to the named path under \`.switchboard/plans/\` using the naming convention above. That is the only side effect allowed.\n\n`;
    content += `### Research directive override\n`;
    content += `When a copied prompt tells you to emit a research prompt for the user or to POST to a research endpoint, do neither. **Dispatch your own research sub-agent**, wait for it, and fold the findings directly into the artifact. Record each resolved or still-open item in \`## Uncertain Assumptions\`. Do NOT leave research homework for the user.\n\n`;
    content += `### Anti-confabulation rule\n`;
    content += `If you do not know a fact, do not invent it. You may not invent a project pin, a plan ID, a column name, a board state, a research result, a file path, or a claim that you ran a command. Every factual assertion in your output must be traceable to (1) the user's prompt, (2) the skill instructions above, or (3) the output of a sub-agent you actually dispatched. The only external effect allowed is writing a plan file to \`.switchboard/plans/\`. If you are uncertain, record the uncertainty in \`## Uncertain Assumptions\`.\n\n`;
    sections.push('exclusions-overrides');

    fs.writeFileSync(outputPath, content, 'utf8');
    const stats = fs.statSync(outputPath);

    return {
        path: outputPath,
        bytes: stats.size,
        sections,
        skippedSections
    };
}
