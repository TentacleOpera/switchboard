import * as fs from 'fs';
import * as path from 'path';

/**
 * ClaudeCodeMirrorService
 * ------------------------
 * Generates a native Claude Code discovery layer (`.claude/skills/<name>/SKILL.md`
 * + `.claude/settings.json` allow-list) from Switchboard's `.agents/` source of
 * truth, and supplies the shared CLAUDE.md managed-block builder used by the
 * AGENTS.md/CLAUDE.md scaffolder.
 *
 * Invariants (do NOT "fix" these in a later edit):
 *   1. `.agents/` is the single source of truth. The `.claude/` layer is GENERATED
 *      from it and may be regenerated/overwritten on version change. Only files
 *      tracked in `.claude/.switchboard-generated.json` are ever touched —
 *      user-authored `.claude/skills/` dirs are never modified.
 *   2. We copy ONLY `SKILL.md` into each `.claude/skills/<name>/`. Auxiliary files
 *      (e.g. `kanban_operations/move-card.js`, `_lib/sb_api_call.sh`) are NOT
 *      copied. The mirrored skill bodies keep their `.agents/skills/...`
 *      workspace-root-relative paths, which resolve because `.agents/` is always
 *      scaffolded alongside `.claude/`. Single source, single host-token path.
 *   3. Directory names are lowercase kebab-case (they define the slash command).
 */

export type SkillInvocation = 'default' | 'no-model' | 'no-user';

interface MirrorEntry {
    /** Path relative to `.agents/`, e.g. `workflows/memo.md` or `skills/kanban_operations`. */
    source: string;
    /** kebab-case directory name (defines the `/slash` command). */
    name: string;
    /** Invocation mode: default = both slash + model-auto; no-model = slash only; no-user = model-only. */
    invocation: SkillInvocation;
    /** Optional `allowed-tools` frontmatter value (string or comma-separated string). */
    allowedTools?: string;
    /** Fallback description for sources that ship no frontmatter `description`. */
    descriptionFallback?: string;
}

// --- Finalized manifest (post-cleanup, 2026-06-24): 4 workflows + 21 skills. ---
const MIRROR_MANIFEST: MirrorEntry[] = [
    // Workflows → user-invocable skills (default both-mode).
    { source: 'workflows/memo.md', name: 'memo', invocation: 'default' },
    { source: 'workflows/accuracy.md', name: 'accuracy', invocation: 'default' },
    { source: 'workflows/improve-plan.md', name: 'improve-plan', invocation: 'default' },
    { source: 'workflows/switchboard-chat.md', name: 'switchboard-chat', invocation: 'default' },
    { source: 'workflows/sw-remote.md', name: 'sw-remote', invocation: 'default' },

    // Side-effecting proxy skills → disable-model-invocation (explicit /name only).
    { source: 'skills/clickup_api.md', name: 'clickup-api', invocation: 'no-model', allowedTools: 'Bash' },
    { source: 'skills/clickup_fetch.md', name: 'clickup-fetch', invocation: 'no-model', allowedTools: 'Bash' },
    { source: 'skills/clickup_create_task.md', name: 'clickup-create-task', invocation: 'no-model', allowedTools: 'Bash' },
    { source: 'skills/clickup_modify_task.md', name: 'clickup-modify-task', invocation: 'no-model', allowedTools: 'Bash' },
    { source: 'skills/clickup_attach.md', name: 'clickup-attach', invocation: 'no-model', allowedTools: 'Bash' },
    { source: 'skills/clickup_create_subpage.md', name: 'clickup-create-subpage', invocation: 'no-model', allowedTools: 'Bash' },
    { source: 'skills/linear_api.md', name: 'linear-api', invocation: 'no-model', allowedTools: 'Bash' },
    { source: 'skills/notion_api.md', name: 'notion-api', invocation: 'no-model', allowedTools: 'Bash' },
    {
        source: 'skills/get_tickets.md', name: 'get-tickets', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Fetch tickets from the local Switchboard API proxy (ClickUp/Linear) for the current workspace.'
    },
    { source: 'skills/generate_diagram.md', name: 'generate-diagram', invocation: 'no-model', allowedTools: 'Bash' },
    { source: 'skills/kanban_operations', name: 'kanban-operations', invocation: 'no-model', allowedTools: 'Bash' },
    { source: 'skills/refine_ticket.md', name: 'refine-ticket', invocation: 'no-model' },
    { source: 'skills/refine_epic.md', name: 'refine-epic', invocation: 'no-model' },

    // Model-invocable procedure skills — an agent loads these by description and
    // follows the flow directly (no button click required).
    { source: 'skills/group-into-epics', name: 'group-into-epics', invocation: 'default', allowedTools: 'Bash' },

    // Pure info-retrieval / read-only skills → user-invokable:false + rich description.
    {
        source: 'skills/archive.md', name: 'archive', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Query and manage the DuckDB archive of historical plans and conversations.'
    },
    { source: 'skills/query_archive', name: 'query-archive', invocation: 'no-user', allowedTools: 'Bash' },
    { source: 'skills/query_switchboard_kanban.md', name: 'query-switchboard-kanban', invocation: 'no-user', allowedTools: 'Bash' },
    { source: 'skills/query_kanban_plans.md', name: 'query-kanban-plans', invocation: 'no-user', allowedTools: 'Bash' },
    {
        source: 'skills/web_research.md', name: 'web-research', invocation: 'no-user',
        allowedTools: 'Read, Glob, Grep, WebSearch, WebFetch',
        descriptionFallback: 'Run comprehensive multi-source web research and synthesize a cited summary.'
    },
    {
        source: 'skills/deep_planning.md', name: 'deep-planning', invocation: 'no-user',
        allowedTools: 'Read, Glob, Grep, WebSearch, WebFetch',
        descriptionFallback: 'Produce a deep implementation plan for a codebase change, with research and adversarial review.'
    },
    {
        source: 'skills/complexity_scoring.md', name: 'complexity-scoring', invocation: 'no-user',
        descriptionFallback: 'Score the complexity of a planned change on a 1–10 scale to route it to the right workflow.'
    },
    {
        source: 'skills/advise_research', name: 'advise-research', invocation: 'no-user',
        descriptionFallback: 'When planning, flag uncertain assumptions and supply a ready-to-run web-research prompt to confirm them.'
    },
    {
        source: 'skills/constitution_builder.md', name: 'constitution-builder', invocation: 'no-user',
        descriptionFallback: 'Build or refine a project constitution (coding standards and conventions) for the workspace.'
    },
    {
        source: 'skills/tuning.md', name: 'tuning', invocation: 'no-user',
        descriptionFallback: 'Tune Switchboard agent behavior and workflow settings.'
    },
];

const GENERATED_MANIFEST_FILE = '.switchboard-generated.json';

// Bash patterns the proxy/SQL/CLI skill family runs: curl (sb_api_call.sh),
// source (sb_api_call.sh sources _lib), node (kanban_operations scripts), and
// the SQL CLIs used by the read-only query skills.
const SWITCHBOARD_ALLOW_ENTRIES = [
    'Bash(curl *)',
    'Bash(node *)',
    'Bash(source *)',
    'Bash(sqlite3 *)',
    'Bash(duckdb *)',
];

const SETTINGS_SCHEMA_URL = 'https://json.schemastore.org/claude-code-settings.json';

// ---------------------------------------------------------------------------
// CLAUDE.md managed-block helpers (shared with the protocol-file scaffolder)
// ---------------------------------------------------------------------------

export const CLAUDE_PROTOCOL_HEADER = '# CLAUDE.md - Switchboard Protocol';
export const CLAUDE_BLOCK_START = '<!-- switchboard:claude-protocol:start -->';
export const CLAUDE_BLOCK_END = '<!-- switchboard:claude-protocol:end -->';

/**
 * Claude-Code preamble injected at the TOP of the CLAUDE.md managed block.
 * Starts with CLAUDE_PROTOCOL_HEADER so the per-target legacy-markerless check
 * keys on this (NOT the AGENTS header that lives inside the copied source body).
 */
export const CLAUDE_PREAMBLE = `${CLAUDE_PROTOCOL_HEADER}

> **Claude Code note.** The Switchboard protocol below was authored for the Antigravity host. In Claude Code:
> - \`view_file <path>\` → use the **Read** tool.
> - \`send_message\` and role-routing (reviewer, lead, etc.) are **Antigravity-only** — ignore them here.
> - To run a workflow, invoke its native slash command (e.g. \`/memo\`, \`/improve-plan\`, \`/switchboard-chat\`) or read the skill at \`.claude/skills/<name>/SKILL.md\`.
> - The ClickUp / Linear / kanban skills shell out via \`.agents/skills/_lib/sb_api_call.sh\` and work as-is, provided the Switchboard extension (and its API server) is running.`;

/**
 * Build the inner content (between markers) of a managed protocol block.
 * When a preamble is supplied (CLAUDE.md), it is prepended above the bundled
 * source body; otherwise the source body is used verbatim (AGENTS.md).
 */
export function buildManagedInner(sourceContent: string, preamble?: string): string {
    const body = sourceContent.trimEnd();
    if (preamble && preamble.trim().length > 0) {
        return `${preamble.trimEnd()}\n\n---\n\n${body}`;
    }
    return body;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing / normalization
// ---------------------------------------------------------------------------

interface ParsedSource {
    name?: string;
    description?: string;
    body: string;
}

/** Minimal leading-frontmatter parser for the simple `key: value` YAML our skills use. */
function parseSource(content: string): ParsedSource {
    const normalized = content.replace(/^﻿/, '');
    if (normalized.startsWith('---')) {
        const end = normalized.indexOf('\n---', 3);
        if (end !== -1) {
            const fmBlock = normalized.substring(3, end);
            // Body starts after the closing '---' line.
            const afterFence = normalized.indexOf('\n', end + 1);
            const body = afterFence !== -1 ? normalized.substring(afterFence + 1) : '';
            const fm: ParsedSource = { body: body.replace(/^\n+/, '') };
            for (const rawLine of fmBlock.split('\n')) {
                const line = rawLine.trim();
                const nameMatch = line.match(/^name:\s*(.+)$/);
                const descMatch = line.match(/^description:\s*(.+)$/);
                if (nameMatch) fm.name = stripQuotes(nameMatch[1].trim());
                if (descMatch) fm.description = stripQuotes(descMatch[1].trim());
            }
            return fm;
        }
    }
    return { body: normalized };
}

function stripQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.substring(1, value.length - 1);
    }
    return value;
}

/** First H1 line (stripped of leading '#'), used when a source lacks a frontmatter name. */
function firstH1(body: string): string | undefined {
    for (const line of body.split('\n')) {
        const m = line.match(/^#\s+(.+?)\s*$/);
        if (m) return m[1].trim();
    }
    return undefined;
}

function escapeYamlValue(value: string): string {
    // Quote if the value contains YAML-significant characters.
    if (/[:#"']/.test(value) || value.trim() !== value) {
        return JSON.stringify(value);
    }
    return value;
}

// ---------------------------------------------------------------------------
// Mirror generation
// ---------------------------------------------------------------------------

export interface MirrorResult {
    status: 'generated' | 'skipped' | 'failed';
    reason: string;
    skillsWritten: number;
}

/**
 * Resolve the SKILL source file for a manifest entry.
 * Directory entries read `<dir>/SKILL.md`; flat entries read the `.md` file.
 */
function resolveSourceFile(agentsDir: string, entry: MirrorEntry): string | null {
    const abs = path.join(agentsDir, entry.source);
    try {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
            const skillFile = path.join(abs, 'SKILL.md');
            return fs.existsSync(skillFile) ? skillFile : null;
        }
        return abs;
    } catch {
        return null;
    }
}

function buildSkillMd(entry: MirrorEntry, parsed: ParsedSource): string {
    const description = parsed.description || entry.descriptionFallback || '';
    const lines: string[] = ['---', `name: ${entry.name}`];
    if (description) {
        lines.push(`description: ${escapeYamlValue(description)}`);
    }
    if (entry.allowedTools) {
        lines.push(`allowed-tools: ${entry.allowedTools}`);
    }
    if (entry.invocation === 'no-model') {
        lines.push('disable-model-invocation: true');
    } else if (entry.invocation === 'no-user') {
        // Spelled with a "k" — `user-invocable` (with a "c") triggers validator warnings.
        lines.push('user-invokable: false');
    }
    lines.push('---', '');
    return `${lines.join('\n')}\n${parsed.body.replace(/^\n+/, '').trimEnd()}\n`;
}

/**
 * Generate the `.claude/skills/` mirror + `.claude/settings.json` allow-list from
 * the `.agents/` source under `rootDir`. Idempotent; never touches skills it did
 * not generate. Uses synchronous fs (called infrequently, tiny local files).
 */
export function generateClaudeMirror(rootDir: string, extensionVersion: string | undefined): MirrorResult {
    const agentsDir = path.join(rootDir, '.agents');
    if (!fs.existsSync(agentsDir)) {
        return { status: 'skipped', reason: '.agents source directory not found; nothing to mirror', skillsWritten: 0 };
    }

    const claudeDir = path.join(rootDir, '.claude');
    const skillsRoot = path.join(claudeDir, 'skills');

    try {
        fs.mkdirSync(skillsRoot, { recursive: true });

        const generatedSkills: Array<{ source: string; name: string; relPath: string }> = [];

        for (const entry of MIRROR_MANIFEST) {
            const sourceFile = resolveSourceFile(agentsDir, entry);
            if (!sourceFile) {
                continue; // source missing (user removed it) — skip, never fail the whole mirror
            }
            const raw = fs.readFileSync(sourceFile, 'utf8');
            const parsed = parseSource(raw);
            if (!parsed.name) {
                parsed.name = firstH1(parsed.body);
            }
            const skillDir = path.join(skillsRoot, entry.name);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildSkillMd(entry, parsed), 'utf8');
            generatedSkills.push({
                source: entry.source,
                name: entry.name,
                relPath: path.posix.join('.claude', 'skills', entry.name, 'SKILL.md'),
            });
        }

        // Dynamically scan for generated agent skills under .agents/skills/
        const skillsDir = path.join(agentsDir, 'skills');
        if (fs.existsSync(skillsDir)) {
            try {
                const files = fs.readdirSync(skillsDir);
                for (const file of files) {
                    if (file.startsWith('switchboard-') && file.endsWith('.md')) {
                        const name = file.replace(/^switchboard-/, '').replace(/\.md$/, '');
                        const entry: MirrorEntry = {
                            source: path.posix.join('skills', file),
                            name: `switchboard-${name}`,
                            invocation: 'no-model'
                        };
                        const sourceFile = path.join(skillsDir, file);
                        const raw = fs.readFileSync(sourceFile, 'utf8');
                        const parsed = parseSource(raw);
                        if (!parsed.name) {
                            parsed.name = firstH1(parsed.body);
                        }
                        const skillDir = path.join(skillsRoot, entry.name);
                        fs.mkdirSync(skillDir, { recursive: true });
                        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildSkillMd(entry, parsed), 'utf8');
                        generatedSkills.push({
                            source: entry.source,
                            name: entry.name,
                            relPath: path.posix.join('.claude', 'skills', entry.name, 'SKILL.md'),
                        });
                    }
                }
            } catch (e) {
                console.warn('[ClaudeCodeMirrorService] Failed to scan generated agent skills:', e);
            }
        }

        const settingsAllowAdded = mergePermissionsAllowList(claudeDir);

        const manifest = {
            generator: 'ClaudeCodeMirrorService',
            version: extensionVersion ?? 'unknown',
            generatedAt: new Date().toISOString(),
            skills: generatedSkills,
            settingsAllowEntries: SWITCHBOARD_ALLOW_ENTRIES,
            settingsAllowAdded,
        };
        fs.writeFileSync(
            path.join(claudeDir, GENERATED_MANIFEST_FILE),
            JSON.stringify(manifest, null, 2),
            'utf8'
        );

        return {
            status: 'generated',
            reason: `Mirrored ${generatedSkills.length} skill(s) into .claude/skills/`,
            skillsWritten: generatedSkills.length,
        };
    } catch (error) {
        return {
            status: 'failed',
            reason: `Claude Code mirror generation failed: ${error instanceof Error ? error.message : String(error)}`,
            skillsWritten: 0,
        };
    }
}

/**
 * Non-destructively merge the Switchboard proxy allow-list into `.claude/settings.json`.
 * Reads an existing file, appends only absent Switchboard entries, and writes back.
 * Never overwrites unrelated config. Returns the entries newly added.
 */
function mergePermissionsAllowList(claudeDir: string): string[] {
    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) ?? {};
        } catch {
            // Malformed user settings — do not clobber. Skip the merge.
            return [];
        }
    }

    if (!settings.$schema) {
        settings.$schema = SETTINGS_SCHEMA_URL;
    }
    if (typeof settings.permissions !== 'object' || settings.permissions === null) {
        settings.permissions = {};
    }
    if (!Array.isArray(settings.permissions.allow)) {
        settings.permissions.allow = [];
    }
    if (!Array.isArray(settings.permissions.deny)) {
        settings.permissions.deny = [];
    }

    const existing: string[] = settings.permissions.allow;
    const added: string[] = [];
    for (const entry of SWITCHBOARD_ALLOW_ENTRIES) {
        if (!existing.includes(entry)) {
            existing.push(entry);
            added.push(entry);
        }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    return added;
}
