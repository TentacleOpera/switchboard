import * as os from 'os';
import * as path from 'path';

/**
 * Single source of truth for Plan Scanner IDE presets.
 *
 * Two shapes:
 *  - 'brain': per-session subdirectories with a fixed filename. Used ONLY by
 *    Antigravity. Antigravity has THREE explicit roots — antigravity,
 *    antigravity-ide and antigravity-cli — NOT a wildcard (a `antigravity*`
 *    glob would wrongly match antigravity-backup / antigravity-browser-profile).
 *    Brain claiming (claim markers, tombstones, anti-flood guards) is handled by
 *    TaskViewerProvider._getAntigravityRoots()/_rescanAntigravityPlanSources,
 *    which remains the authoritative source of those three roots; this preset
 *    only carries the enable flag + display metadata.
 *  - 'flat': flat folders of *.md plan files (Windsurf/Devin, Cursor, Claude
 *    Code, and user custom sources). Imported via the generic plan importer.
 *
 * Path tokens used in flat globs:
 *  - '~'      → os.homedir()
 *  - '<repo>' → each workspace root (expanded per-root at scan time)
 */
export type PlanScannerShape = 'brain' | 'flat';
export type PlanScannerScope = 'global' | 'workspace';

export interface PlanScannerGlob {
    scope: PlanScannerScope;
    /** Glob pattern ending in a filename pattern, e.g. '~/.cursor/plans/*.md'. */
    pattern: string;
}

export interface PlanScannerPreset {
    id: string;
    label: string;
    shape: PlanScannerShape;
    /** Config key suffix under 'switchboard.planScanner', e.g. 'presets.cursor'. */
    configKey: string;
    /** Flat-shape glob templates. Empty for brain shape (roots come from _getAntigravityRoots). */
    globs: PlanScannerGlob[];
}

export const PLAN_SCANNER_PRESETS: PlanScannerPreset[] = [
    {
        id: 'antigravity',
        label: 'Google Antigravity',
        shape: 'brain',
        configKey: 'presets.antigravity',
        // Brain roots are the explicit three from TaskViewerProvider._getAntigravityRoots():
        //   ~/.gemini/antigravity, ~/.gemini/antigravity-ide, ~/.gemini/antigravity-cli
        // (NOT a wildcard). Left empty here so there is no second, divergent definition.
        globs: [],
    },
    {
        id: 'windsurfDevin',
        label: 'Windsurf / Devin',
        shape: 'flat',
        configKey: 'presets.windsurfDevin',
        globs: [
            { scope: 'global', pattern: '~/.devin/plans/*.md' },
            { scope: 'global', pattern: '~/.windsurf/plans/*.md' },
            { scope: 'workspace', pattern: '<repo>/.devin/plans/*.md' },
            { scope: 'workspace', pattern: '<repo>/.windsurf/plans/*.md' },
        ],
    },
    {
        id: 'cursor',
        label: 'Cursor',
        shape: 'flat',
        configKey: 'presets.cursor',
        globs: [
            { scope: 'global', pattern: '~/.cursor/plans/*.md' },
            { scope: 'workspace', pattern: '<repo>/.cursor/plans/*.md' },
        ],
    },
    {
        id: 'claudeCode',
        label: 'Claude Code',
        shape: 'flat',
        configKey: 'presets.claudeCode',
        globs: [
            { scope: 'global', pattern: '~/.claude/plans/*.md' },
            { scope: 'workspace', pattern: '<repo>/.claude/plans/*.md' },
        ],
    },
];

/** A resolved flat scan target: a concrete directory plus the filename suffix to match. */
export interface ResolvedFlatTarget {
    /** Absolute directory to scan (non-recursively, unless pattern used '**'). */
    dir: string;
    /** Lowercased filename extension/suffix to match, e.g. '.md'. */
    suffix: string;
    /** True if the pattern requested a recursive ('**') descent. */
    recursive: boolean;
}

/**
 * Expand a flat glob pattern into concrete scan targets.
 * Handles '~' (home) and '<repo>' (one target per repo root) tokens, and splits
 * the trailing filename pattern (e.g. '*.md', 'PLANS.md', '** /tasks.md') off the
 * directory portion.
 */
export function expandFlatGlob(pattern: string, repoRoots: string[]): ResolvedFlatTarget[] {
    let p = pattern.trim();
    if (!p) { return []; }

    // Expand home
    if (p.startsWith('~')) {
        p = path.join(os.homedir(), p.slice(1));
    }

    // Expand <repo> into one pattern per workspace root
    const expandedPatterns = p.includes('<repo>')
        ? repoRoots.map(r => p.replace(/<repo>/g, r))
        : [p];

    const targets: ResolvedFlatTarget[] = [];
    for (const ep of expandedPatterns) {
        // Split off the filename portion (last path segment containing a glob/filename).
        const dir = path.dirname(ep);
        const base = path.basename(ep);
        const recursive = ep.includes('**');
        // For '**' patterns, scan from the segment before '**'.
        let scanDir = dir;
        const dblStar = ep.indexOf('**');
        if (dblStar >= 0) {
            scanDir = ep.slice(0, dblStar).replace(/[\\/]+$/, '');
        }
        // Derive a suffix to match: extension if base has one, else the literal base.
        const ext = path.extname(base);
        const suffix = ext ? ext.toLowerCase() : base.toLowerCase();
        targets.push({ dir: scanDir, suffix, recursive });
    }
    return targets;
}
