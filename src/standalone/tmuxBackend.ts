import { execFile } from 'child_process';
import type { TerminalHandle, TerminalDisposable } from '../services/hostSeams';

/**
 * tmux Bridge — Transport Layer (Part 1).
 *
 * Implements the existing `TerminalBackend` / `TerminalHandle` seam
 * (`src/services/hostSeams.ts`) so Switchboard can write text into tmux panes
 * it does not own. This module is self-contained: nothing is wired into the
 * host seams, no dispatch path changes, and no behaviour changes for any
 * existing user. Part 2 does the wiring.
 *
 * SECURITY: every tmux invocation uses `execFile` with an argv array — no
 * `exec`, no `execSync`, no `shell: true`, no template-literal command strings.
 * A prompt body containing `; rm -rf ~` must reach the pane as literal text.
 * Pane ids are validated against `/^%\d+$/` before reaching any `-t` argument.
 */

// ─── Registry owner tag ──────────────────────────────────────────────────
// Mirrors PTY_IDE_NAME (ptyFleetService.ts:71). Consumed in Part 2 to leave
// tmux rows alone instead of adopting them.
export const TMUX_IDE_NAME = 'switchboard-tmux';

// ─── Socket ──────────────────────────────────────────────────────────────
/** Non-default socket selection. `name` → `-L`, `path` → `-S`. */
export interface TmuxSocket {
    name?: string;
    path?: string;
}

// ─── Pane record ─────────────────────────────────────────────────────────
export interface TmuxPane {
    paneId: string;               // %N — the stable handle
    sessionName: string;
    windowIndex: string;
    windowName: string;
    paneIndex: string;
    paneTitle: string;            // user-settable — natural place for `coder-1`
    paneCurrentCommand: string;
    paneCurrentPath: string;
    panePid: string;
    /** tmux session group — empty for an ungrouped session. Added so the
     *  session list can identify the base session (the member whose name
     *  equals its group) without pattern-matching name suffixes. */
    sessionGroup: string;
    /** `#{session_attached}` — decimal string ("0", "1", "2", …) counting
     *  clients attached to the session this pane's row reports. Empty when
     *  no session is in scope (treat empty and "0" as equivalent per
     *  research). `list-panes -a` emits one row per pane per group member, so
     *  the same pane appears multiple times with different counts (the base
     *  row shows the base's count, a view row shows the view's count). The
     *  session list aggregates this across group members. */
    sessionAttached: string;
    /** Derived friendly name — see `deriveFriendlyName`. */
    friendlyName: string;
}

// ─── Pane-id validation ──────────────────────────────────────────────────
const PANE_ID_RE = /^%\d+$/;

/**
 * Validate a tmux pane id before it reaches any `-t` argument. A `session:window.pane`
 * string derived from user input is re-numberable and parseable by tmux in ways `%id`
 * is not — so only `%N` is ever accepted as a target. Feeding `%1; kill-server` is
 * rejected here, not passed through.
 */
export function validatePaneId(id: string): void {
    if (!PANE_ID_RE.test(id)) {
        throw new Error(`invalid tmux pane id: ${JSON.stringify(id)}`);
    }
}

// ─── Invocation helper ───────────────────────────────────────────────────
// The ONLY place `child_process` is touched. argv array, no shell, no
// interpolation. The socket prefix is prepended as discrete argv elements so
// a non-default socket is reachable without cross-socket discovery.

type RunFn = (args: string[], socket?: TmuxSocket, input?: string) => Promise<string>;

function buildArgv(args: string[], socket?: TmuxSocket): string[] {
    if (socket?.name) { return ['-L', socket.name, ...args]; }
    if (socket?.path) { return ['-S', socket.path, ...args]; }
    return args;
}

function defaultRunImpl(args: string[], socket?: TmuxSocket, input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const argv = buildArgv(args, socket);
        const options: Record<string, unknown> = {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        };
        const child = execFile('tmux', argv, options, (err, stdout) => {
            if (err) { reject(err); return; }
            resolve(stdout);
        });
        // `execFile` has NO `input` option — that belongs to the *Sync* family
        // (`execFileSync`/`spawnSync`). Setting `options.input` is silently
        // ignored, and because execFile still opens a stdin pipe and never ends
        // it, `tmux load-buffer -` blocks on a read that never sees EOF: the
        // promise never settles and the per-pane delivery lock is held forever.
        // On tmux >= 3.2 (`caps.stdinBuffer`) that is EVERY prompt delivery.
        // Stdin must be written and closed explicitly.
        if (input !== undefined) {
            const stdin = child.stdin;
            if (stdin) {
                stdin.on('error', () => { /* child exited early — the callback reports it */ });
                stdin.end(input);
            } else {
                // No stdin pipe (should not happen with the default stdio), so the
                // payload cannot be delivered. Fail loudly rather than hang.
                child.kill();
                reject(new Error('tmux: stdin pipe unavailable for a command that requires input'));
            }
        }
    });
}

let _runImpl: RunFn = defaultRunImpl;

/**
 * Test hook — replace the invocation layer with a mock that records argv.
 * Pass `null` to restore the real `execFile` implementation. This is the
 * single chokepoint the contract tests use; no test requires a live tmux
 * server.
 */
export function _setTmuxRunImpl(fn: RunFn | null): void {
    _runImpl = fn ?? defaultRunImpl;
}

/** Internal: run a tmux command, returning stdout. Throws on non-zero exit. */
export async function run(args: string[], socket?: TmuxSocket, input?: string): Promise<string> {
    return _runImpl(args, socket, input);
}

// ─── Availability probe ──────────────────────────────────────────────────
// Two-part and time-varying: binary exists AND a server is currently running.
// The server can start and stop while Switchboard runs, so a single cached
// boolean is wrong. Mirrors the `isPtyAvailable()` contract pinned by
// `pty-host-gating-contract.test.js`: a throwing probe must never surface as
// an unhandled rejection on a request path.

let _binaryChecked: boolean | null = null;   // immutable once known
let _serverSeenAt = 0;
let _serverLive = false;
const SERVER_PROBE_TTL_MS = 2000;

/**
 * Is tmux available? Probes the binary once (cached permanently — a missing
 * binary never retries) and the server on a short TTL (it can start/stop
 * while Switchboard runs). Swallows every failure mode → `false`, never
 * throws.
 */
export async function isTmuxAvailable(socket?: TmuxSocket): Promise<boolean> {
    try {
        if (_binaryChecked === null) {
            await run(['-V'], socket);       // throws if tmux is absent
            _binaryChecked = true;
        }
        if (!_binaryChecked) { return false; }
        // Server liveness is time-varying — re-probe on a short TTL.
        if (Date.now() - _serverSeenAt > SERVER_PROBE_TTL_MS) {
            try {
                await run(['list-sessions'], socket);
                _serverLive = true;
            } catch {
                _serverLive = false;
            }
            _serverSeenAt = Date.now();
        }
        return _serverLive;
    } catch {
        _binaryChecked = false;              // never retry a missing binary
        return false;
    }
}

// ─── Version gate ────────────────────────────────────────────────────────
// Parsed once from `tmux -V` (`tmux 3.4` → [3,4]) and cached. The version
// floors are verified against the tmux changelog:
//   load-buffer -   (stdin)  ≥ 3.2  — confirmed: tmux 3.2 CHANGES
//   paste-buffer -p          ≥ 2.6  — plan-asserted, consistent with 2.6 era
//   send-keys -H             ≥ 2.4  — plan-asserted, consistent with 2.4 era

export interface TmuxCaps {
    stdinBuffer: boolean;    // load-buffer -   (≥ 3.2)
    bracketedPaste: boolean; // paste-buffer -p (≥ 2.6)
    hexKeys: boolean;        // send-keys -H    (≥ 2.4)
}

let _cachedVersion: [number, number] | null = null;
let _cachedCaps: TmuxCaps | null = null;

function parseTmuxVersion(output: string): [number, number] {
    const m = output.match(/tmux\s+(\d+)\.(\d+)/);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [0, 0];
}

function versionGE(ver: [number, number], major: number, minor: number): boolean {
    return ver[0] > major || (ver[0] === major && ver[1] >= minor);
}

/**
 * Derive tmux capability flags from the installed version. Cached after the
 * first call. Throws if tmux is absent (unlike `isTmuxAvailable`, which
 * swallows — callers should gate on availability first).
 */
export async function tmuxCaps(socket?: TmuxSocket): Promise<TmuxCaps> {
    if (_cachedCaps) { return _cachedCaps; }
    const out = await run(['-V'], socket);
    _cachedVersion = parseTmuxVersion(out);
    _cachedCaps = {
        stdinBuffer: versionGE(_cachedVersion, 3, 2),
        bracketedPaste: versionGE(_cachedVersion, 2, 6),
        hexKeys: versionGE(_cachedVersion, 2, 4),
    };
    return _cachedCaps;
}

/** Test hook — reset cached version/caps so a mocked `-V` takes effect. */
export function _resetTmuxCaps(): void {
    _cachedVersion = null;
    _cachedCaps = null;
}

/** Test hook — reset the availability probe cache so tests start clean. */
export function _resetTmuxAvailability(): void {
    _binaryChecked = null;
    _serverSeenAt = 0;
    _serverLive = false;
}

// ─── Pane discovery ──────────────────────────────────────────────────────
// `\x1f` (ASCII unit separator) delimits fields so pane titles containing
// `|` or `:` cannot corrupt the parse. `list-panes -a` sees only the default
// (or configured) socket — no cross-socket discovery.
//
// MEASURED (tmux 3.4): tmux vis-escapes non-printable bytes in `-F` output, so
// the 0x1f we ask for comes BACK as the four literal characters `\037` — a
// `split('\x1f')` therefore finds one field per line and every pane is dropped.
// (Tab and backslash are NOT escaped, so neither is a safe separator instead.)
// `splitPaneFields` below un-escapes `\037` before splitting, so both the
// escaped and the raw form parse. Do not "simplify" it back to a bare split.

const PANE_FORMAT = [
    '#{pane_id}', '#{session_name}', '#{window_index}', '#{window_name}',
    '#{pane_index}', '#{pane_title}', '#{pane_current_command}',
    '#{pane_current_path}', '#{pane_pid}', '#{session_group}',
    '#{session_attached}',
].join('\x1f');

/**
 * Derive a friendly name for a pane. Precedence:
 *   1. `pane_title` (user-settable — the natural place to write `coder-1`)
 *   2. `window_name`
 *   3. `session:window.pane`
 * Callers match names with `normalizeAgentKey` semantics so `Coder-1` and
 * `coder-1` resolve identically.
 */
function deriveFriendlyName(pane: Omit<TmuxPane, 'friendlyName'>): string {
    if (pane.paneTitle && pane.paneTitle.trim()) { return pane.paneTitle; }
    if (pane.windowName && pane.windowName.trim()) { return pane.windowName; }
    return `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
}

/**
 * Split one `-F` output line into its fields. tmux writes the 0x1f separator
 * back as the literal `\\037` (vis octal escape); accept both that and the raw
 * byte so the parse does not depend on a tmux version's escaping policy.
 */
function splitPaneFields(line: string): string[] {
    return line.replace(/\\037/g, '\x1f').split('\x1f');
}

/**
 * List all panes across all sessions on the (configured) socket.
 * Returns an empty array if no server is running (swallows the error —
 * callers should gate on `isTmuxAvailable` first).
 */
export async function listTmuxPanes(socket?: TmuxSocket): Promise<TmuxPane[]> {
    let out: string;
    try {
        out = await run(['list-panes', '-a', '-F', PANE_FORMAT], socket);
    } catch {
        return [];
    }
    const lines = out.split('\n').filter(l => l.length > 0);
    const panes: TmuxPane[] = [];
    for (const line of lines) {
        const fields = splitPaneFields(line);
        if (fields.length < 11) { continue; }
        const base: Omit<TmuxPane, 'friendlyName'> = {
            paneId: fields[0],
            sessionName: fields[1],
            windowIndex: fields[2],
            windowName: fields[3],
            paneIndex: fields[4],
            paneTitle: fields[5],
            paneCurrentCommand: fields[6],
            paneCurrentPath: fields[7],
            panePid: fields[8],
            sessionGroup: fields[9] || '',
            sessionAttached: fields[10] || '',
        };
        panes.push({ ...base, friendlyName: deriveFriendlyName(base) });
    }
    return panes;
}

// ─── Session list (tmux-derived, registry-free) ──────────────────────────
// One row per team (grouped by `#{session_group}`), with the base session
// flagged as the only safe attach point. The base is the member whose
// `session_name` equals its `session_group` — the session with no board pane
// on it, which keeps its status strip. Per-seat views (`lc-<team>-team-<role>`)
// are created in control mode and share a current-window pointer with a
// board pane, so they are NOT offered as attach targets (see plan §4).
//
// Board-owned sessions are namespaced `lc-` (deriveTmuxSessionName, teamWiring).
// Only `lc-` groups are listed — the operator's own tmux sessions are not the
// board's to publish.

export interface TmuxTeamSession {
    /** The session group — `lc-<team>-team`. */
    group: string;
    /** The base session name (equals the group), or '' if no member matched. */
    baseSession: string;
    /** Distinct window names in the base session (the seats). */
    windows: string[];
    /** Member session names in the group (base + per-seat views). */
    members: string[];
    /** True if ANY member session (base or a view) has at least one attached
     *  client — `#{session_attached}` non-empty and not "0". The one fact
     *  that tells an operator a human is inside a session before they close
     *  the base (which kills all grouped views). */
    attached: boolean;
}

/**
 * List the board's tmux teams, grouped by `#{session_group}`. Returns an
 * empty array if no server is running (swallows the error — callers should
 * gate on `isTmuxAvailable` first). tmux-derived only: no registry merge.
 */
export async function listTmuxSessions(socket?: TmuxSocket): Promise<TmuxTeamSession[]> {
    const panes = await listTmuxPanes(socket);
    if (panes.length === 0) { return []; }

    // Group panes by sessionGroup. Panes with no group (ungrouped sessions)
    // are keyed by their own sessionName so a lone `lc-` session still lists.
    const groupMembers = new Map<string, Set<string>>();
    const groupBaseWindows = new Map<string, Set<string>>();
    // groupAttached: true if ANY member session of the group has at least one
    // attached client. `list-panes -a` emits one row per pane per group member,
    // so the same pane appears with different `session_attached` values (the
    // base row shows the base's count, a view row shows the view's count).
    // Aggregating across members is the correct approach — a human attached to
    // any view or the base means the team is occupied.
    const groupAttached = new Map<string, boolean>();
    for (const p of panes) {
        const group = p.sessionGroup || p.sessionName;
        if (!group.startsWith('lc-')) { continue; }
        let members = groupMembers.get(group);
        if (!members) { members = new Set(); groupMembers.set(group, members); }
        members.add(p.sessionName);
        // The base session's windows are the seats. A view session shares the
        // window list but its panes belong to a different sessionName, so only
        // count windows whose sessionName === group (the base).
        if (p.sessionName === group) {
            let wins = groupBaseWindows.get(group);
            if (!wins) { wins = new Set(); groupBaseWindows.set(group, wins); }
            wins.add(p.windowName);
        }
        // sessionAttached is a decimal string ("0", "1", …) or empty (treat
        // empty and "0" as equivalent per research). A non-zero count on any
        // member row means a client is attached to that member's session.
        if (p.sessionAttached !== '' && p.sessionAttached !== '0') {
            groupAttached.set(group, true);
        }
    }

    const teams: TmuxTeamSession[] = [];
    for (const [group, members] of groupMembers) {
        const hasBase = members.has(group);
        const windows = hasBase ? Array.from(groupBaseWindows.get(group) || []) : [];
        teams.push({
            group,
            baseSession: hasBase ? group : '',
            windows,
            members: Array.from(members),
            attached: groupAttached.get(group) === true,
        });
    }
    // Stable order by group name.
    teams.sort((a, b) => a.group.localeCompare(b.group));
    return teams;
}

// ─── Grid window builder ─────────────────────────────────────────────────
// Builds the 4-up dashboard window from the verified recipe (plan §"The grid
// recipe, verified"). Idempotent: a `grid` window that already exists is
// killed and rebuilt (tmux permits duplicate window names, so a naive re-run
// would make two). The board cannot `tmux attach` — the attach string is
// returned for the human's SSH client.
//
// SECURITY: the team name reaches tmux command argv. It is validated against
// the `deriveTmuxSessionName` charset (`^lc-[a-z0-9_-]+$`, ≤ 53 chars) before
// any interpolation, so a request body cannot inject flags or targets.

const TMUX_SESSION_NAME_RE = /^lc-[a-z0-9_-]+$/;
const TMUX_SESSION_NAME_MAX = 53;  // 'lc-' + 50 (deriveTmuxSessionName cap)

export function validateTmuxSessionName(name: string): void {
    if (typeof name !== 'string' || !TMUX_SESSION_NAME_RE.test(name) || name.length > TMUX_SESSION_NAME_MAX) {
        throw new Error(`invalid tmux session name: ${JSON.stringify(name)}`);
    }
}

// ─── Session kill (operator close control) ───────────────────────────────
// The SOLE TS-side path that issues `tmux kill-session`. Reached only from the
// `tmuxKillSession` verb (wired in both composition roots), which is itself
// reached only from operator actions: the tmux tab close button and the team
// close fan-out. The plan's invariant is that NO automatic close path exists —
// no timer, sweep, interval, or startup reconciliation may call this. The
// contract test pins that reachability.
//
// SECURITY: the target reaches tmux argv. Two forms are accepted:
//   - a session NAME (`lc-...`): validated against TMUX_SESSION_NAME_RE, then
//     targeted with the `=` exact-match prefix so `lc-coding-team` cannot match
//     `lc-coding-team-coder-1` (research confirmed `target-session` tries
//     prefix matching by default).
//   - a session ID (`$N`): passed through without validation — tmux assigns it
//     and it is the safe form for team close (the group name outlives the
//     founding session, so name-based targeting fails after the base is gone).
// `run()` uses an argv array — no shell, no interpolation.

/**
 * Kill a tmux session by name or session ID. Returns true on success (or when
 * the session was already gone — "can't find session" / "no such session" is
 * swallowed, since the operator's intent is "this session should not exist").
 * Throws on any other tmux error.
 *
 * `target` is either a session name (validated, then `=name` exact-match) or a
 * session ID (`$N`, passed through). The `=` prefix for names forces
 * exact-match targeting — research confirmed bare prefix matching can kill
 * the wrong session.
 */
export async function killTmuxSession(target: string, socket?: TmuxSocket): Promise<boolean> {
    if (typeof target !== 'string' || target === '') {
        throw new Error('killTmuxSession requires a non-empty target (session name or $N id)');
    }
    // Build the argv, then run it. The array literal is kept inline (not a
    // pre-bound variable) so the contract test can pin `run(['kill-session',
    // ...])` as the executable call site — the invariant that no other path
    // issues kill-session.
    let argv: string[];
    if (target.startsWith('$')) {
        // Session ID — tmux assigns it; pass through without name validation.
        argv = ['kill-session', '-t', target];
    } else {
        validateTmuxSessionName(target);
        // `=` forces exact-match targeting so a bare prefix cannot match a
        // sibling session (e.g. `lc-coding-team` matching `lc-coding-team-coder-1`).
        argv = ['kill-session', '-t', '=' + target];
    }
    try {
        await run(argv, socket);
        return true;
    } catch (err) {
        // Swallow "can't find session" / "no such session" — the session may
        // already be gone (the agent exited and tmux cleaned up, or a prior
        // kill in the team-close loop already removed it). Issue 5180
        // (pre-3.8) can transiently block sibling targeting during sequential
        // group kills, so a "can't find" on a sibling is expected and the
        // caller may retry.
        const msg = err instanceof Error ? err.message : String(err);
        if (/can't find session|no such session|can't find or/i.test(msg)) {
            return false;
        }
        throw err;
    }
}

/**
 * Kill every session in a tmux session group by session ID. The plan's team-
 * close path: after the per-seat fan-out (which kills each seat's VIEW session
 * via the Go host), the BASE session and any seatless views remain. Killing
 * the base takes the grouped views with it (research confirmed), but the
 * group NAME can outlive the founding session — after the base is gone, a
 * name-based kill of a sibling fails. Session IDs (`$N`) are stable, so this
 * function enumerates the group's members by ID and kills each one.
 *
 * `group` is the session group name (e.g. `lc-coding-team`), validated against
 * TMUX_SESSION_NAME_RE. Returns the number of sessions killed (best-effort —
 * already-gone sessions are tolerated, per the plan's "tolerate already-gone
 * sessions and pre-3.8 grouped-session targeting issues" note).
 *
 * THE INVARIANT: this is the SOLE path that kills multiple sessions at once.
 * Reached only from the `tmuxKillSessionGroup` verb, which is reached only
 * from `closeTeam()` — an operator action. No automatic path may call this.
 */
export async function killTmuxSessionGroup(group: string, socket?: TmuxSocket): Promise<number> {
    validateTmuxSessionName(group);
    // Enumerate the group's members by session ID. `list-sessions -F` emits
    // one row per session; `#{session_group}` is empty for an ungrouped
    // session. Filter rows whose group matches. Issue 5180 (pre-3.8) can
    // transiently block sibling targeting during sequential group kills, so
    // each kill is best-effort and "can't find session" is tolerated.
    let out: string;
    try {
        out = await run(['list-sessions', '-F', '#{session_group}\x1f#{session_id}'], socket);
    } catch {
        // No tmux server or no sessions — nothing to kill.
        return 0;
    }
    const lines = out.split('\n').filter(l => l.length > 0);
    const ids: string[] = [];
    for (const line of lines) {
        // MEASURED (tmux 3.4): tmux vis-escapes the 0x1f we ask for and writes
        // it back as the four literal characters `\037` — the same trap
        // `splitPaneFields` exists for. A bare `split('\x1f')` here found ONE
        // field per line, so `parts.length < 2` skipped EVERY row, `ids` came
        // back empty, and team close killed nothing while returning 0 and
        // reporting success. Use the shared un-escaping splitter.
        const parts = splitPaneFields(line);
        if (parts.length < 2) { continue; }
        const [groupName, sessionId] = parts;
        if (groupName === group && sessionId) {
            ids.push(sessionId);
        }
    }
    let killed = 0;
    for (const id of ids) {
        try {
            await run(['kill-session', '-t', id], socket);
            killed++;
        } catch (err) {
            // Swallow "can't find session" — the session may already be gone
            // (the per-seat fan-out killed a view, or a prior kill in this
            // loop already removed it). Issue 5180 (pre-3.8) can transiently
            // block sibling targeting during sequential group kills.
            const msg = err instanceof Error ? err.message : String(err);
            if (!/can't find session|no such session|can't find or/i.test(msg)) {
                // A real error stops the loop — the operator should know.
                throw err;
            }
        }
    }
    return killed;
}

/**
 * Build the `grid` window on a team session. Returns the attach command the
 * human runs in their SSH client. Idempotent: an existing `grid` window is
 * killed first. Throws if the team name is invalid or tmux fails.
 *
 * `viewSessions` are the per-seat view session names (the group's members
 * minus the base) — the panes nest-attach to each by full name. If omitted,
 * they are resolved from `listTmuxSessions` (members minus the base). The
 * view names are NOT derived from window names here: the suffix derivation
 * (goPtyFleetProjection.ts:248-256) strips the team slug with a fallback to
 * the role, so `$G-<windowName>` would be wrong. The group's actual member
 * session names are the source of truth.
 */
export async function buildTmuxGrid(team: string, viewSessions?: string[], socket?: TmuxSocket): Promise<string> {
    validateTmuxSessionName(team);
    // Idempotency guard: kill an existing `grid` window before rebuilding.
    // `tmux has-session -t <team>:grid` would also work, but list-windows is
    // the same guard pattern goPtyFleetProjection.ts:258 uses for seats.
    try {
        const wins = await run(['list-windows', '-t', team, '-F', '#{window_name}'], socket);
        const names = wins.split('\n').map(w => w.trim()).filter(Boolean);
        if (names.includes('grid')) {
            await run(['kill-window', '-t', `${team}:grid`], socket);
        }
    } catch { /* no such session/window — nothing to kill */ }

    // Resolve the view sessions if not supplied: the group's members minus the
    // base session. Each is a per-seat view the grid pane nest-attaches to.
    let views = viewSessions;
    if (!Array.isArray(views) || views.length === 0) {
        const teams = await listTmuxSessions(socket);
        const t = teams.find(x => x.group === team || x.baseSession === team);
        views = t ? t.members.filter(m => m !== t.baseSession) : [];
    }
    if (!views || views.length === 0) {
        throw new Error(`no per-seat view sessions found for team '${team}'`);
    }

    // First pane: nest-attach to the first view. `TMUX=` is load-bearing —
    // tmux refuses to attach from inside itself unless the variable is cleared.
    const [first, ...rest] = views;
    await run(['new-window', '-d', '-t', team, '-n', 'grid', `TMUX= tmux attach -t ${first}`], socket);
    for (const view of rest) {
        await run(['split-window', '-d', '-t', `${team}:grid`, `TMUX= tmux attach -t ${view}`], socket);
    }
    await run(['select-layout', '-t', `${team}:grid`, 'tiled'], socket);
    return `tmux attach -t ${team}:grid`;
}


// ─── Name normalization ──────────────────────────────────────────────────
// Mirrors `normalizeAgentKey` (TaskViewerProvider.ts:497): lowercase, collapse
// hyphens/underscores to spaces, trim. So `Coder-1` and `coder-1` resolve
// identically. Duplicated here to avoid importing the vscode-coupled
// TaskViewerProvider into a standalone module.
function normalizeAgentKey(value: string): string {
    return (value || '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ─── TmuxTerminalHandle ──────────────────────────────────────────────────
// Implements `TerminalHandle` plus a `paneId` member, the way
// `ExtendedTerminalHandle` extends the base for PTYs.
//
// `onData` / `onExit` are no-op disposables — there is no meaningful tmux
// implementation without polling `capture-pane` or long-running `pipe-pane`
// plumbing. This matches `VscodeTerminalBackend._wrap()` (hostSeams.ts:274-275)
// which also no-ops `onData`/`onExit` because VS Code exposes no read side
// either. Switchboard's completion signal is plan-file mtime advance, not
// terminal output. A read side is explicitly out of scope for the whole bridge.
//
// `sendText` / `write` are sync-void per the interface contract. tmux commands
// are async (execFile), so these fire-and-forget — errors are swallowed. The
// real prompt delivery path (`sendPromptToTmux`) calls `run` directly and
// awaits properly; these methods exist for the `TerminalBackend.sendInput`
// fire-and-forget path.

export class TmuxTerminalHandle implements TerminalHandle {
    readonly name: string;
    readonly paneId: string;
    /** The socket this handle's pane lives on. Exposed for the delivery path. */
    readonly socket?: TmuxSocket;
    private _caps: TmuxCaps | null = null;

    constructor(name: string, paneId: string, socket?: TmuxSocket) {
        validatePaneId(paneId);
        this.name = name;
        this.paneId = paneId;
        this.socket = socket;
    }

    private async _capsResolved(): Promise<TmuxCaps> {
        if (!this._caps) { this._caps = await tmuxCaps(this.socket); }
        return this._caps;
    }

    /** `send-keys -t %id -l <text>`; then `send-keys -t %id Enter` unless addNewLine === false. */
    sendText(text: string, addNewLine?: boolean): void {
        validatePaneId(this.paneId);
        void run(['send-keys', '-t', this.paneId, '-l', text], this.socket).catch(() => {});
        if (addNewLine !== false) {
            void run(['send-keys', '-t', this.paneId, 'Enter'], this.socket).catch(() => {});
        }
    }

    /**
     * `send-keys -t %id -l <data>` when printable; `send-keys -t %id -H <hex>` when
     * `data` contains control bytes and `caps.hexKeys` — this is what makes raw
     * `\x1b[200~` framing reachable. Falls back to `-l` when hexKeys is
     * unavailable (the control bytes pass through as literal text — documented
     * limitation, see plan Risks).
     */
    write(data: string): void {
        validatePaneId(this.paneId);
        const hasControlBytes = /[\x00-\x1f\x7f]/.test(data);
        if (hasControlBytes) {
            void this._capsResolved().then(caps => {
                if (caps.hexKeys) {
                    const hex = Buffer.from(data, 'utf8').toString('hex');
                    return run(['send-keys', '-t', this.paneId, '-H', hex], this.socket);
                }
                return run(['send-keys', '-t', this.paneId, '-l', data], this.socket);
            }).catch(() => {});
        } else {
            void run(['send-keys', '-t', this.paneId, '-l', data], this.socket).catch(() => {});
        }
    }

    onData(_cb: (chunk: string) => void): TerminalDisposable {
        // No-op — see class doc. Pane death surfaces via re-discovery.
        return { dispose: () => {} };
    }

    onExit(_cb: (code: number | undefined) => void): TerminalDisposable {
        // No-op — see class doc.
        return { dispose: () => {} };
    }

    /** `resize-pane -t %id -x <cols> -y <rows>`. */
    resize(cols: number, rows: number): void {
        validatePaneId(this.paneId);
        void run(['resize-pane', '-t', this.paneId, '-x', String(cols), '-y', String(rows)], this.socket)
            .catch(() => {});
    }

    /**
     * Unregister only — NEVER `kill-pane`. Switchboard did not create the
     * user's pane and must never destroy their shell as a side effect of
     * shutting down or a `closeTerminal` verb. `kill()` is the sole
     * destructive path. This asymmetry is intentional (see plan User Review
     * Required).
     */
    dispose(): void {
        // No tmux command — unregister only.
    }

    /** `kill-pane -t %id` — the sole destructive path. */
    kill(): void {
        validatePaneId(this.paneId);
        void run(['kill-pane', '-t', this.paneId], this.socket).catch(() => {});
    }

    /**
     * `select-pane -t %id` + `select-window -t %id`; both skipped when
     * `preserveFocus` — matching `sendRobustText`'s background-mode contract
     * that focus is never stolen for background work.
     */
    show(preserveFocus?: boolean): void {
        if (preserveFocus) { return; }
        validatePaneId(this.paneId);
        void run(['select-pane', '-t', this.paneId], this.socket).catch(() => {});
        void run(['select-window', '-t', this.paneId], this.socket).catch(() => {});
    }
}

// ─── TmuxTerminalBackend ─────────────────────────────────────────────────
// `findByName` / `findByNameContains` over `listTmuxPanes()`, `sendInput` /
// `kill` / `resize` delegating to the resolved handle, `onClose` registering
// a callback fired by Part 2's reconcile pass (no tmux event stream exists
// to hook).
//
// NOTE: the `TerminalBackend` interface (hostSeams.ts:204) declares sync
// methods — it was designed for VS Code's synchronous `window.terminals`.
// tmux operations are inherently async (execFile), so this backend does NOT
// use `implements TerminalBackend`. It mirrors the `PtyFleetService` pattern:
// async equivalents of the same method names, which Part 2 adapts at the
// composition root. The `TerminalHandle` interface IS implemented by
// `TmuxTerminalHandle` (sync fire-and-forget for send/write, matching the
// interface contract).

export class TmuxTerminalBackend {
    private readonly _socket?: TmuxSocket;
    private readonly _onCloseCallbacks: Array<(name: string) => void> = [];

    constructor(socket?: TmuxSocket) {
        this._socket = socket;
    }

    /**
     * Create a terminal in a dedicated `switchboard` session so Switchboard
     * never injects windows into the user's working session. `-P -F '#{pane_id}'`
     * prints the new pane id on stdout — the only race-free way to get a handle
     * on what was just created.
     */
    async create(name: string, shellPath?: string, cwd?: string): Promise<TmuxTerminalHandle> {
        // Ensure the dedicated session exists.
        try {
            await run(['has-session', '-t', 'switchboard'], this._socket);
        } catch {
            await run(['new-session', '-d', '-s', 'switchboard'], this._socket);
        }
        const createArgs = ['new-window', '-d', '-t', 'switchboard', '-n', name];
        if (cwd) { createArgs.push('-c', cwd); }
        createArgs.push('-P', '-F', '#{pane_id}');
        if (shellPath) { createArgs.push(shellPath); }
        const paneId = (await run(createArgs, this._socket)).trim();
        validatePaneId(paneId);
        return new TmuxTerminalHandle(name, paneId, this._socket);
    }

    async findByName(name: string): Promise<TmuxTerminalHandle | null> {
        const panes = await listTmuxPanes(this._socket);
        const target = normalizeAgentKey(name);
        const pane = panes.find(p => normalizeAgentKey(p.friendlyName) === target);
        if (!pane) { return null; }
        return new TmuxTerminalHandle(pane.friendlyName, pane.paneId, this._socket);
    }

    async findByNameContains(substring: string): Promise<TmuxTerminalHandle | null> {
        const panes = await listTmuxPanes(this._socket);
        const target = normalizeAgentKey(substring);
        const pane = panes.find(p => normalizeAgentKey(p.friendlyName).includes(target));
        if (!pane) { return null; }
        return new TmuxTerminalHandle(pane.friendlyName, pane.paneId, this._socket);
    }

    async sendInput(name: string, text: string, addNewLine?: boolean): Promise<boolean> {
        const handle = await this.findByName(name);
        if (!handle) { return false; }
        handle.sendText(text, addNewLine);
        return true;
    }

    async kill(name: string): Promise<boolean> {
        const handle = await this.findByName(name);
        if (!handle) { return false; }
        handle.kill();
        return true;
    }

    async resize(name: string, columns: number, rows: number): Promise<boolean> {
        const handle = await this.findByName(name);
        if (!handle) { return false; }
        handle.resize(columns, rows);
        return true;
    }

    onClose(callback: (name: string) => void): void {
        this._onCloseCallbacks.push(callback);
    }

    /** Fire registered onClose callbacks — called by Part 2's reconcile pass. */
    _fireOnClose(name: string): void {
        for (const cb of this._onCloseCallbacks) {
            try { cb(name); } catch { /* a callback must never crash reconcile */ }
        }
    }
}
