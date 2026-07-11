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
// 2026-07-03: added `sw` alias + remote-session skills (improve-remote-plan,
// create-feature) + move-task proxies (clickup-move-task, linear-move-issue) that
// were previously advertised in AGENTS.md but never generated into workspaces.
// 2026-07-03: added `/switchboard` front-door router (workflows/switchboard-index.md)
// and `/improve-feature` (workflows/improve-feature.md) feature-reconciliation skill.
const MIRROR_MANIFEST: MirrorEntry[] = [
    // Workflows → user-invocable skills (default both-mode).
    // /switchboard — front door: detects local vs remote and routes to the right skill.
    { source: 'workflows/switchboard-index.md', name: 'switchboard', invocation: 'default' },
    { source: 'workflows/memo.md', name: 'memo', invocation: 'default' },
    { source: 'workflows/accuracy.md', name: 'accuracy', invocation: 'default' },
    { source: 'workflows/improve-plan.md', name: 'improve-plan', invocation: 'default' },
    // /improve-feature — feature reconciliation; authorised to restructure the subtask set.
    { source: 'workflows/improve-feature.md', name: 'improve-feature', invocation: 'default' },
    // /switchboard-split — split one plan into Complex/Risky + Routine files (remote splitter).
    { source: 'workflows/switchboard-split.md', name: 'switchboard-split', invocation: 'default' },
    // switchboard-chat — demoted from a standalone front door to an internal skill
    // the /switchboard router loads (cloud plan-brake persona). no-user: model-loadable,
    // hidden from the slash menu. The typed command may still work in Antigravity (workflows
    // are only surfaced when typed) but is no longer advertised as a front door.
    { source: 'workflows/switchboard-chat.md', name: 'switchboard-chat', invocation: 'no-user' },
    // switchboard-manage — Host-agnostic management console. Demoted from a standalone
    // front door to the internal skill the /switchboard router routes to on local
    // board-driving intent. no-user: model-loadable, hidden from the slash menu.
    // The engine still launches the automation persona by file path
    // (TaskViewerProvider.startOrchestratorFromKanban), so repointing the human command
    // does not break the machine launch.
    {
        source: 'skills/switchboard-manage', name: 'switchboard-manage', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Host-agnostic, low-noise management console for Switchboard — local state first, workspace-scoped API actions.'
    },
    // NOTE: `/sw` and `/sw-remote` were retired 2026-07-03 — superseded by the
    // `/switchboard` front door, which detects local vs remote and routes planning
    // (local → switchboard-chat; remote → the sw-remote.md playbook, still shipped
    // under .agents/workflows/ and loaded by the router, just no longer a command).
    // Remote-session skills — operate on Linear/feature files directly, used when the
    // VS Code extension is off (claude.ai / Claude Code web). Both were previously
    // authored only under .claude/ and so never shipped to user workspaces.
    {
        source: 'skills/improve-remote-plan', name: 'improve-remote-plan', invocation: 'default', allowedTools: 'Bash',
        descriptionFallback: 'Improve a Switchboard plan stored in Linear — reads, deepens, writes back via the LocalApiServer GraphQL proxy without touching git. Use in remote sessions.'
    },
    {
        source: 'skills/create-feature', name: 'create-feature', invocation: 'default',
        descriptionFallback: 'Create a Switchboard feature from a remote session by writing the feature file directly — use when the VS Code extension is not running and create-feature.js is unreachable'
    },
    // Create a feature from a known set of plans when the extension is running.
    {
        source: 'skills/create-feature-from-plans', name: 'create-feature-from-plans', invocation: 'default',
        descriptionFallback: 'Create a Switchboard feature from a known set of plans — no discovery, just mechanics. Use when the user already knows which plans to group.'
    },

    // Side-effecting proxy skills → disable-model-invocation (explicit /name only).
    {
        source: 'skills/clickup-api', name: 'clickup-api', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Make direct ClickUp API calls via LocalApiServer proxy'
    },
    {
        source: 'skills/clickup-fetch', name: 'clickup-fetch', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Fetch ClickUp tasks/lists with automatic name resolution'
    },
    {
        source: 'skills/clickup-create-task', name: 'clickup-create-task', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Create ClickUp tasks with optional subtasks via LocalApiServer'
    },
    {
        source: 'skills/clickup-modify-task', name: 'clickup-modify-task', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Update ClickUp task properties via LocalApiServer'
    },
    {
        source: 'skills/clickup-attach', name: 'clickup-attach', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Attach files to ClickUp tasks via LocalApiServer'
    },
    {
        source: 'skills/clickup-create-subpage', name: 'clickup-create-subpage', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Create doc pages in ClickUp via LocalApiServer'
    },
    {
        source: 'skills/linear-api', name: 'linear-api', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Make direct Linear GraphQL API calls via LocalApiServer proxy'
    },
    // Move-task proxy skills — sources existed under .agents/ but were missing from
    // the manifest, so they never generated into user workspaces.
    {
        source: 'skills/clickup-move-task', name: 'clickup-move-task', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Move a ClickUp task to a different list via LocalApiServer'
    },
    {
        source: 'skills/linear-move-issue', name: 'linear-move-issue', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Move a Linear issue to a different project via LocalApiServer'
    },
    {
        source: 'skills/notion-api', name: 'notion-api', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Post replies back to a Notion-driven Remote Control card via the LocalApiServer bridge'
    },
    {
        source: 'skills/get-tickets', name: 'get-tickets', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Fetch tickets from the local Switchboard API proxy (ClickUp/Linear) for the current workspace.'
    },
    {
        source: 'skills/generate-diagram', name: 'generate-diagram', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Generate architectural diagrams via LocalApiServer'
    },
    {
        source: 'skills/kanban_operations', name: 'kanban-operations', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Move kanban cards and query kanban state via direct database access.'
    },
    {
        source: 'skills/worktree-cleanup', name: 'worktree-cleanup', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Mark a worktree merged and clean it up (kind-aware) via LocalApiServer'
    },
    { source: 'skills/refine_ticket.md', name: 'refine-ticket', invocation: 'no-model' },
    { source: 'skills/refine_feature.md', name: 'refine-feature', invocation: 'no-model' },

    // Model-invocable procedure skills — an agent loads these by description and
    // follows the flow directly (no button click required). no-user: model-loadable,
    // not surfaced as a slash command (the /switchboard router invokes them).
    {
        source: 'skills/group-into-features', name: 'group-into-features', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Group loose Switchboard plans into features — scan pre-coding columns, cluster by capability, propose all groupings for one approval, then create features via create-feature.js'
    },
    // Orchestration HTTP surface — read endpoints + request channel for fleet agents
    // working inside orchestration worktrees. Model-invocable (agents discover it by
    // description when they need to file a request or read board state).
    {
        source: 'skills/switchboard-orchestration', name: 'switchboard-orchestration', invocation: 'default', allowedTools: 'Bash',
        descriptionFallback: 'Switchboard orchestration HTTP surface — the complete LocalApiServer contract for external AI coding tools and fleet agents. Discover the port, read the board/plans/features/worktrees/inbox/session-log, manage plan lifecycle, move cards, group and split features, dispatch fan-out, file requests to the orchestrator, and merge/clean up worktrees — all over localhost HTTP. Includes end-to-end workflows for a fleet coder inside a worktree and for an external orchestrator driving the board.'
    },

    // Pure info-retrieval / read-only skills → user-invokable:false + rich description.
    {
        source: 'skills/archive', name: 'archive', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Query and manage the DuckDB archive of historical plans and conversations.'
    },
    {
        source: 'skills/query_archive', name: 'query-archive', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Query the DuckDB archive directly using duckdb CLI.'
    },
    {
        source: 'skills/query-switchboard-kanban', name: 'query-switchboard-kanban', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Query kanban state using direct SQL access to kanban.db'
    },
    {
        source: 'skills/query-kanban-plans', name: 'query-kanban-plans', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Query the Kanban database for plans by workspace name, project, and features.'
    },
    {
        source: 'skills/web-research', name: 'web-research', invocation: 'no-user',
        allowedTools: 'Read, Glob, Grep, WebSearch, WebFetch',
        descriptionFallback: 'Run comprehensive multi-source web research and synthesize a cited summary.'
    },
    {
        source: 'skills/deep-planning', name: 'deep-planning', invocation: 'no-user',
        allowedTools: 'Read, Glob, Grep, WebSearch, WebFetch',
        descriptionFallback: 'Produce a deep implementation plan for a codebase change, with research and adversarial review.'
    },
    {
        source: 'skills/complexity-scoring', name: 'complexity-scoring', invocation: 'no-user',
        descriptionFallback: 'Score the complexity of a planned change on a 1–10 scale to route it to the right workflow.'
    },
    {
        source: 'skills/advise_research', name: 'advise-research', invocation: 'no-user',
        descriptionFallback: 'When planning, flag uncertain assumptions and supply a ready-to-run web-research prompt to confirm them.'
    },
    {
        source: 'skills/constitution-builder', name: 'constitution-builder', invocation: 'no-user',
        descriptionFallback: 'Build or refine a project constitution (coding standards and conventions) for the workspace.'
    },
    {
        source: 'skills/tuning', name: 'tuning', invocation: 'no-user',
        descriptionFallback: 'Tune Switchboard agent behavior and workflow settings.'
    },
    // switchboard-contracts — agent-facing behavior reference (conventions/contracts).
    // Pure info doc: model-loadable (no-user), no Bash. Distinct from the invocation
    // authority (switchboard-orchestration + GET /catalog) — this answers "how does the
    // system behave?", never "how do I call X?".
    {
        source: 'skills/switchboard-contracts', name: 'switchboard-contracts', invocation: 'no-user',
        descriptionFallback: 'System behavior contracts for agents driving Switchboard — consult when unsure how the system behaves; never for invocation. This doc answers how the system behaves. It never answers how to invoke something — for invocation, use the switchboard-orchestration skill and GET /catalog.'
    },

    // `/switchboard-*` aliases — same sources as the canonical skills above. Demoted
    // to no-user (model-loadable, not surfaced as slash commands) so the canonical
    // user-facing surface stays `/switchboard` + `/memo`. The /switchboard router
    // loads these by name when routing; the canonical names keep working too.
    { source: 'workflows/improve-plan.md', name: 'switchboard-plan', invocation: 'no-user' },
    { source: 'workflows/improve-feature.md', name: 'switchboard-feature', invocation: 'no-user' },
    {
        source: 'skills/improve-remote-plan', name: 'switchboard-remote-plan', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Improve a Switchboard plan stored in Linear — reads, deepens, writes back via the LocalApiServer GraphQL proxy without touching git. Use in remote sessions.'
    },
    {
        source: 'skills/notion-api', name: 'switchboard-notion', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Post replies back to a Notion-driven Remote Control card via the LocalApiServer bridge'
    },
    {
        source: 'skills/linear-api', name: 'switchboard-linear', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Make direct Linear GraphQL API calls via LocalApiServer proxy'
    },
    {
        source: 'skills/clickup-api', name: 'switchboard-clickup', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Make direct ClickUp API calls via LocalApiServer proxy'
    },
    {
        source: 'skills/kanban_operations', name: 'switchboard-kanban', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Move kanban cards and query kanban state via direct database access.'
    },
    {
        source: 'skills/web-research', name: 'switchboard-research', invocation: 'no-user',
        allowedTools: 'Read, Glob, Grep, WebSearch, WebFetch',
        descriptionFallback: 'Run comprehensive multi-source web research and synthesize a cited summary.'
    },
    // switchboard-mcp — transport layer (local stdio MCP server) bridging MCP-only
    // hosts (Claude Desktop, Claude Cowork via the exported switchboard-cowork skill)
    // to LocalApiServer. Demoted from a front door to transport: no-user (model-loadable,
    // not user-facing). Directory-form skill (the dynamic scan only auto-picks flat
    // switchboard-*.md files, so it must be in the manifest or Claude Code never
    // generates it into .claude/skills/). The switchboard-cowork skill bundle carries
    // this transport; do NOT rename the key (the activation-time scrubber deletes
    // `switchboard`-keyed MCP entries — the sanctioned key is `switchboard-mcp`).
    {
        source: 'skills/switchboard-mcp', name: 'switchboard-mcp', invocation: 'no-user',
        descriptionFallback: 'Local stdio MCP server bridging Claude Desktop (and other MCP-only hosts) to Switchboard\'s LocalApiServer HTTP surface'
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
> - To run a workflow, invoke its native slash command (e.g. \`/switchboard\`, \`/memo\`, \`/improve-plan\`) or read the skill at \`.claude/skills/<name>/SKILL.md\`.
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
