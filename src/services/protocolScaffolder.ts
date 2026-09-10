/**
 * Host-neutral scaffolder for the managed Switchboard protocol block in a
 * workspace's `AGENTS.md` / `CLAUDE.md`.
 *
 * WHY THIS FILE EXISTS (do not re-inline it into `extension.ts`).
 * This logic used to live in `extension.ts` and reach the filesystem through
 * `vscode.workspace.fs`, which made it structurally unreachable from
 * `src/standalone/bootstrap.ts`. The consequence was not theoretical: the
 * protocol block was cut from 14,826 chars to ~600 in source on 2026-08-24, and
 * every standalone workspace kept the pre-cut 18KB block indefinitely, because
 * nothing on that host ever rewrote the file. Two separate cuts "did not stick"
 * for this reason alone.
 *
 * Everything here is plain `node:fs` with no other imports, so BOTH composition
 * roots can call it. Keep it that way: KanbanDatabase (and therefore the whole
 * ClaudeCodeMirrorService chain) imports `vscode`, which is only survivable on
 * the standalone host via the shim.
 * The vscode layer is a thin `Uri -> fsPath` adapter in `extension.ts`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

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

/** Boundary markers for the managed protocol block in AGENTS.md. */
export const AGENTS_PROTOCOL_HEADER = '# AGENTS.md - Switchboard Protocol';
export const AGENTS_BLOCK_START = '<!-- switchboard:agents-protocol:start -->';
export const AGENTS_BLOCK_END = '<!-- switchboard:agents-protocol:end -->';

export type ProtocolStatus = 'created' | 'appended' | 'skipped' | 'updated' | 'failed';

export interface ProtocolResult {
    status: ProtocolStatus;
    reason: string;
}

export interface ProtocolFileOptions {
    /** Target filename in the workspace root, e.g. `AGENTS.md` or `CLAUDE.md`. */
    targetFileName: string;
    blockStart: string;
    blockEnd: string;
    /** Header line used by the legacy-markerless heuristic — MUST be unique per target. */
    header: string;
    /** Optional preamble injected ABOVE the body inside the managed block. */
    preamble?: string;
    /**
     * Resident body for this target. Both targets pass RESIDENT_PROTOCOL_BODY:
     * one body, both hosts, deliberately — leaving either target on the bundled
     * source is what kept ~14,300 chars resident after the other was already cut.
     * Also the create-discriminator: a target with a bodyOverride is always
     * created as a managed block, never markerless.
     */
    bodyOverride?: string;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isFileNotFoundError(error: unknown): boolean {
    return typeof error === 'object' && error !== null
        && (error as { code?: unknown }).code === 'ENOENT';
}

function hasProtocolHeaderLine(content: string, header: string): boolean {
    const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escapedHeader}\\s*$`, 'm').test(content);
}

async function readFileOrNull(target: string): Promise<string | null> {
    try {
        return await fs.readFile(target, 'utf8');
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return null;
        }
        throw error;
    }
}

/**
 * Ensure a workspace protocol file contains the managed Switchboard protocol
 * block. Preserves user content outside the boundary markers. For legacy
 * markerless files (per-target header present, no markers) replaces the entire
 * file. Idempotent: skips when the block is already up to date.
 */
export async function ensureProtocolFile(
    workspaceRoot: string,
    bundleRoot: string,
    opts: ProtocolFileOptions
): Promise<ProtocolResult> {
    const { targetFileName, blockStart, blockEnd, header, preamble, bodyOverride } = opts;
    const sourcePath = path.join(bundleRoot, 'AGENTS.md');
    const targetPath = path.join(workspaceRoot, targetFileName);

    // The bundled source is still read so the legacy detection path has content
    // to reason about, even though both targets emit the compact resident body.
    let sourceContent: string;
    try {
        sourceContent = await fs.readFile(sourcePath, 'utf8');
    } catch (error) {
        return { status: 'failed', reason: `Bundled AGENTS.md source is missing or unreadable: ${getErrorMessage(error)}` };
    }

    const managedInner = buildManagedInner(sourceContent, preamble, bodyOverride);
    const managedBlock = `${blockStart}\n${managedInner}\n${blockEnd}`;
    const sourceForCreate = `${sourceContent.trimEnd()}\n`;

    let targetContent: string | null;
    try {
        targetContent = await readFileOrNull(targetPath);
    } catch (error) {
        return { status: 'failed', reason: `Failed to read existing ${targetFileName}: ${getErrorMessage(error)}` };
    }

    if (targetContent === null) {
        // A target carrying a bodyOverride MUST be created as a managed block: a
        // markerless create would emit the bundled source instead of the compact
        // body, and the legacy branch would wipe it on the next run.
        const createBody = (preamble || bodyOverride) ? `${managedBlock}\n` : sourceForCreate;
        try {
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, createBody, 'utf8');
            return { status: 'created', reason: `${targetFileName} created from bundled source` };
        } catch (e) {
            return { status: 'failed', reason: `Failed to write ${targetFileName}: ${getErrorMessage(e)}` };
        }
    }

    const hasBlockStart = targetContent.includes(blockStart);
    const hasBlockEnd = targetContent.includes(blockEnd);
    const blockStartIndex = targetContent.indexOf(blockStart);
    // First start marker + LAST end marker, so the managed region spans any
    // duplicated/stray markers an earlier buggy scaffold left behind; replacing
    // that whole span collapses them back to one clean block.
    const blockEndIndex = targetContent.lastIndexOf(blockEnd);
    const startMarkerCount = targetContent.split(blockStart).length - 1;
    const endMarkerCount = targetContent.split(blockEnd).length - 1;
    const hasDuplicateMarkers = startMarkerCount > 1 || endMarkerCount > 1;

    if ((hasBlockStart && !hasBlockEnd) || (!hasBlockStart && hasBlockEnd)
        || (hasBlockStart && hasBlockEnd && blockStartIndex > blockEndIndex)) {
        return {
            status: 'failed',
            reason: `Detected malformed managed protocol markers in ${targetFileName}; fix markers before rerunning setup`
        };
    }

    if (hasBlockStart && hasBlockEnd) {
        const existingBlockContent = targetContent.substring(
            blockStartIndex + blockStart.length,
            blockEndIndex
        ).trim();

        if (!hasDuplicateMarkers && existingBlockContent === managedInner.trim()) {
            return { status: 'skipped', reason: 'Switchboard protocol block already up-to-date' };
        }

        try {
            const before = targetContent.substring(0, blockStartIndex);
            const after = targetContent.substring(blockEndIndex + blockEnd.length);
            await fs.writeFile(targetPath, before + managedBlock + after, 'utf8');
            return {
                status: 'updated',
                reason: hasDuplicateMarkers
                    ? 'Collapsed duplicate protocol markers and updated block to latest bundled version'
                    : 'Switchboard protocol block updated to latest bundled version'
            };
        } catch (e) {
            return { status: 'failed', reason: `Failed to update ${targetFileName}: ${getErrorMessage(e)}` };
        }
    }

    if (hasProtocolHeaderLine(targetContent, header)) {
        // Legacy markerless file — fully scaffolded by an older build, so
        // replacing it wholesale is safe. Keyed on the PER-TARGET header.
        try {
            await fs.writeFile(targetPath, managedBlock + '\n', 'utf8');
            return { status: 'updated', reason: `Legacy markerless ${targetFileName} replaced with managed block` };
        } catch (e) {
            return { status: 'failed', reason: `Failed to replace legacy ${targetFileName}: ${getErrorMessage(e)}` };
        }
    }

    try {
        const separator = targetContent.endsWith('\n') ? '\n' : '\n\n';
        await fs.writeFile(targetPath, targetContent + separator + managedBlock + '\n', 'utf8');
        return { status: 'appended', reason: `Switchboard protocol block appended to existing ${targetFileName}` };
    } catch (e) {
        return { status: 'failed', reason: `Failed to append to ${targetFileName}: ${getErrorMessage(e)}` };
    }
}

/** Scaffold the AGENTS.md managed block (Antigravity host). */
export async function ensureAgentsProtocol(workspaceRoot: string, bundleRoot: string): Promise<ProtocolResult> {
    return ensureProtocolFile(workspaceRoot, bundleRoot, {
        targetFileName: 'AGENTS.md',
        blockStart: AGENTS_BLOCK_START,
        blockEnd: AGENTS_BLOCK_END,
        header: AGENTS_PROTOCOL_HEADER,
        bodyOverride: RESIDENT_PROTOCOL_BODY,
    });
}

/** Scaffold the CLAUDE.md managed block (Claude Code host). Same body as AGENTS.md. */
export async function ensureClaudeProtocol(workspaceRoot: string, bundleRoot: string): Promise<ProtocolResult> {
    return ensureProtocolFile(workspaceRoot, bundleRoot, {
        targetFileName: 'CLAUDE.md',
        blockStart: CLAUDE_BLOCK_START,
        blockEnd: CLAUDE_BLOCK_END,
        // Legacy-markerless detector key only — NOT emitted into new blocks.
        header: CLAUDE_PROTOCOL_HEADER,
        bodyOverride: RESIDENT_PROTOCOL_BODY,
    });
}

/**
 * Scaffold the selected protocol layers for a workspace root. Each target is
 * independently marker-managed, so running both is safe and idempotent.
 * Called by BOTH composition roots — `extension.ts` and `bootstrap.ts`.
 */
export async function scaffoldProtocolLayers(
    workspaceRoot: string,
    bundleRoot: string,
    targets: { agents: boolean; claude: boolean },
    log?: (line: string) => void
): Promise<void> {
    if (targets.agents) {
        try {
            const r = await ensureAgentsProtocol(workspaceRoot, bundleRoot);
            log?.(`AGENTS.md: ${r.status} — ${r.reason}`);
        } catch (e) {
            log?.(`AGENTS.md scaffolding error (non-fatal): ${getErrorMessage(e)}`);
        }
    }
    if (targets.claude) {
        try {
            const r = await ensureClaudeProtocol(workspaceRoot, bundleRoot);
            log?.(`CLAUDE.md: ${r.status} — ${r.reason}`);
        } catch (e) {
            log?.(`CLAUDE.md scaffolding error (non-fatal): ${getErrorMessage(e)}`);
        }
    }
}
