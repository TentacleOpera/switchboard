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

// --- Four front doors (2026-07-12 refactor): switchboard, switchboard-cloud,
// switchboard-remote, switchboard-memo — identical surface on Antigravity and
// Claude Code. Internal extension-dispatched workflows (improve-plan,
// improve-feature, accuracy, switchboard-orchestrator) live as stripped skills
// under .agents/skills/ (no frontmatter → invisible to Antigravity's discovery;
// no-user here → hidden from CC's slash menu, model-loadable by path).
// switchboard-orchestrator is NOT in the manifest — the engine launches it by path.
const MIRROR_MANIFEST: MirrorEntry[] = [
    // --- Four front doors (default: slash + model-auto) ---
    // /switchboard — local management console (absorbs the former switchboard-manage
    // skill body verbatim). allowedTools: Bash — the console drives curl/awk/stat.
    {
        source: 'workflows/switchboard.md', name: 'switchboard', invocation: 'default',
        allowedTools: 'Bash, Read, Write, Glob, Grep',
        descriptionFallback: 'Local Switchboard management console — drive the board when the VS Code extension is running'
    },
    // /switchboard-cloud — cloud-VM plan-brake (former switchboard-chat body).
    { source: 'workflows/switchboard-cloud.md', name: 'switchboard-cloud', invocation: 'default' },
    // /switchboard-remote — remote control via Linear/Notion MCP proxy (former sw-remote body).
    { source: 'workflows/switchboard-remote.md', name: 'switchboard-remote', invocation: 'default' },
    // /switchboard-memo — memo capture mode (former memo.md, renamed).
    { source: 'workflows/switchboard-memo.md', name: 'switchboard-memo', invocation: 'default' },

    // --- Internal extension-dispatched skills (no-user: hidden from slash, model-loadable) ---
    // improve-plan, improve-feature, accuracy, terminal-coder-dispatch, dispatch-analysis,
    // advise_research, switchboard-orchestrator(-external/-internal), switchboard-orchestration,
    // switchboard-contracts, complexity-scoring, deep-planning, web-research, tuning,
    // constitution-builder, external-team-lead, improve-remote-plan, design-system-builder,
    // refine_feature, archive, and the API proxy skills (clickup-*, linear-*, notion-api,
    // get-tickets, generate-diagram) have been moved to .switchboard/protocols/ — they are
    // delivered by path reference, not via CLI skill discovery, so they are NOT mirrored here.

    // manage-features — merged from create-feature, create-feature-from-plans,
    // group-into-features, rearrange-feature. Discoverable skill with four sections.
    {
        source: 'skills/manage-features', name: 'manage-features', invocation: 'default', allowedTools: 'Bash',
        descriptionFallback: 'Create, group, and rearrange Switchboard features — Create (remote file write), Create from Plans (create-feature.js), Group (scan/cluster/propose), Rearrange (split/move/merge subtasks without rewriting content).'
    },
    // query-kanban — merged from query-switchboard-kanban + query-kanban-plans.
    {
        source: 'skills/query-kanban', name: 'query-kanban', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Query kanban state using direct SQL access to kanban.db (read-only). Includes schema reference, column label mapping, and ready-made query templates.'
    },
    {
        source: 'skills/kanban_operations', name: 'kanban-operations', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Move kanban cards and query kanban state via direct database access.'
    },
    {
        source: 'skills/worktree-cleanup', name: 'worktree-cleanup', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Mark a worktree merged and clean it up (kind-aware) via LocalApiServer'
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
> - To run a workflow, invoke its native slash command (e.g. \`/switchboard\`, \`/switchboard-cloud\`, \`/switchboard-remote\`, \`/switchboard-memo\`) or read the skill at \`.claude/skills/<name>/SKILL.md\`.
> - The ClickUp / Linear / kanban skills shell out via \`.agents/skills/_lib/sb_api_call.sh\` and work as-is, provided the Switchboard extension (and its API server) is running.`;

/**
 * Strip any managed-block boundary markers (`<!-- switchboard:agents-protocol:start/end -->`)
 * from content. The bundled AGENTS.md source is itself a managed protocol file (this repo
 * is a Switchboard workspace), so it carries its own marker pair. Left in place, each
 * activation would re-wrap those markers and accumulate a redundant pair (2/2, 3/3, …).
 * Removing them here means `buildManagedInner` always emits marker-free inner content and
 * the surrounding wrap produces exactly one clean pair.
 */
function stripProtocolMarkers(content: string): string {
    return content
        .split('\n')
        .filter(line => !/^\s*<!--\s*switchboard:agents-protocol:(start|end)\s*-->\s*$/.test(line))
        .join('\n');
}

/**
 * Build the inner content (between markers) of a managed protocol block.
 * When a preamble is supplied (CLAUDE.md), it is prepended above the bundled
 * source body; otherwise the source body is used verbatim (AGENTS.md).
 */
export function buildManagedInner(sourceContent: string, preamble?: string): string {
    const body = stripProtocolMarkers(sourceContent).trim();
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

        // Remove stale mirrors: skills this generator previously wrote (tracked in the
        // ledger) that were NOT regenerated this run — the manifest entry was retired or
        // its source removed. Without this, retired commands stay user-invokable in
        // Claude Code on existing installs forever (the workflow-side equivalent is
        // cleanupLegacyAgentFiles). Only ledger-tracked names under .claude/skills/ are
        // ever deleted — user-authored skills are never touched.
        try {
            const ledgerPath = path.join(claudeDir, GENERATED_MANIFEST_FILE);
            if (fs.existsSync(ledgerPath)) {
                const previous = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
                const regenerated = new Set(generatedSkills.map(s => s.name));
                const prevSkills: Array<{ name?: string }> = Array.isArray(previous?.skills) ? previous.skills : [];
                for (const prev of prevSkills) {
                    if (!prev?.name || regenerated.has(prev.name)) continue;
                    const staleDir = path.join(skillsRoot, prev.name);
                    if (!staleDir.startsWith(skillsRoot + path.sep)) continue; // path-traversal guard
                    fs.rmSync(path.join(staleDir, 'SKILL.md'), { force: true });
                    try { fs.rmdirSync(staleDir); } catch { /* non-empty (user files) — leave the dir */ }
                }
            }
        } catch (e) {
            console.warn('[ClaudeCodeMirrorService] Failed to clean stale mirrored skills:', e);
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
