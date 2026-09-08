/**
 * tmux team seating — seats a team's members as panes in a tmux session
 * Switchboard creates and owns, instead of as children of the PTY fleet.
 *
 * This module provides the tmux `createHeadWithDelegates` callback that
 * `instantiateAgentGroupCore` calls when the `terminalBackend` setting is
 * `'tmux'`. The shared `instantiateAgentGroupCore` flow — caps pre-flight,
 * standing orders, group registration, wiring — runs unchanged for both
 * backends. Only the callback and the `onCreated` registry update branch on
 * the backend.
 *
 * Layout: one tmux window per team lead, titled for the team. The team's
 * coders and intern are panes inside their lead's window (via `split-window`).
 * A client sees the lead as the top-level thing; `prefix n` / `prefix p`
 * cycles between leads one full-screen at a time. Coders remain seated,
 * running and durable — they are simply not what the top level shows.
 *
 * Reconnect: if the session exists AND its panes match the team's roster
 * (by pane_title), reattach — update the registry, mark seats live. If the
 * session exists but the panes do not match, refuse with a message naming
 * the collision. This is reattachment to a session Switchboard created, not
 * adoption of an arbitrary user session.
 */

import {
    run,
    isTmuxAvailable,
    listTmuxPanes,
    tmuxCaps,
    validatePaneId,
    TMUX_IDE_NAME,
    type TmuxSocket,
    TmuxTerminalHandle,
} from './tmuxBackend';
import { sendPromptToTmux } from './tmuxPromptDelivery';
import { TMUX_OWNER_SEAT } from './tmuxFleetService';
import {
    deriveTmuxSessionName,
    deriveSeatName,
    deriveDelegateBaseName,
    deriveSharedMemberName,
} from '../services/teamWiring';
import type { AgentGroupCreateResult } from '../services/agentGroupInstantiation';
import { MAX_DELEGATES_PER_PARENT } from '../services/ptyLimits';

// ─── Types ────────────────────────────────────────────────────────────────

export interface TmuxSeatingSpec {
    role: string;
    name: string;
    cwd: string;
    delegates: any[];
    teamName?: string;
}

export interface TmuxSeatingOptions {
    socket?: TmuxSocket;
    /** The DB to write `runtime.terminals` into. */
    db?: any;
}

interface SeatedPane {
    friendlyName: string;
    paneId: string;
    role: string;
    status: string;
    cwd?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Check whether a tmux session exists. Returns true/false, never throws.
 */
async function hasSession(sessionName: string, socket?: TmuxSocket): Promise<boolean> {
    try {
        await run(['has-session', '-t', sessionName], socket);
        return true;
    } catch {
        return false;
    }
}

/**
 * Set a pane's title via `select-pane -t %id -T <title>`. The title is what
 * `listTmuxPanes` reads as `pane_title` — the natural place for the member's
 * friendly name, and what the reconnect roster-match checks against.
 */
async function setPaneTitle(paneId: string, title: string, socket?: TmuxSocket): Promise<void> {
    validatePaneId(paneId);
    await run(['select-pane', '-t', paneId, '-T', title], socket);
}

/**
 * Kill a tmux session and all its panes. Used for cleanup on partial-failure.
 */
async function killSession(sessionName: string, socket?: TmuxSocket): Promise<void> {
    try { await run(['kill-session', '-t', sessionName], socket); } catch { /* already gone */ }
}

// ─── Roster derivation ────────────────────────────────────────────────────

/**
 * Derive the expected roster of friendly names for a team spec, using the
 * shared name-derivation helpers. This MUST produce the same names the PTY
 * fleet path would produce — dispatch attribution and completion reports
 * key on the name.
 *
 * Returns `{ headName, delegates: [{ friendlyName, role, def, index }] }`.
 */
function deriveRoster(spec: TmuxSeatingSpec): {
    headName: string;
    delegates: Array<{ friendlyName: string; role: string; def: any; index: number; shared: boolean }>;
} {
    const teamName = spec.teamName || spec.name || 'team';
    const taken = new Set<string>();
    const headName = deriveSeatName(spec.name, spec.role, taken);

    const delegates: Array<{ friendlyName: string; role: string; def: any; index: number; shared: boolean }> = [];
    for (const def of spec.delegates) {
        const count = Math.max(1, Math.min(def?.count || 1, MAX_DELEGATES_PER_PARENT));
        const isShared = def?.scope === 'shared';
        for (let i = 0; i < count; i++) {
            const baseName = isShared
                ? deriveSharedMemberName(teamName, def, i)
                : deriveDelegateBaseName(headName, def, i);
            const friendlyName = deriveSeatName(baseName, def.role, taken);
            delegates.push({ friendlyName, role: def.role, def, index: i, shared: isShared });
        }
    }
    return { headName, delegates };
}

// ─── Reconnect check ──────────────────────────────────────────────────────

/**
 * Check whether a surviving session's panes match the expected roster.
 * Returns `{ reattach: true, panes }` on match, `{ reattach: false, reason }`
 * on mismatch.
 */
async function checkReconnect(
    sessionName: string,
    expectedHead: string,
    headRole: string,
    expectedDelegates: Array<{ friendlyName: string; role: string }>,
    socket?: TmuxSocket
): Promise<{ reattach: boolean; panes?: SeatedPane[]; reason?: string }> {
    const expectedDelegateNames = expectedDelegates.map(d => d.friendlyName);
    // Role by name, from the roster we just derived. A reattached seat MUST keep
    // the role it was seated with: `triggerAction` resolves a dispatch target by
    // role, so flattening every delegate to 'coder' on reattach silently routed
    // reviewer/intern work to a coder seat after any Switchboard restart.
    const roleByName = new Map<string, string>([[expectedHead, headRole]]);
    for (const d of expectedDelegates) { roleByName.set(d.friendlyName, d.role); }
    const allPanes = await listTmuxPanes(socket);
    const sessionPanes = allPanes.filter(p => p.sessionName === sessionName);
    if (sessionPanes.length === 0) {
        // Session exists (has-session passed) but no panes — corrupted session.
        return { reattach: false, reason: `Session '${sessionName}' exists but has no panes` };
    }

    const expectedNames = new Set<string>([expectedHead, ...expectedDelegateNames]);
    const actualNames = new Set(sessionPanes.map(p => p.paneTitle));

    // Every expected name must be present. Extra panes are allowed (a
    // manually-added pane is not a mismatch — the roster is a subset check,
    // not an exact-count check, so an operator who added a scratch pane
    // does not lose their team).
    for (const name of expectedNames) {
        if (!actualNames.has(name)) {
            return {
                reattach: false,
                reason: `Session '${sessionName}' already exists with different panes — refusing to adopt. Expected '${name}' but found titles: ${[...actualNames].join(', ')}. Use a different team name or kill the session first.`,
            };
        }
    }

    // Map panes to seated entries by title.
    const panes: SeatedPane[] = [];
    for (const p of sessionPanes) {
        if (expectedNames.has(p.paneTitle)) {
            panes.push({
                friendlyName: p.paneTitle,
                paneId: p.paneId,
                role: roleByName.get(p.paneTitle) || 'coder',
                status: 'active',
                cwd: p.paneCurrentPath,
            });
        }
    }
    return { reattach: true, panes };
}

// ─── createTmuxHeadWithDelegates ──────────────────────────────────────────

/**
 * tmux `createHeadWithDelegates` callback. Creates a tmux session with one
 * window per lead and split panes for delegates, OR reattaches to a surviving
 * session with matching pane titles.
 *
 * Returns `AgentGroupCreateResult` — the same shape the fleet callback returns.
 */
export async function createTmuxHeadWithDelegates(
    spec: TmuxSeatingSpec,
    opts?: TmuxSeatingOptions
): Promise<AgentGroupCreateResult> {
    const socket = opts?.socket;

    // Availability check — no silent fleet fallback.
    const available = await isTmuxAvailable(socket);
    if (!available) {
        return {
            success: false,
            error: 'tmux backend selected but tmux is not available. Check the "switchboard.terminalBackend" setting.',
        };
    }

    const teamName = spec.teamName || spec.name || 'team';
    const sessionName = deriveTmuxSessionName(teamName);
    const { headName, delegates: delegateSpecs } = deriveRoster(spec);

    // ── Reconnect check ────────────────────────────────────────────────
    if (await hasSession(sessionName, socket)) {
        const reconnect = await checkReconnect(
            sessionName,
            headName,
            spec.role,
            delegateSpecs.map(d => ({ friendlyName: d.friendlyName, role: d.role })),
            socket
        );
        if (!reconnect.reattach) {
            return { success: false, error: reconnect.reason! };
        }
        const panes = reconnect.panes!;
        const headPane = panes.find(p => p.friendlyName === headName);
        const delegatePanes = panes.filter(p => p.friendlyName !== headName);

        // Reattach: no new panes created, so createdDelegates is empty.
        // Update the registry if a db was provided.
        if (opts?.db) {
            await updateTmuxRegistryState(opts.db, sessionName, panes, socket);
        }

        return {
            success: true,
            terminal: { friendlyName: headName, paneId: headPane?.paneId, sessionName, status: 'active' },
            delegates: delegatePanes.map(p => ({
                friendlyName: p.friendlyName,
                paneId: p.paneId,
                role: p.role,
                status: 'active',
                sessionName,
            })),
            createdDelegates: [],
        };
    }

    // ── Fresh creation ─────────────────────────────────────────────────
    // One window per lead, titled for the team. The first pane is the head.
    // Delegates are split panes inside the same window.
    let headPaneId: string;
    try {
        // new-session creates the session with one window and one pane.
        const newSessionArgs = ['new-session', '-d', '-s', sessionName, '-n', headName];
        if (spec.cwd) { newSessionArgs.push('-c', spec.cwd); }
        newSessionArgs.push('-P', '-F', '#{pane_id}');
        headPaneId = (await run(newSessionArgs, socket)).trim();
        validatePaneId(headPaneId);
        await setPaneTitle(headPaneId, headName, socket);
    } catch (err) {
        return { success: false, error: `Failed to create tmux session '${sessionName}': ${err instanceof Error ? err.message : String(err)}` };
    }

    const seatedPanes: SeatedPane[] = [
        { friendlyName: headName, paneId: headPaneId, role: spec.role, status: 'active', cwd: spec.cwd },
    ];
    const createdDelegateNames: string[] = [];

    // Create delegate panes via split-window inside the head's window.
    for (const d of delegateSpecs) {
        try {
            // split-window adds a pane to the head's window. Target the head
            // PANE ID, not `<session>:0` — `base-index` is a user setting and is
            // commonly 1, in which case the new session's only window is index 1
            // and `<session>:0` resolves to nothing. Every delegate split then
            // failed, the partial-failure arm killed the session, and tmux team
            // seating never succeeded on such a host. A `%id` is absolute.
            const splitArgs = ['split-window', '-t', headPaneId, '-d'];
            if (spec.cwd) { splitArgs.push('-c', spec.cwd); }
            splitArgs.push('-P', '-F', '#{pane_id}');
            const delegatePaneId = (await run(splitArgs, socket)).trim();
            validatePaneId(delegatePaneId);
            await setPaneTitle(delegatePaneId, d.friendlyName, socket);
            // Re-tile after each split. Without it tmux halves the target pane
            // every time and refuses with "no space for new pane" at around the
            // fourth delegate — a roster-size-dependent failure that the
            // partial-failure arm then escalates into killing the whole session.
            try { await run(['select-layout', '-t', headPaneId, 'tiled'], socket); } catch { /* layout is cosmetic */ }
            seatedPanes.push({
                friendlyName: d.friendlyName,
                paneId: delegatePaneId,
                role: d.role,
                status: 'active',
                cwd: spec.cwd,
            });
            createdDelegateNames.push(d.friendlyName);
        } catch (err) {
            // Partial failure: kill the session and return failure. No
            // partial team left running — the tmux analogue of the fleet's
            // "no orphan agent CLI" principle.
            await killSession(sessionName, socket);
            return {
                success: false,
                error: `Failed to create delegate pane '${d.friendlyName}': ${err instanceof Error ? err.message : String(err)}`,
                delegateError: `Failed to create delegate pane '${d.friendlyName}': ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    // ── Startup commands ──────────────────────────────────────────────
    // For each member with a startupCommand, send it via sendPromptToTmux.
    // Mirrors the fleet's injectStartupCommand path.
    const caps = await tmuxCaps(socket);
    for (const d of delegateSpecs) {
        const startupCommand = d.def?.startupCommand;
        if (typeof startupCommand === 'string' && startupCommand.trim()) {
            const pane = seatedPanes.find(p => p.friendlyName === d.friendlyName);
            if (pane) {
                try {
                    const handle = new TmuxTerminalHandle(d.friendlyName, pane.paneId, socket);
                    // standingOrders: false — a startup SHELL COMMAND, not a
                    // prompt to an agent. Orders ride prompts; appending a block
                    // to a shell command would execute as arguments.
                    await sendPromptToTmux(handle, startupCommand, { clearBeforePrompt: false, standingOrders: false });
                } catch {
                    // Startup command failure is non-fatal — the pane exists
                    // and is registered. The operator can send the command
                    // manually. Mirrors the fleet's silent-fallback behavior.
                }
            }
        }
    }

    // ── Registry update ───────────────────────────────────────────────
    if (opts?.db) {
        await updateTmuxRegistryState(opts.db, sessionName, seatedPanes, socket);
    }

    return {
        success: true,
        terminal: { friendlyName: headName, paneId: headPaneId, sessionName, status: 'active' },
        delegates: seatedPanes
            .filter(p => p.friendlyName !== headName)
            .map(p => ({
                friendlyName: p.friendlyName,
                paneId: p.paneId,
                role: p.role,
                status: 'active',
                sessionName,
            })),
        createdDelegates: createdDelegateNames,
    };
}

// ─── Registry update ──────────────────────────────────────────────────────

/**
 * Update `runtime.terminals` with the current tmux panes, preserving entries
 * from other backends. Mirrors `PtyFleetService.updateRegistryState()`:
 * replace entries where `ideName === TMUX_IDE_NAME`, preserve everything else.
 */
export async function updateTmuxRegistryState(
    db: any,
    sessionName: string,
    panes: SeatedPane[],
    socket?: TmuxSocket
): Promise<void> {
    if (!db) { return; }
    try {
        const existing = await db.getConfigJson('runtime.terminals', {}) || {};
        const terminalMap: Record<string, any> = {};
        // Preserve entries from other backends AND from the OTHER tmux writer.
        // `TmuxFleetService` (Part 2 pane adoption) also writes rows tagged
        // `ideName: 'switchboard-tmux'`. Claiming every tmux row here deleted
        // every adopted pane on each team seating (and the adoption fleet
        // returned the favour on its next write). `tmuxOwner` is the
        // discriminator: this writer owns 'seat' rows only.
        for (const [name, entry] of Object.entries(existing)) {
            const e = entry as any;
            if (e && e.ideName === TMUX_IDE_NAME && e.tmuxOwner === TMUX_OWNER_SEAT) { continue; }
            terminalMap[name] = entry;
        }
        // Add tmux entries.
        for (const p of panes) {
            terminalMap[p.friendlyName] = {
                friendlyName: p.friendlyName,
                role: p.role,
                status: p.status,
                paneId: p.paneId,
                sessionName,
                ideName: TMUX_IDE_NAME,
                purpose: 'tmux',
                tmuxOwner: TMUX_OWNER_SEAT,
                cwd: p.cwd,
            };
        }
        await db.setConfigJson('runtime.terminals', terminalMap);
    } catch (err) {
        console.warn('[tmuxTeamSeating] Failed to update terminal registry state:', err);
    }
}

// ─── Liveness reconcile poll ──────────────────────────────────────────────

/**
 * Start a periodic reconcile poll that detects tmux pane death by comparing
 * `listTmuxPanes()` against `runtime.terminals` entries with
 * `ideName === TMUX_IDE_NAME`. Dead panes are marked `status: 'exited'`.
 *
 * tmux has no event stream — the fleet uses `ptyProcess.onExit`, but tmux
 * pane death must be detected by polling. The poll is `.unref()`'d so it
 * doesn't hold the process open, and swallows all errors (a failed poll is
 * a missed death detection, not a crash).
 */
export function startTmuxReconcilePoll(
    db: any,
    intervalMs: number = 5000,
    socket?: TmuxSocket
): { stop: () => void } {
    const timer = setInterval(async () => {
        try {
            const existing = await db?.getConfigJson?.('runtime.terminals', {}) || {};
            if (!existing || typeof existing !== 'object') { return; }

            // Collect tmux entries grouped by session.
            const tmuxEntries: Array<[string, any]> = Object.entries(existing)
                .filter(([, e]: [string, any]) => e && e.ideName === TMUX_IDE_NAME);
            if (tmuxEntries.length === 0) { return; }

            const livePanes = await listTmuxPanes(socket);
            const livePaneIds = new Set(livePanes.map(p => p.paneId));
            const liveSessions = new Set(livePanes.map(p => p.sessionName));

            let changed = false;
            const terminalMap: Record<string, any> = {};
            for (const [name, entry] of Object.entries(existing)) {
                if (!(entry as any) || (entry as any).ideName !== TMUX_IDE_NAME) {
                    terminalMap[name] = entry;
                    continue;
                }
                const e = entry as any;
                // Pane identity is the authority. The session check is only a
                // second signal, and ONLY for rows that actually carry a
                // sessionName — an undefined sessionName is never a member of
                // `liveSessions`, so testing it unconditionally marked every row
                // without that field dead on the first tick.
                const paneGone = !livePaneIds.has(e.paneId);
                const sessionGone = typeof e.sessionName === 'string' && e.sessionName.length > 0
                    ? !liveSessions.has(e.sessionName)
                    : false;
                if ((sessionGone || paneGone) && e.status !== 'exited') {
                    terminalMap[name] = { ...e, status: 'exited' };
                    changed = true;
                } else {
                    terminalMap[name] = e;
                }
            }

            if (changed) {
                await db.setConfigJson('runtime.terminals', terminalMap);
            }
        } catch {
            // Swallow — a failed poll is a missed death detection, not a crash.
        }
    }, intervalMs);
    timer.unref();

    return {
        stop: () => { try { timer.unref(); clearInterval(timer); } catch { /* already stopped */ } },
    };
}

// ─── Delivery helper ──────────────────────────────────────────────────────

/**
 * Resolve a tmux-seated terminal by friendly name from `runtime.terminals`.
 * Returns the registry entry if it is an active tmux seat, or null.
 *
 * Used by the `sendToTerminal` delivery arm on both hosts to check whether
 * a name belongs to a tmux seat before routing to `sendPromptToTmux`.
 */
export async function resolveTmuxSeatFromRegistry(
    db: any,
    name: string
): Promise<{ paneId: string; sessionName: string; status: string } | null> {
    try {
        const existing = await db?.getConfigJson?.('runtime.terminals', {}) || {};
        if (!existing || typeof existing !== 'object') { return null; }
        const entry = existing[name];
        if (entry && entry.ideName === TMUX_IDE_NAME) {
            return { paneId: entry.paneId, sessionName: entry.sessionName, status: entry.status };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Deliver a prompt to a tmux seat by pane id. Used by the `sendToTerminal`
 * delivery arm on both hosts.
 */
export async function deliverToTmuxSeat(
    paneId: string,
    friendlyName: string,
    text: string,
    socket?: TmuxSocket,
    opts?: { clearBeforePrompt?: boolean }
): Promise<{ success: boolean; error?: string }> {
    try {
        validatePaneId(paneId);
        const handle = new TmuxTerminalHandle(friendlyName, paneId, socket);
        await sendPromptToTmux(handle, text, { clearBeforePrompt: opts?.clearBeforePrompt ?? false });
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Send a control string (single-line slash command) to a tmux seat.
 * Mirrors the fleet's `ptyWrite` path for `/clear` etc.
 */
export async function sendControlToTmuxSeat(
    paneId: string,
    text: string,
    socket?: TmuxSocket
): Promise<{ success: boolean; error?: string }> {
    try {
        validatePaneId(paneId);
        // Use send-keys -l for the text, then Enter. A control string is a
        // single line (no \n) starting with / — a bare line submit, no
        // bracketed-paste framing, no clearBeforePrompt side effect.
        await run(['send-keys', '-t', paneId, '-l', text], socket);
        await run(['send-keys', '-t', paneId, 'Enter'], socket);
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}
