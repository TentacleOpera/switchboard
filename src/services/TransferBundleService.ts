import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as cp from 'child_process';
import type { KanbanDatabase } from './KanbanDatabase';

const execFileAsync = promisify(cp.execFile);

/**
 * Transfer bundle — one versioned JSON file for the sequential handover case
 * (a machine retiring, a laptop being replaced, a remote box being set up).
 * Carries the shared board tier plus personal-portable / team-shared settings,
 * re-keys onto the destination by `planFile`, and refuses to carry machine-local
 * state or credentials.
 *
 * See `.switchboard/plans/hand-a-workspace-to-another-machine.md`.
 */

export const TRANSFER_BUNDLE_SCHEMA = 1;
export const TRANSFER_BUNDLE_FILENAME = 'switchboard-transfer.json';

/** Three classes, two axes. See plan §2. The default arm is machine-local. */
export type ConfigKeyClass = 'machine-local' | 'personal-portable' | 'team-shared';

export interface TransferCardEntry {
    planFile: string;
    column: string;
    project: string;
    complexity: string;
    isFeature: boolean;
    featureFile: string | null;
    tags: string;
    repoScope: string;
    priority: boolean;
}

export interface TransferBundle {
    schema: number;
    exportedAt: string;
    sourceWorkspaceName: string;
    cards: TransferCardEntry[];
    settings: Record<string, string>;
}

export interface ExportResult {
    success: boolean;
    path?: string;
    cardCount: number;
    settingCount: number;
    credentialCount: number;
    untrackedPlanFiles: string[];
    unpushedCommits: number;
    scpLine?: string;
    error?: string;
}

export interface ImportCardOutcome {
    planFile: string;
    matched: boolean;
    reason?: string;
}

export interface ImportResult {
    success: boolean;
    cardsUpdated: number;
    cardsSkipped: ImportCardOutcome[];
    settingsApplied: string[];
    settingsExcluded: string[];
    error?: string;
}

// ── Config classification ─────────────────────────────────────────────────

/**
 * Team-shared keys: travel in BOTH the transfer bundle AND a future shared
 * board store. A teammate adopting the board gets these.
 */
const TEAM_SHARED_EXACT = new Set<string>([
    'kanban.dynamicComplexityRoutingEnabled',
    'kanban.columnDragDropModes',
    'agents.customAgents',
    'agents.visibleAgents',
    'planning.ingestionFolder',
    'project_context_enabled',
    // terminals.agentGroups holds role/count/scope + prompt templates with
    // {child}/{head} placeholders — NOT live terminal names. It is the team
    // definition that travels so tuned prompts survive a handover. The
    // `terminals.` prefix is machine-local, so this exact match MUST be checked
    // before the prefix (see classifyConfigKey ordering). The plan's §4 dry-run
    // found this misfiled as machine-local; the binding (seats→real terminal
    // names) is what stays machine-local, not the definition.
    'terminals.agentGroups',
]);

const TEAM_SHARED_PREFIXES: string[] = [
    'switchboard.prompts.roleConfig_',
    'feature_',
    'epic_',
];

/**
 * Personal-portable keys: travel in the transfer bundle (my other machine)
 * but NOT in a shared board store (my chrome is not my team's).
 */
const PERSONAL_PORTABLE_EXACT = new Set<string>([
    'theme.name',
]);

const PERSONAL_PORTABLE_PREFIXES: string[] = [
    'statusBar.',
    'activityLight.',
];

/**
 * Retention windows are personal-portable: my thresholds are not my team's.
 * Matched by suffix so the prefix (e.g. `kanban.hotWindowDays`,
 * `planLog.retentionDays`) does not have to be enumerated per host.
 */
const PERSONAL_PORTABLE_SUFFIXES: string[] = [
    'retentionDays',
    'hotWindowDays',
    'WindowDays',
];

/**
 * Explicitly machine-local even though a prefix/suffix rule above might match.
 * Belt-and-suspenders: names a few known-bad keys so a future broadening of the
 * portable prefixes cannot accidentally sweep them in.
 */
const MACHINE_LOCAL_EXACT = new Set<string>([
    'kanban.dbPath',
    'kanban.featureWatches',
    'workspace_mappings',
    'workspace_id',
    'folders.paths',
]);

const MACHINE_LOCAL_PREFIXES: string[] = [
    'terminals.',
    'switchboard.prompts.terminals.',
    'runtime.',
];

/**
 * Classify a config key. Default arm is **machine-local**: an unrecognised key
 * is excluded until someone deliberately classifies it. The failure mode of
 * over-exclusion is "retype one setting"; the failure mode of over-inclusion is
 * a poisoned destination (dead terminal roster, wrong db path).
 */
export function classifyConfigKey(key: string): ConfigKeyClass {
    if (!key) return 'machine-local';
    // Exact matches win over prefix rules, so a key like `terminals.agentGroups`
    // (team-shared exact) is not swallowed by the `terminals.` machine-local
    // prefix. Machine-local exacts still win over everything.
    if (MACHINE_LOCAL_EXACT.has(key)) return 'machine-local';
    if (TEAM_SHARED_EXACT.has(key)) return 'team-shared';
    if (PERSONAL_PORTABLE_EXACT.has(key)) return 'personal-portable';
    // Prefix / suffix rules.
    for (const p of MACHINE_LOCAL_PREFIXES) {
        if (key.startsWith(p)) return 'machine-local';
    }
    for (const p of TEAM_SHARED_PREFIXES) {
        if (key.startsWith(p)) return 'team-shared';
    }
    for (const p of PERSONAL_PORTABLE_PREFIXES) {
        if (key.startsWith(p)) return 'personal-portable';
    }
    for (const s of PERSONAL_PORTABLE_SUFFIXES) {
        if (key.endsWith(s)) return 'personal-portable';
    }
    return 'machine-local';
}

/** The transfer bundle carries personal-portable PLUS team-shared. */
function isPortableForTransfer(cls: ConfigKeyClass): boolean {
    return cls === 'personal-portable' || cls === 'team-shared';
}

// ── Credential self-assertion ─────────────────────────────────────────────

/**
 * Known token prefixes that, if found in a bundle value, mean a credential
 * leaked in. The exporter must refuse to write and name the offending key —
 * this is the guard that survives the allowlist being wrong.
 */
const CREDENTIAL_PREFIXES: string[] = [
    'lin_api_',
    'ghp_',
    'github_pat_',
    'sk-',
    'xoxb-',
    'xoxp-',
    'ntn_',
    'AIza',
    'Bearer ',
];

/** Keys whose names are credential-shaped even if the value is short. */
const CREDENTIAL_KEY_PATTERNS: RegExp[] = [
    /token/i,
    /secret/i,
    /password/i,
    /apikey/i,
    /api_key/i,
    /master.?key/i,
];

/**
 * Shannon entropy over character frequencies. Used to catch high-entropy
 * secrets that do not match a known prefix (e.g. a random PAT under a
 * misclassified key). Threshold tuned for ~40+ char random strings.
 */
function shannonEntropy(s: string): number {
    if (!s) return 0;
    const freq = new Map<string, number>();
    for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
    let entropy = 0;
    const len = s.length;
    for (const count of freq.values()) {
        const p = count / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

const HIGH_ENTROPY_THRESHOLD = 4.5;
const HIGH_ENTROPY_MIN_LENGTH = 32;

/** A value is credential-shaped if it matches a known prefix OR is a long high-entropy string. */
function valueLooksCredential(value: string): boolean {
    if (!value) return false;
    for (const p of CREDENTIAL_PREFIXES) {
        if (value.startsWith(p)) return true;
    }
    if (value.length >= HIGH_ENTROPY_MIN_LENGTH && shannonEntropy(value) >= HIGH_ENTROPY_THRESHOLD) {
        return true;
    }
    return false;
}

/** A key name is credential-shaped. */
function keyLooksCredential(key: string): boolean {
    return CREDENTIAL_KEY_PATTERNS.some(re => re.test(key));
}

export interface CredentialHit {
    key: string;
    reason: string;
}

/**
 * Scan a serialised bundle for credential shapes. Returns the hits (empty =
 * clean). The exporter refuses to write on any hit.
 */
export function scanBundleForCredentials(bundle: TransferBundle): CredentialHit[] {
    const hits: CredentialHit[] = [];
    for (const [key, value] of Object.entries(bundle.settings || {})) {
        if (keyLooksCredential(key)) {
            hits.push({ key, reason: 'key name matches credential pattern' });
            continue;
        }
        if (typeof value === 'string' && valueLooksCredential(value)) {
            hits.push({ key, reason: 'value matches credential shape' });
        }
    }
    // Card fields are user-authored prose / paths; scan them too so a pasted
    // token in a tag or project name is caught.
    for (const card of bundle.cards || []) {
        const fields: Array<[string, string]> = [
            ['project', card.project || ''],
            ['tags', card.tags || ''],
            ['repoScope', card.repoScope || ''],
        ];
        for (const [field, val] of fields) {
            if (val && valueLooksCredential(val)) {
                hits.push({ key: `cards[].${field} (${card.planFile})`, reason: 'value matches credential shape' });
            }
        }
    }
    return hits;
}

// ── Service ───────────────────────────────────────────────────────────────

export interface TransferBundleServiceDeps {
    db: KanbanDatabase;
    getWorkspaceRoot: () => string;
    log?: (msg: string) => void;
}

export class TransferBundleService {
    private _deps: TransferBundleServiceDeps;

    constructor(deps: TransferBundleServiceDeps) {
        this._deps = deps;
    }

    private _log(msg: string): void {
        (this._deps.log || (() => {}))(`[TransferBundle] ${msg}`);
    }

    // ── Export ────────────────────────────────────────────────────────────

    /**
     * Build and write the transfer bundle. Default location is
     * `~/.switchboard/transfer/switchboard-transfer.json` (outside the repo so
     * it cannot be committed). If `outPath` is inside the repo, a one-time
     * warning is emitted that the file is committable and carries personal
     * settings.
     */
    public async exportBundle(opts?: { outPath?: string }): Promise<ExportResult> {
        const db = this._deps.db;
        const root = this._deps.getWorkspaceRoot();
        try {
            const workspaceId = await db.getWorkspaceId();
            if (!workspaceId) {
                return { success: false, cardCount: 0, settingCount: 0, credentialCount: 0, untrackedPlanFiles: [], unpushedCommits: 0, error: 'No workspace ID resolved.' };
            }

            const plans = await db.getBoard(workspaceId);

            // Resolve feature planId → relative featureFile for the featureFile field.
            const featureIdToPlanFile = new Map<string, string>();
            for (const p of plans) {
                if (p.isFeature === 1 || p.isFeature === true) {
                    const rel = p.planFile ? path.relative(root, p.planFile).replace(/\\/g, '/') : p.planFile;
                    featureIdToPlanFile.set(p.planId, rel || '');
                }
            }

            const cards: TransferCardEntry[] = plans.map(p => {
                const relPlanFile = p.planFile ? path.relative(root, p.planFile).replace(/\\/g, '/') : p.planFile;
                const featureFile = p.featureId ? (featureIdToPlanFile.get(p.featureId) ?? null) : null;
                return {
                    planFile: relPlanFile || '',
                    column: p.kanbanColumn || 'CREATED',
                    project: p.project || '',
                    complexity: p.complexity || 'Unknown',
                    isFeature: !!(p.isFeature === 1 || p.isFeature === true),
                    featureFile,
                    tags: p.tags || '',
                    repoScope: p.repoScope || '',
                    priority: !!(p.priorityStarred === 1 || p.priorityStarred === true),
                };
            });

            // Settings: classify every config row, keep portable ones.
            const allConfig = await db.getAllConfig();
            const settings: Record<string, string> = {};
            for (const { key, value } of allConfig) {
                if (isPortableForTransfer(classifyConfigKey(key))) {
                    settings[key] = value;
                }
            }

            const bundle: TransferBundle = {
                schema: TRANSFER_BUNDLE_SCHEMA,
                exportedAt: new Date().toISOString(),
                sourceWorkspaceName: path.basename(root),
                cards,
                settings,
            };

            // Self-assertion BEFORE write: refuse if the serialised bundle
            // matches a credential shape, regardless of the allowlist.
            const hits = scanBundleForCredentials(bundle);
            if (hits.length > 0) {
                const detail = hits.map(h => `${h.key} (${h.reason})`).join('; ');
                this._log(`Credential guard refused export: ${detail}`);
                return {
                    success: false,
                    cardCount: cards.length,
                    settingCount: Object.keys(settings).length,
                    credentialCount: hits.length,
                    untrackedPlanFiles: [],
                    unpushedCommits: 0,
                    error: `Refused to write: credential-shaped value(s) detected in bundle: ${detail}`,
                };
            }

            // git pre-flight: untracked / unpushed plan + feature files would
            // not be on the destination, so their cards silently land in the
            // skipped list. Warn loudly with the count and paths.
            const preflight = await this._gitPreflight(root);

            // Resolve output path.
            const outPath = this._resolveExportPath(root, opts?.outPath);
            await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
            const tmpPath = outPath + '.tmp';
            await fs.promises.writeFile(tmpPath, JSON.stringify(bundle, null, 2), 'utf8');
            await fs.promises.rename(tmpPath, outPath);

            // Warn once if the path is inside the repo (committable + personal).
            if (this._isPathInsideRepo(root, outPath)) {
                this._log(`WARNING: ${outPath} is inside the repo and is committable. It carries personal-portable settings — do not commit it.`);
            }

            const scpLine = this._buildScpLine(outPath);

            this._log(`Wrote ${outPath} — ${cards.length} cards · ${Object.keys(settings).length} settings · 0 credentials`);
            if (preflight.untrackedPlanFiles.length > 0 || preflight.unpushedCommits > 0) {
                this._log(`WARNING: ${preflight.untrackedPlanFiles.length} untracked plan/feature file(s) and ${preflight.unpushedCommits} unpushed commit(s) — push first or those cards will not resolve on the destination.`);
            }

            return {
                success: true,
                path: outPath,
                cardCount: cards.length,
                settingCount: Object.keys(settings).length,
                credentialCount: 0,
                untrackedPlanFiles: preflight.untrackedPlanFiles,
                unpushedCommits: preflight.unpushedCommits,
                scpLine,
            };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._log(`exportBundle error: ${msg}`);
            return { success: false, cardCount: 0, settingCount: 0, credentialCount: 0, untrackedPlanFiles: [], unpushedCommits: 0, error: msg };
        }
    }

    private _resolveExportPath(root: string, requested?: string): string {
        if (requested && requested.trim()) {
            return path.resolve(requested.trim());
        }
        const dir = path.join(os.homedir(), '.switchboard', 'transfer');
        return path.join(dir, TRANSFER_BUNDLE_FILENAME);
    }

    private _isPathInsideRepo(root: string, filePath: string): boolean {
        const rel = path.relative(root, filePath);
        return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    }

    private _buildScpLine(outPath: string): string {
        const host = os.hostname();
        const user = os.userInfo().username;
        return `scp ${user}@${host}:${outPath} switchboard-transfer.json`;
    }

    private async _gitPreflight(root: string): Promise<{ untrackedPlanFiles: string[]; unpushedCommits: number }> {
        const untrackedPlanFiles: string[] = [];
        let unpushedCommits = 0;
        try {
            // Only run if this is a git repo.
            await fs.promises.access(path.join(root, '.git')).catch(() => null);
            const hasGit = fs.existsSync(path.join(root, '.git'));
            if (!hasGit) return { untrackedPlanFiles, unpushedCommits };

            const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd: root, timeout: 15000 });
            const plansDir = path.join('.switchboard', 'plans').replace(/\\/g, '/');
            const featuresDir = path.join('.switchboard', 'features').replace(/\\/g, '/');
            for (const line of statusOut.split('\n')) {
                if (!line.trim()) continue;
                // Porcelain format: XY <path>. Untracked = "?? <path>".
                const filePath = line.slice(3).trim().replace(/"/g, '');
                const norm = filePath.replace(/\\/g, '/');
                if (norm.startsWith(plansDir) || norm.startsWith(featuresDir)) {
                    untrackedPlanFiles.push(norm);
                }
            }

            // Unpushed commits touching plans/features. Pathspec-filtered so the
            // count is of COMMITS (one per --oneline line), not files, and only
            // commits that actually touch the plans/features directories.
            try {
                const { stdout: logOut } = await execFileAsync(
                    'git',
                    ['log', '@{u}..HEAD', '--oneline', '--', plansDir, featuresDir],
                    { cwd: root, timeout: 15000 }
                );
                unpushedCommits = logOut.split('\n').filter(l => l.trim().length > 0).length;
            } catch {
                // No upstream configured ( @{u} errors ) — treat as 0 unpushed.
            }
        } catch {
            // git not available or not a repo — no preflight signal.
        }
        return { untrackedPlanFiles, unpushedCommits };
    }

    // ── Import ────────────────────────────────────────────────────────────

    /**
     * Read a transfer bundle and upsert its cards onto the destination by
     * `planFile`. NEVER creates a row — a card whose planFile does not exist on
     * the destination is collected and reported. Machine-local fields on
     * matched rows are left exactly as the destination has them. Applies the
     * allowlisted settings and reports which keys were excluded.
     */
    public async importBundle(bundlePath: string): Promise<ImportResult> {
        const db = this._deps.db;
        const root = this._deps.getWorkspaceRoot();
        try {
            await fs.promises.access(bundlePath);
        } catch {
            return { success: false, cardsUpdated: 0, cardsSkipped: [], settingsApplied: [], settingsExcluded: [], error: `Bundle not found: ${bundlePath}` };
        }

        let bundle: TransferBundle;
        try {
            const raw = await fs.promises.readFile(bundlePath, 'utf8');
            bundle = JSON.parse(raw);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { success: false, cardsUpdated: 0, cardsSkipped: [], settingsApplied: [], settingsExcluded: [], error: `Failed to parse bundle: ${msg}` };
        }

        if (!bundle || typeof bundle !== 'object' || bundle.schema !== TRANSFER_BUNDLE_SCHEMA) {
            return { success: false, cardsUpdated: 0, cardsSkipped: [], settingsApplied: [], settingsExcluded: [], error: `Unsupported bundle schema (expected ${TRANSFER_BUNDLE_SCHEMA}).` };
        }

        // Credential guard on import too — a hand-edited or tampered bundle
        // must not write a credential into the config table.
        const hits = scanBundleForCredentials(bundle);
        if (hits.length > 0) {
            const detail = hits.map(h => `${h.key} (${h.reason})`).join('; ');
            this._log(`Credential guard refused import: ${detail}`);
            return { success: false, cardsUpdated: 0, cardsSkipped: [], settingsApplied: [], settingsExcluded: [], error: `Refused to import: credential-shaped value(s) detected: ${detail}` };
        }

        const workspaceId = await db.getWorkspaceId();
        if (!workspaceId) {
            return { success: false, cardsUpdated: 0, cardsSkipped: [], settingsApplied: [], settingsExcluded: [], error: 'No workspace ID resolved.' };
        }

        const cards = Array.isArray(bundle.cards) ? bundle.cards : [];
        let cardsUpdated = 0;
        const cardsSkipped: ImportCardOutcome[] = [];

        // First pass: features must resolve before subtasks link to them, so
        // process feature cards first (isFeature === true), then the rest.
        const sortedCards = [...cards].sort((a, b) => Number(!!b.isFeature) - Number(!!a.isFeature));

        for (const card of sortedCards) {
            const planFile = String(card.planFile || '').trim();
            if (!planFile) {
                cardsSkipped.push({ planFile: '', matched: false, reason: 'empty planFile' });
                continue;
            }
            // Reuse the SAME plan-file resolution helper restoreFromBackup and
            // linkFeatureSubtasksByPaths use — never duplicate the matching.
            const existing = await db.getPlanByPlanFile(planFile, workspaceId);
            if (!existing) {
                cardsSkipped.push({ planFile, matched: false, reason: 'plan file not in this checkout' });
                continue;
            }

            // Column — validate via movePlanByPlanFile (handles custom columns).
            const column = String(card.column || '').trim();
            if (column && column !== existing.kanbanColumn) {
                await db.movePlanByPlanFile(planFile, workspaceId, column);
            }

            // Project — resolve-only (updatePlanProjectByPlanFileInvariant uses
            // resolveProjectId, which returns null on unknown). Bypass the
            // subtask guard: the feature link below governs the subtask's
            // project, and the import is restoring the source's intent.
            const project = String(card.project || '').trim();
            if (project && project !== (existing.project || '')) {
                try {
                    await db.updatePlanProjectByPlanFileInvariant(planFile, workspaceId, project, { bypassSubtaskGuard: true });
                } catch (e) {
                    this._log(`project update failed for ${planFile}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }

            // Complexity — skip for features (derived).
            const complexity = String(card.complexity || '').trim();
            if (complexity && !(existing.isFeature === 1 || existing.isFeature === true)) {
                await db.updateComplexityByPlanFile(planFile, workspaceId, complexity);
            }

            // Tags.
            const tags = String(card.tags || '');
            if (tags !== (existing.tags || '')) {
                await db.updateTagsByPlanFile(planFile, workspaceId, tags);
            }

            // repoScope.
            const repoScope = String(card.repoScope || '');
            if (repoScope !== (existing.repoScope || '')) {
                await db.updateRepoScopeByPlanFile(planFile, workspaceId, repoScope);
            }

            // Priority (starred) — by planId.
            const starred = !!card.priority;
            const currentlyStarred = !!(existing.priorityStarred === 1 || existing.priorityStarred === true);
            if (starred !== currentlyStarred) {
                await db.setPriorityStarred(existing.planId, workspaceId, starred);
            }

            // Feature link — resolve featureFile to the destination's own
            // feature planId, then link the subtask. Only for non-feature cards.
            if (!card.isFeature && card.featureFile) {
                const featureFile = String(card.featureFile).trim();
                const featureRow = await db.getPlanByPlanFile(featureFile, workspaceId);
                if (featureRow && (featureRow.isFeature === 1 || featureRow.isFeature === true)) {
                    if (existing.featureId !== featureRow.planId) {
                        await db.updateFeatureStatus(existing.planId, 0, featureRow.planId);
                    }
                } else {
                    this._log(`featureFile ${featureFile} not found as a feature on destination; skipping feature link for ${planFile}`);
                }
            }

            cardsUpdated++;
        }

        // Settings — apply allowlisted keys, report excluded ones.
        const settingsApplied: string[] = [];
        const settingsExcluded: string[] = [];
        const settings = (bundle.settings && typeof bundle.settings === 'object') ? bundle.settings : {};
        for (const [key, value] of Object.entries(settings)) {
            if (isPortableForTransfer(classifyConfigKey(key))) {
                await db.setConfig(key, String(value));
                settingsApplied.push(key);
            } else {
                settingsExcluded.push(key);
            }
        }

        this._log(`Imported: ${cardsUpdated} cards matched, ${cardsSkipped.length} skipped, ${settingsApplied.length} settings applied, ${settingsExcluded.length} excluded`);

        return {
            success: true,
            cardsUpdated,
            cardsSkipped,
            settingsApplied,
            settingsExcluded,
        };
    }
}
