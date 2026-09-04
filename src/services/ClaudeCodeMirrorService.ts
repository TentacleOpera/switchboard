import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { KanbanDatabase, ControlPlaneEntry } from './KanbanDatabase';
import { ProtocolService } from './ProtocolService';

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
 *      (e.g. `kanban_operations/move-card.js`, `_lib/cli-call.js`) are NOT
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
// improve-feature, accuracy, switchboard-mission-control) live as stripped skills
// under .agents/skills/ (no frontmatter → invisible to Antigravity's discovery;
// no-user here → hidden from CC's slash menu, model-loadable by path).
// switchboard-mission-control is NOT in the manifest — the engine launches it by path.
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
    // improve-plan, improve-feature, accuracy, dispatch-analysis,
    // advise_research, switchboard-mission-control(-external/-internal), switchboard-mission-control-http,
    // switchboard-contracts, complexity-scoring, deep-planning, web-research, tuning,
    // constitution-builder, external-team-lead, improve-remote-plan, design-system-builder,
    // refine_feature, archive, and the API proxy skills (clickup-*, linear-*, notion-api,
    // get-tickets, generate-diagram) have been moved to .agents/protocols/ — they are
    // delivered by path reference, not via CLI skill discovery, so they are NOT mirrored here.

    // manage-features — merged from create-feature, create-feature-from-plans,
    // group-into-features, rearrange-feature. Discoverable skill with four sections.
    {
        source: 'skills/manage-features', name: 'manage-features', invocation: 'default', allowedTools: 'Bash',
        descriptionFallback: 'Create, group, and rearrange Switchboard features — Create (remote file write, no extension needed), Create from Plans (create-feature.js, requires the extension running), Group (scan/cluster/propose), Rearrange (split/move/merge subtasks without rewriting content).'
    },
    // query-kanban — merged from query-switchboard-kanban + query-kanban-plans.
    // Primary method is the LocalApiServer read endpoints; SQL is a fallback for
    // the no-API case. Description leads with the endpoint method so a DB-less
    // session does not load it expecting direct SQL.
    {
        source: 'skills/query-kanban', name: 'query-kanban', invocation: 'no-user', allowedTools: 'Bash',
        descriptionFallback: 'Read kanban board state via LocalApiServer read endpoints (primary) or local kanban.db SQL (fallback). Requires the extension running or a local kanban.db; unavailable in cloud or tracker-only sessions.'
    },
    {
        source: 'skills/kanban_operations', name: 'kanban-operations', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Move kanban cards and query kanban state via scripts — requires a running Switchboard host (LocalApiServer).'
    },
    {
        source: 'skills/worktree-cleanup', name: 'worktree-cleanup', invocation: 'no-model', allowedTools: 'Bash',
        descriptionFallback: 'Mark a worktree merged and clean it up (kind-aware) via LocalApiServer — requires the Switchboard extension running (no direct-DB fallback).'
    },
];

const GENERATED_MANIFEST_FILE = '.switchboard-generated.json';

// Bash patterns the CLI/SQL skill family runs: switchboard CLI, node (kanban_operations scripts),
// and the SQL CLIs used by the read-only query skills.
const SWITCHBOARD_ALLOW_ENTRIES = [
    'Bash(node *)',
    'Bash(switchboard *)',
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
 * Resident protocol body written into the managed block of BOTH protocol
 * targets — `CLAUDE.md` (Claude Code) and `AGENTS.md` (Antigravity).
 *
 * One body, both hosts, deliberately: the two used to carry each other's
 * requirements with a preamble papering over the mismatch, which is the
 * documented host-drift trap. Antigravity discovers skills correctly, so
 * nothing here needs a per-host variant. `buildManagedInner` still accepts a
 * `bodyOverride` per target, but both callers pass this same constant — the
 * emitted text is guaranteed by code rather than by the packaged `AGENTS.md`,
 * which a hand-edit could otherwise silently change.
 *
 * This is the shrunken form of the formerly 14,826-char block: only the rules
 * that must be resident (re-presented every turn) survive. Everything else
 * either arrives at the moment of use (workflow/protocol files, the host's own
 * skill discovery) or was dead (send_message, view_file, the protocol catalogue).
 * The four action-local sections an external-surface export still needs —
 * Plan Authoring, Workspace Detection, Project Pinning, Memo Capture — moved to
 * `.agents/plan-authoring-protocol.md`, which SparkContextExporter reads and
 * which is never scaffolded into a managed block or injected into a prompt.
 * `CLAUDE_PROTOCOL_HEADER` is NOT emitted into new blocks — it stays exported
 * only as the legacy-markerless detector key (extension.ts ensureClaudeProtocol
 * passes it as `header`); dropping it from the emitted block keeps the size gate
 * under 800 with headroom for the docs pointer below.
 *
 * The card-move rule is deliberately absent here: it is role-scoped (leads and
 * Mission Control legitimately move cards) and lives in agentPromptBuilder's
 * per-role suffix instead.
 */
export const RESIDENT_PROTOCOL_BODY = `- Plans reach the board on their own: a \`.md\` file written to a designated
  plans directory is imported automatically by a watcher. Committing is
  irrelevant — untracked files import too. Never import a plan yourself.
- Memo capture mode: while active, append each user message verbatim — do not
  analyse, plan, or write code. Begin every reply with \`[MEMO CAPTURE ACTIVE]\`.
- Kanban questions: use the \`query-kanban\` skill. Displayed column labels differ
  from the stored IDs, so hand-written SQL silently returns nothing.`;

/**
 * Fourth resident rule — a docs pointer. GATED: do NOT include it in
 * RESIDENT_PROTOCOL_BODY until https://switchboard.dev/docs actually serves
 * (depends on move-the-docs-site-to-switchboard-dev.md). A resident pointer to
 * a 404 is worse than no pointer — the agent fetches, fails, and either reports
 * the product's docs as broken or answers from guesswork. When the URL is live,
 * append this line to RESIDENT_PROTOCOL_BODY (it stays under the 800-char gate).
 */
export const DOCS_POINTER_RULE = `- How Switchboard works: the docs are at https://switchboard.dev/docs. If you
  cannot reach them, say so rather than guessing.`;

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
 *
 * - `bodyOverride` (CLAUDE.md): the resident body is a compact, host-specific
 *   constant (`RESIDENT_PROTOCOL_BODY`) rather than the bundled AGENTS.md source.
 *   The AGENTS.md source stays the single source of truth for the AGENTS.md
 *   target and for SparkContextExporter's section curation, which depends on
 *   the full section structure still being present there.
 * - `preamble`: retained for API stability; no caller passes it now that the
 *   CLAUDE.md block carries no host-translation preamble. When supplied it is
 *   prepended above the body.
 * - No override (AGENTS.md): the bundled source body is used verbatim.
 */
export function buildManagedInner(sourceContent: string, preamble?: string, bodyOverride?: string): string {
    const body = stripProtocolMarkers(bodyOverride ?? sourceContent).trim();
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

// ---------------------------------------------------------------------------
// Control-plane registry seeding & projection
// ---------------------------------------------------------------------------

export interface ControlPlaneProjectionResult {
    status: 'projected' | 'up-to-date' | 'failed' | 'skipped';
    reason: string;
    filesWritten?: number;
    filesPreserved?: number;
}

const SEED_BLOCKLIST = new Set([
    '.switchboard-bundled.json',
    'personas/switchboard_operator.md',
    '.DS_Store'
]);

function isIgnoredSeedFile(relPath: string): boolean {
    const norm = relPath.replace(/\\/g, '/');
    if (SEED_BLOCKLIST.has(norm)) return true;
    if (norm.endsWith('.swp') || norm.endsWith('~') || norm.endsWith('.migrated.bak') || norm.endsWith('.local.bak')) return true;
    const base = path.basename(norm);
    if (base.startsWith('.') && base !== '.agents') return true;
    return false;
}

function crawlDirSync(dir: string, base: string = '', seen: Set<string> = new Set()): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    try {
        const real = fs.realpathSync(dir);
        if (seen.has(real)) return results;
        seen.add(real);
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const rel = base ? path.posix.join(base, entry.name) : entry.name;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...crawlDirSync(full, rel, seen));
            } else if (entry.isFile()) {
                results.push(rel);
            }
        }
    } catch {}
    return results;
}

function deriveKind(relPath: string): string {
    const parts = relPath.replace(/\\/g, '/').split('/');
    const top = parts[0];
    switch (top) {
        case 'workflows': return 'workflow';
        case 'skills': return 'skill';
        case 'protocols': return 'protocol';
        case 'personas': return 'persona';
        case 'rules': return 'rule';
        case 'scripts': return 'script';
        default: return 'doc';
    }
}

function parseSemver(v: string): [number, number, number] {
    const cleaned = v.replace(/^v/, '').split(/[-+]/)[0];
    const parts = cleaned.split('.').map(n => parseInt(n, 10) || 0);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isNewer(regVer: string, curVer: string): boolean {
    const [rMaj, rMin, rPat] = parseSemver(regVer);
    const [cMaj, cMin, cPat] = parseSemver(curVer);
    if (rMaj > cMaj) return true;
    if (rMaj === cMaj && rMin > cMin) return true;
    if (rMaj === cMaj && rMin === cMin && rPat > cPat) return true;
    return false;
}

/**
 * Scan bundled .agents/ assets and shipped docs from the extension bundle
 * and seed them into the authoritative control_plane registry table in KanbanDatabase.
 */
export async function seedControlPlaneFromBundle(
    bundleDir: string,
    db: KanbanDatabase,
    version: string
): Promise<{ seeded: number; updated: number }> {
    const entries: ControlPlaneEntry[] = [];
    const agentsDir = fs.existsSync(path.join(bundleDir, '.agents'))
        ? path.join(bundleDir, '.agents')
        : (fs.existsSync(path.join(bundleDir, 'workflows')) ? bundleDir : null);

    if (agentsDir && fs.existsSync(agentsDir)) {
        const files = crawlDirSync(agentsDir);
        for (const file of files) {
            const relPosix = file.replace(/\\/g, '/');
            if (isIgnoredSeedFile(relPosix)) continue;
            const fullPath = path.join(agentsDir, file);
            try {
                const body = fs.readFileSync(fullPath, 'utf8');
                const contentHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
                entries.push({
                    name: relPosix,
                    kind: deriveKind(relPosix),
                    version,
                    contentHash,
                    body,
                    updatedAt: new Date().toISOString()
                });
            } catch (err) {
                console.warn(`[ClaudeCodeMirrorService] Failed to read bundled agent file ${file}:`, err);
            }
        }
    }

    // Shipped switchboard docs (.switchboard/README.md, SWITCHBOARD_PROTOCOL.md, CLIENT_CONFIG.md)
    const sbDocsDir = path.join(bundleDir, '.switchboard');
    if (fs.existsSync(sbDocsDir)) {
        const docCandidates = ['README.md', 'SWITCHBOARD_PROTOCOL.md', 'CLIENT_CONFIG.md'];
        for (const doc of docCandidates) {
            const docPath = path.join(sbDocsDir, doc);
            if (fs.existsSync(docPath)) {
                try {
                    const body = fs.readFileSync(docPath, 'utf8');
                    const contentHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
                    entries.push({
                        name: doc,
                        kind: 'doc',
                        version,
                        contentHash,
                        body,
                        updatedAt: new Date().toISOString()
                    });
                } catch (err) {
                    console.warn(`[ClaudeCodeMirrorService] Failed to read bundled doc ${doc}:`, err);
                }
            }
        }
    }

    let seeded = 0;
    let updated = 0;
    if (entries.length > 0) {
        const res = await db.seedControlPlane(entries);
        seeded += res.seeded;
        updated += res.updated;
    }

    try {
        const protoRes = await ProtocolService.seedProtocols(db);
        seeded += protoRes.seeded;
        updated += protoRes.updated;
    } catch (e) {
        console.warn('[ClaudeCodeMirrorService] ProtocolService.seedProtocols failed:', e);
    }

    return { seeded, updated };
}

/**
 * Project the control_plane registry into the workspace filesystem (.agents/ and .claude/).
 * Preserves user modifications as .local.bak and never clobbers local edits.
 */
export async function projectControlPlane(
    workspaceRoot: string,
    db: KanbanDatabase,
    currentVersion: string
): Promise<ControlPlaneProjectionResult> {
    const entries = await db.getControlPlaneEntries();
    if (!entries || entries.length === 0) {
        return { status: 'skipped', reason: 'No control-plane entries found in database', filesWritten: 0, filesPreserved: 0 };
    }

    // Downgrade protection: refuse if registry carries a newer version than current extension
    for (const entry of entries) {
        if (isNewer(entry.version, currentVersion)) {
            return {
                status: 'failed',
                reason: `Registry carries newer version (${entry.version}) than extension (${currentVersion}). Refusing projection to prevent downgrade corruption.`,
                filesWritten: 0,
                filesPreserved: 0
            };
        }
    }

    const agentsDir = path.join(workspaceRoot, '.agents');
    let filesWritten = 0;
    let filesPreserved = 0;

    for (const entry of entries) {
        let targetPath: string;
        if (entry.kind === 'doc') {
            targetPath = path.join(workspaceRoot, '.switchboard', entry.name);
        } else if (entry.kind === 'protocol') {
            const isImprovePlan = entry.name === 'improve-plan' || entry.name === 'protocols/improve-plan/SKILL.md';
            const isImproveFeature = entry.name === 'improve-feature' || entry.name === 'protocols/improve-feature/SKILL.md';
            if (!isImprovePlan && !isImproveFeature) {
                // Protocols are database rows, not projected to disk except the two survivors
                continue;
            }
            targetPath = entry.name.endsWith('SKILL.md')
                ? path.join(agentsDir, entry.name)
                : path.join(agentsDir, 'protocols', entry.name, 'SKILL.md');
        } else {
            targetPath = path.join(agentsDir, entry.name);
        }

        const content = (entry.workspaceOverride !== null && entry.workspaceOverride !== undefined)
            ? entry.workspaceOverride
            : entry.body;
        const expectedHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

        if (fs.existsSync(targetPath)) {
            try {
                const diskContent = fs.readFileSync(targetPath, 'utf8');
                const diskHash = crypto.createHash('sha256').update(diskContent, 'utf8').digest('hex');
                if (diskHash !== expectedHash) {
                    const origHash = crypto.createHash('sha256').update(entry.body, 'utf8').digest('hex');
                    if (diskHash !== origHash) {
                        // User modified local file; preserve it as <file>.local.bak
                        const bakPath = targetPath + '.local.bak';
                        if (!fs.existsSync(bakPath)) {
                            try {
                                fs.writeFileSync(bakPath, diskContent, 'utf8');
                            } catch {}
                        }
                        filesPreserved++;
                        continue;
                    }
                }
            } catch {}
        }

        try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, content, 'utf8');
            filesWritten++;
        } catch (err) {
            console.warn(`[ClaudeCodeMirrorService] Failed to write projected file ${targetPath}:`, err);
        }
    }

    // Write .switchboard-bundled.json ledger in .agents/
    try {
        fs.mkdirSync(agentsDir, { recursive: true });
        const ledgerPath = path.join(agentsDir, '.switchboard-bundled.json');
        const ledger = {
            version: currentVersion,
            projectedAt: new Date().toISOString(),
            files: entries.filter(e => e.kind !== 'doc').map(e => e.name)
        };
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
    } catch {}

    // Regenerate Claude Code mirror
    generateClaudeMirror(workspaceRoot, currentVersion);

    return {
        status: 'projected',
        reason: `Projected ${filesWritten} file(s) into .agents/ (${filesPreserved} locally modified preserved)`,
        filesWritten,
        filesPreserved
    };
}
