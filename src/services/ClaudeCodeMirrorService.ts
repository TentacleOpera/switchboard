import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { KanbanDatabase, ControlPlaneEntry } from './KanbanDatabase';
import { ProtocolService } from './ProtocolService';
import { seedStandingOrderFragments } from './standingOrderFragments';

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



const GENERATED_MANIFEST_FILE = '.switchboard-generated.json';

// Bash patterns the CLI/SQL skill family runs: switchboard CLI, node (kanban_operations scripts),
// and the SQL CLIs used by the read-only query skills.
const SWITCHBOARD_ALLOW_ENTRIES = [
    'Bash(node *)',
    'Bash(switchboard *)',
    'Bash(sqlite3 *)',
];

const SETTINGS_SCHEMA_URL = 'https://json.schemastore.org/claude-code-settings.json';

// ---------------------------------------------------------------------------
// Protocol-block primitives now live in protocolScaffolder.ts (dependency-free,
// so both composition roots can use them). Re-exported here for the existing
// importers.
// ---------------------------------------------------------------------------
export {
    CLAUDE_PROTOCOL_HEADER,
    CLAUDE_BLOCK_START,
    CLAUDE_BLOCK_END,
    RESIDENT_PROTOCOL_BODY,
    DOCS_POINTER_RULE,
    buildManagedInner,
} from './protocolScaffolder';

// ---------------------------------------------------------------------------
// Frontmatter parsing / normalization
// ---------------------------------------------------------------------------



function stripQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.substring(1, value.length - 1);
    }
    return value;
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

    // Seed static standing-order fragment bodies into control_plane as
    // kind: 'standing-order-fragment' rows — same seed path protocols use.
    // An operator's override_body survives re-seeds via seedControlPlane's
    // COALESCE logic. See standingOrderFragments.ts.
    try {
        const fragRes = await seedStandingOrderFragments(db);
        seeded += fragRes.seeded;
        updated += fragRes.updated;
    } catch (e) {
        console.warn('[ClaudeCodeMirrorService] seedStandingOrderFragments failed:', e);
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
        } else if (entry.kind === 'standing-order-fragment') {
            // Standing-order fragment bodies are consumed by the registry at
            // delivery (composeStandingOrderFragments reads the in-memory
            // cache), not projected to the workspace filesystem. Projecting
            // them would create junk files like .agents/team.head.commit on
            // every host start.
            continue;
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
            files: entries.filter(e => e.kind !== 'doc' && e.kind !== 'standing-order-fragment').map(e => e.name)
        };
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
    } catch {}

    return {
        status: 'projected',
        reason: `Projected ${filesWritten} file(s) into .agents/ (${filesPreserved} locally modified preserved)`,
        filesWritten,
        filesPreserved
    };
}
