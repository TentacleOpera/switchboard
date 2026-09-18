import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import type { DelegateDefinition } from './agentConfig';
import { deriveCliFamily, type CliFamily } from './cliIdentity';
import { deriveTmuxSessionName } from './teamWiring';
import { GlobalIntegrationConfigService, type AgentMachine, LOCAL_AGENT_MACHINE } from './GlobalIntegrationConfigService';
import type { KanbanDatabase } from './KanbanDatabase';
import { MAX_DELEGATES_PER_PARENT, MAX_LIVE_DELEGATE_PTYS } from './ptyLimits';
import { PTY_IDE_NAME, type PtyHostSupervisor } from './ptyHostSupervisor';
import type { TerminalHandle } from './hostSeams';
import type {
    CreateOptions,
    ExtendedTerminalHandle,
    FleetChangeEvent,
    FleetLivenessEntry,
    FleetTerminalInfo,
} from '../standalone/ptyFleetService';

export { MAX_DELEGATES_PER_PARENT, MAX_LIVE_DELEGATE_PTYS, PTY_IDE_NAME };
export const SHELL_READINESS_DELAY_MS = 750;

const SINGLETON_IDENTITIES: ReadonlyMap<string, string> = new Map([
    ['mission-control', 'controller'],
    ['project_manager', 'controller'],
]);

function singletonIdentityForRole(role: string): string | undefined {
    return SINGLETON_IDENTITIES.get(role);
}

interface ProjectedTerminal {
    friendlyName: string;
    role: string;
    status: 'active' | 'exited';
    pid: number;
    startTime: string;
    worktreePath?: string;
    cwd?: string;
    agentInstanceId?: string;
    parentInstanceId?: string | null;
    cliFamily?: CliFamily;
    startupCommand?: string;
    startupCommandSource?: string;
    lastDataAt?: number;
    promptCount?: number;
    hidden?: boolean;
    claudeInlineRendering?: boolean;
    _isTeamMember?: boolean;
    /** BASE tmux session name for a control-mode seat (undefined for raw PTY). */
    tmuxSession?: string;
    /** Machine id this seat spawns on (default `'local'`). */
    machineId?: string;
    /** INNER startup command (per-machine CLI before transport composition). */
    startupCommandInner?: string;
}

/**
 * Host-side fleet client for the Go PTY supervisor. Board orchestration keeps
 * talking to the TypeScript fleet surface; bytes and process ownership stay in Go.
 */
export class GoPtyFleetProjection {
    private readonly emitter = new EventEmitter();
    private cache = new Map<string, ExtendedTerminalHandle>();
    private recentlyClosed = new Map<string, number>();
    private static readonly RECENTLY_CLOSED_CAP = 64;
    private db?: KanbanDatabase;
    private _registryWrite: Promise<void> = Promise.resolve();
    private _reconcileInFlight: Promise<void> | null = null;
    private _claudeInlineRenderingResolver?: () => boolean;
    private _controllerSeatResolver?: () => { terminalName?: string } | null | undefined;
    private _sharedMemberChains = new Map<string, Promise<unknown>>();

    public constructor(
        private readonly supervisor: PtyHostSupervisor,
        private readonly workspaceRoot = '',
        db?: KanbanDatabase,
        private readonly apiToken?: string,
    ) {
        this.db = db;
        void this.refresh().catch(() => { /* best-effort initial projection */ });
        this.onDidChange((event) => {
            if (event.type === 'closed') {
                this._recordRecentlyClosed(event.name);
            } else if (event.type === 'renamed') {
                const closedAt = this.recentlyClosed.get(event.oldName);
                if (closedAt !== undefined) {
                    this.recentlyClosed.delete(event.oldName);
                    this.recentlyClosed.set(event.newName, closedAt);
                }
            }
        });
    }

    /** Host-supplied: is tmux seating on and usable? Set by the composition root. */
    private _tmuxEnabledResolver?: () => boolean;
    public setTmuxSeatingResolver(fn: () => boolean): void { this._tmuxEnabledResolver = fn; }
    private _tmuxSeatingEnabled(): boolean {
        try { return this._tmuxEnabledResolver ? this._tmuxEnabledResolver() : false; }
        catch { return false; }
    }

    public setClaudeInlineRenderingResolver(resolver: () => boolean): void {
        this._claudeInlineRenderingResolver = resolver;
    }

    /**
     * Host-supplied: the board URL a remote seat should dial — the tailnet
     * listener (`http://<tailnetAddress>:<port>`), or null under a
     * loopback-only bind. Resolved at spawn so "which board did this seat
     * get?" is answerable from the log; a remote machine with no endpoint is
     * a loud spawn failure, never a seat silently dialling its own loopback.
     */
    private _boardEndpointResolver?: () => string | null;
    public setBoardEndpointResolver(resolver: () => string | null): void {
        this._boardEndpointResolver = resolver;
    }

    public setControllerSeatResolver(resolver: () => { terminalName?: string } | null | undefined): void {
        this._controllerSeatResolver = resolver;
        void this.supervisor.request('ptySetControllerSeat', { seat: resolver() ?? null }).catch(() => { /* best-effort */ });
    }

    public setDatabase(db: KanbanDatabase): void {
        this.db = db;
    }

    public onDidChange(listener: (event: FleetChangeEvent) => void): { dispose: () => void } {
        this.emitter.on('change', listener);
        return { dispose: () => { this.emitter.off('change', listener); } };
    }

    public list(): ExtendedTerminalHandle[] {
        return Array.from(this.cache.values());
    }

    public listActive(): ExtendedTerminalHandle[] {
        return this.list().filter(t => t.status === 'active');
    }

    public getLiveness(): FleetLivenessEntry[] {
        const entries: FleetLivenessEntry[] = [];
        for (const t of this.cache.values()) {
            entries.push({ friendlyName: t.friendlyName, lastDataAt: t.lastDataAt, status: t.status, role: t.role });
        }
        for (const [name, closedAt] of this.recentlyClosed.entries()) {
            if (this.cache.has(name)) { continue; }
            entries.push({ friendlyName: name, lastDataAt: closedAt, status: 'exited' });
        }
        return entries;
    }

    public get(name: string): ExtendedTerminalHandle | undefined {
        return this.cache.get(name);
    }

    public getByAgentInstanceId(id: string): ExtendedTerminalHandle | undefined {
        for (const t of this.cache.values()) {
            if (t.agentInstanceId === id) { return t; }
        }
        return undefined;
    }

    public reportSingletonDuplicates(identity: string): string[] {
        const handles: ExtendedTerminalHandle[] = [];
        for (const t of this.cache.values()) {
            if (singletonIdentityForRole(t.role) === identity) { handles.push(t); }
        }
        if (handles.length > 0 && this._controllerSeatResolver) {
            try {
                const seatName = this._controllerSeatResolver()?.terminalName;
                if (seatName && !handles.some(h => h.friendlyName === seatName)) {
                    const seatHandle = this.cache.get(seatName);
                    if (seatHandle) { handles.push(seatHandle); }
                }
            } catch { /* best-effort */ }
        }
        if (handles.length <= 1) { return []; }
        return handles.slice(1).map(h => h.friendlyName);
    }

    public listChildren(parentId: string): ExtendedTerminalHandle[] {
        return Array.from(this.cache.values()).filter(t => t.parentInstanceId === parentId);
    }

    public async create(
        role: string,
        friendlyName?: string,
        cwd?: string,
        worktreePath?: string,
        parentInstanceId?: string | null,
        startupCommand?: string,
        opts?: CreateOptions,
    ): Promise<ExtendedTerminalHandle> {
        await this.refresh();
        const identity = singletonIdentityForRole(role);
        if (identity) {
            const existing = this._findSingletonHandle(identity);
            const duplicates = this.reportSingletonDuplicates(identity);
            if (duplicates.length > 0) {
                this.emitter.emit('change', { type: 'singletonDuplicates', identity, names: duplicates } as any);
            }
            if (existing?.status === 'active') { return existing; }
            if (existing) {
                this.cache.delete(existing.friendlyName);
                if (!friendlyName) { friendlyName = existing.friendlyName; }
            }
        }

        let name = friendlyName || `${role}-1`;
        let counter = 1;
        while (this.cache.has(name)) {
            counter++;
            name = `${role}-${counter}`;
        }

        const effectiveCwd = cwd || worktreePath || this.workspaceRoot;
        const claudeInlineRendering = opts?.claudeInlineRendering
            ?? (this._claudeInlineRenderingResolver ? this._claudeInlineRenderingResolver() : true);

        // Machine threading (plan: agents-are-saved-per-machine-and-a-team-picks-one):
        // resolve the INNER cli from the per-machine command map, then compose
        // the transport prefix (`ssh`/`mosh`/local) to get the SPAWN command.
        // cliFamily is derived from the INNER command only — a transport-wrapped
        // string would classify as `unknown` and pick the wrong readiness gate.
        // A non-`local` machine id that is not registered fails loudly.
        const machineId = opts?.machineId || 'local';
        let machine: AgentMachine | undefined;
        if (opts?.machineId && opts.machineId !== 'local') {
            machine = await GlobalIntegrationConfigService.getMachineSync(opts.machineId);
            if (!machine) {
                throw new Error(`Machine '${opts.machineId}' not found (referenced by role '${role}'); refusing to spawn on a fallback machine.`);
            }
        } else {
            machine = LOCAL_AGENT_MACHINE;
        }
        // Generated HOST-SIDE (not left to the Go host's randomToken) so the id
        // is known at command-composition time and can ride inside the remote
        // spawn as SWITCHBOARD_AGENT_INSTANCE_ID. The Go host honours a
        // caller-supplied `agentInstanceId` (main.go), so the local pty env and
        // the inlined remote env carry the SAME id.
        const agentInstanceId = crypto.randomUUID();
        let effectiveStartupCommand = startupCommand;
        let effectiveStartupSource: string;
        if (effectiveStartupCommand) {
            effectiveStartupSource = opts?._isTeamMember ? 'team-definition' : 'argument';
        } else {
            try {
                const commands = await GlobalIntegrationConfigService.getAgentStartupCommands(machineId) || {};
                effectiveStartupCommand = commands[role];
                effectiveStartupSource = effectiveStartupCommand ? `global-file:${machineId}` : 'none';
            } catch {
                effectiveStartupCommand = undefined;
                effectiveStartupSource = 'none';
            }
        }
        // Remote-seat env inlining (plan: a-remote-seat-reaches-the-board-over-
        // http-not-a-tunnel). ssh/mosh do not forward the pty's environment
        // (SendEnv needs AcceptEnv in the remote's sshd_config, which the host
        // cannot guarantee), so a remote seat learns who it is and where the
        // board is from an `env K=V …` prefix inlined into the command the
        // host composes — NOT from the SWITCHBOARD_* vars the Go host sets on
        // the LOCAL pty, which die at the transport boundary. No credential is
        // ever inlined: a request arriving on the tailnet listener is trusted
        // before any token is read (LocalApiServer._isTailnetSocket), so
        // tailnet membership IS the remote seat's auth. A null endpoint means
        // the board binds loopback only — a remote seat under it would dial
        // its own loopback and get "no instance", so the spawn fails loudly
        // and names the fix rather than producing a half-reachable seat.
        let seatEnv: Record<string, string> | undefined;
        if (machine.transport !== 'local') {
            const boardEndpoint = this._boardEndpointResolver ? this._boardEndpointResolver() : null;
            if (!boardEndpoint) {
                throw new Error(`Machine '${machineId}' is remote but the board has no tailnet listener — run \`switchboard tailnet\` and retry.`);
            }
            seatEnv = {
                SWITCHBOARD_TERMINAL: name,
                SWITCHBOARD_AGENT_INSTANCE_ID: agentInstanceId,
                SWITCHBOARD_SERVER_URL: boardEndpoint,
                SWITCHBOARD_WORKSPACE_ROOT: this.workspaceRoot,
            };
            console.log(`[GoPtyFleetProjection] remote seat '${name}' (machine '${machineId}'): SWITCHBOARD_SERVER_URL=${boardEndpoint} (source: tailnet listener bind)`);
        }
        // inner = per-machine CLI; composed = what the pty types. For `local`
        // (or no transport prefix) they are identical.
        const innerCli = effectiveStartupCommand;
        const composedCli = innerCli ? GlobalIntegrationConfigService.renderSpawnCommand(innerCli, machine, seatEnv) : undefined;

        // ── tmux as a SUPPLEMENT to the fleet, not a replacement ────────────────
        // The seat stays a Go-host PTY; that PTY runs a tmux client. The board keeps
        // rendering the pane through the socket it always used, and the same terminal
        // is reachable with `tmux attach`.
        //
        // The original design made tmux an "alternative backend" — seats left the fleet
        // entirely, so turning tmux on emptied the terminals pane. Wrong trade: the
        // board is the primary surface and tmux is a second way in, never a substitute.
        //
        // `-A` is attach-or-create, which is what makes a restart cheap: the restart
        // kills the PTY, the tmux session and the agent inside it survive, and the next
        // spawn of the same name reattaches to the still-running agent.
        //
        // `usesControlMode` is captured BEFORE the chain is built so the Go host can
        // be told, at create time, that this seat's pty will speak tmux control mode.
        // The Go host uses it to demux the byte stream through the control-mode parser
        // and to encode input as `send-keys` — a fallback here would make a
        // control-mode seat indistinguishable from a raw one, so it is an explicit
        // flag, never inferred from the stream.
        // TWO SEPARATE DECISIONS. They were one variable, and collapsing them
        // turned "control mode off" into "tmux off": `usesTmuxSeating` gates the
        // whole chain below, so setting it false meant no seat got a tmux session
        // at all — no SSH attach, no surviving a board restart. Those are the
        // reasons tmux is here; control mode was only ever about who DRAWS.
        //
        // usesTmuxSeating — the seat runs inside a tmux session Switchboard owns.
        const usesTmuxSeating = !!effectiveStartupCommand && this._tmuxSeatingEnabled();
        // usesControlMode — that session is attached with `-CC` and the Go host
        // demuxes the protocol instead of rendering bytes. OFF: see the chain
        // below. Hard false rather than deleting the plumbing, since the Go host
        // still branches on `controlMode` (publish/writeToPty), so this one value
        // is the whole switch and a half-removed protocol is worse than a
        // disabled one.
        const usesControlMode = false;
        // Hoisted out of the `if (usesTmuxSeating)` block so the create
        // payload below can pass them to the Go host even on the non-control-
        // mode path (where they stay '' and the host skips the teardown). The
        // Go host stores them write-once at create time. `tmuxViewSession` is
        // the per-seat view the operator's close ends; `tmuxSession` +
        // `tmuxWindow` name the BASE session and the window inside it, which
        // fleet.close() kills to end the agent itself (close closes it — see
        // change 2 of the tmux-windows-duplicate-on-re-seat plan).
        let view = '';
        let tmuxSessionName = '';
        let tmuxWindowName = '';
        if (usesTmuxSeating) {
            const session = deriveTmuxSessionName(opts?.tmuxSession || name || role);
            const win = String(name || role).replace(/[^A-Za-z0-9_.-]/g, '-');
            // The tmux pane runs the COMPOSED command (transport-wrapped) so an
            // SSH/mosh seat's remote CLI is what tmux sends to the pane, not
            // the bare inner cli. See the plan
            // `agents-are-saved-per-machine-and-a-team-picks-one`.
            const inner = JSON.stringify(composedCli ?? effectiveStartupCommand);
            // `new-session -A` ATTACHES when the session exists and ignores -n, so a
            // second seat joining a team session would land on the first seat's window
            // instead of getting its own. Branch explicitly: create the session with
            // this seat's window, or add a window to the session already there. Then
            // attach to OUR window by name, never to the session's current one.
            // A tmux SESSION has one current window, shared by every client attached to
            // it. Attaching each seat to `session:window` therefore made all four panes
            // render whichever window was selected last — the grid said lead/coder/
            // coder/intern and showed the same terminal four times.
            //
            // A session GROUP is the fix: grouped sessions share their window list but
            // each keeps its OWN current window. So the team is one set of windows
            // (`tmux attach -t lc-coding-team` shows the whole team, prefix-n cycles it)
            // while every seat gets a private view pinned to its own window.
            // The view's suffix must not repeat the team name. A member's friendlyName
            // is already `<team>-<role>` (Coding-coder-1), so `${session}-${win}` gave
            // lc-coding-team-Coding-coder-1 — "coding" twice. Strip the team's slug off
            // the front of the window slug; the head, whose window IS the team name,
            // strips to nothing and falls back to its role.
            const winSlug = win.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
            const teamSlug = session.replace(/^lc-/, '').replace(/-team$/, '');
            const strippedSuffix = winSlug.replace(new RegExp(`^${teamSlug}-?`), '');
            // A SOLO seat (no `tmuxSession` — a standalone terminal, not a team
            // head or member) has no siblings to isolate a current-window
            // pointer from, so it attaches to its session directly and gets NO
            // grouped view session. The empty-stripped-suffix case is exactly
            // "this window IS the session"; the previous fallback to the role
            // fired for EVERY standalone terminal (lc-planner-1-planner) and
            // doubled the session count for nothing — observed 14 sessions for
            // 9 panes, four of them inert base sessions no client ever attached
            // to. A genuine team head keeps the role fallback: its session also
            // holds its siblings' windows, so it needs its own view pinned to
            // its own window.
            const isSoloSeat = !opts?.tmuxSession;
            const suffix = isSoloSeat ? '' : (strippedSuffix || role.toLowerCase());
            view = isSoloSeat ? session : `${session}-${suffix}`;
            tmuxSessionName = session;
            tmuxWindowName = win;
            effectiveStartupCommand =
                // Reuse the seat's window if it is already there. `has-session`
                // only answers "does the TEAM session exist?", so on a restart
                // an unconditional `new-window` added a SECOND window with the
                // same name — tmux permits duplicate window names, so four more
                // windows accumulated on every team start (observed: 12 windows
                // for 4 seats, three generations deep). The name test below
                // (`grep -Fxq -- "${win}"`: fixed-string `-F`, exact-line `-x`,
                // quiet `-q`, `--` end-of-options) makes the three-branch
                // decision explicit: no session → create it with this window;
                // session but no window → add the window; session AND window →
                // reuse, and the startup command does NOT run again (the agent
                // is already alive in that window — the behaviour the comment
                // at :227 always claimed and never delivered). `grep -Fxq --
                // "${win}"` matches the whole name literally so `Coding` cannot
                // match `Coding-coder-1`, and the `--` + quotes stop a window
                // name beginning with `-` being read as a flag.
                //
                // `if`/`elif`/`else`, NOT `&&`/`||` chaining. The old chain was
                // `has-session && new-window || new-session`, and in shell
                // `A && B || C` runs C when B fails — so a `new-window` failure
                // fell through to `new-session` on a session that already existed
                // (which failed too), and the seat was left attaching to a
                // window nothing created. Keeping the chain shape while adding a
                // third branch would preserve that trap.
                //
                // `flock` on a per-session lockfile serializes the test-and-
                // create: two concurrent starts of the same team (a double
                // press, or a re-seat while a start is in flight) cannot both
                // find no session and both `new-session`, and cannot both miss
                // the window test and both `new-window`. A race-created
                // duplicate does NOT collapse on the next re-seat — the
                // existence test is satisfied by EITHER copy — so the race is
                // prevented, not tolerated. The lock is released before
                // `exec tmux` so the attached client never holds it. `flock`
                // failing (absent, or the lockfile unwritable) degrades to
                // unlocked, never to a blocked seat.
                `exec 9>\"\${TMPDIR:-/tmp}/switchboard-tmux-${session}.lock\" 2>/dev/null; flock 9 2>/dev/null || true; `
                // Capture the window id at creation (`-P -F '#{window_id}'`) into
                // $wid. A name is not unique across generations — the failure this
                // card fixes — so the id is resolved once and every later target
                // (set-window-option, select-window) uses the id, never the name.
                // The reuse branch (session AND window exist) leaves $wid empty;
                // the name-lookup fallback below resolves it. $wid is a shell
                // variable, not a JS interpolation — `$wid` has no braces, so the
                // template literal passes it through literally.
                + `wid=''; `
                + `if ! tmux has-session -t ${session} 2>/dev/null; then `
                + `wid=$(tmux new-session -d -P -F '#{window_id}' -s ${session} -n ${win} ${inner} 2>/dev/null); `
                + `elif ! tmux list-windows -t ${session} -F '#{window_name}' 2>/dev/null | grep -Fxq -- "${win}"; then `
                + `wid=$(tmux new-window -d -P -F '#{window_id}' -t ${session} -n ${win} ${inner} 2>/dev/null); `
                + `fi; `
                + `flock -u 9 2>/dev/null || true; exec 9>&- 2>/dev/null; `
                // Resolve $wid by name when creation captured nothing — the reuse
                // path, or a creation whose -P output was empty. list-windows -F
                // prints 'name id' per line; awk picks the id of the first window
                // whose name matches the seat's own. This fallback is the path
                // that remains ambiguous across duplicate generations; reaping
                // the previous generation (the sibling card) removes the
                // ambiguity. Until then the creation path above — which captures
                // the id directly — is the one a fresh start takes.
                + `if [ -z \"$wid\" ]; then wid=$(tmux list-windows -t ${session} -F '#{window_name} #{window_id}' 2>/dev/null | awk -v w=\"${win}\" '$1==w{print $2; exit}'); fi; `
                // `has-session || new-session -d`, NOT `new-session -A -d`. Under
                // `-A` new-session behaves as attach-session, and `-d` is not
                // attach-session's detach flag (`-D` is) — so on a RE-SEAT, where
                // the view already exists, it ATTACHES and never returns. The rest
                // of the chain never runs: `select-window` never fires, the seat
                // stays pointed at a previous generation's window, and every prompt
                // is delivered to the old agent while the API reports success.
                // Invisible outside a pty, which is why it survived. The explicit
                // form states the intent — ensure the view exists, attach nothing.
                // A SOLO seat skips this entirely: `view === session`, so there
                // is no grouped view to create, and the pane attaches to the
                // session itself.
                + (isSoloSeat ? '' : `tmux has-session -t ${view} 2>/dev/null || tmux new-session -d -t ${session} -s ${view}; `)
                // Control mode (`-CC`) makes tmux stop drawing the pane and emit
                // line-oriented notifications instead; the board renders the agent
                // as a plain terminal. That removes the need for the per-view
                // suppressions this chain used to carry: tmux no longer draws a
                // status line, no longer interprets a prefix key, and no longer
                // arbitrates window size between competing clients. The base
                // session an operator attaches to over SSH keeps all of its own
                // options — these are per-view, never `-g`. For a solo seat
                // `view === session`, so they apply to the session the pane
                // attaches to (the strip must move with the pane or it returns).
                //
                // `window-size manual` gives the browser panel deterministic
                // authority over pane geometry — under the default `latest`, a
                // second attached client (SSH) ping-pongs the window size, which is
                // the exact arbitration failure `aggressive-resize` used to paper
                // over. Under `manual`, `clients_calculate_size` skips the client
                // loop and the window uses its manual size, driven by the board's
                // `refresh-client -C`. `automatic-rename off` stops
                // `%window-renamed` from firing on every command the agent runs,
                // which would otherwise thrash any board re-render on rename.
                //
                // `set-window-option` and `select-window` target $wid — the stable
                // window id — not `${view}:${win}`. A name resolves to the
                // lowest-index window carrying it, so with a previous generation's
                // duplicate still present `select-window -t ${view}:${win}` picked
                // the OLD window even after the block above was fixed. The id is
                // unambiguous. `select-window -t ${view}:${wid}` pins the VIEW
                // session's current window (grouped sessions each keep their own);
                // `set-window-option -t ${wid}` targets the window directly.
                // `smallest`, not `manual`. `manual` was chosen when control mode
                // arbitrated pane geometry and the browser needed sole authority
                // over it. Control mode is gone, and what `manual` does now is pin
                // a window at whatever size it was born at and refuse every other
                // client — so a second client (an SSH session, a phone) attached
                // to a window TALLER than its terminal sees the top of it and
                // nothing else. The agent's composer is drawn at the BOTTOM, so
                // the operator types into a line that is off the bottom of the
                // screen: input arrives, nothing appears, and the terminal reads
                // as broken. Measured 2026-09-13: window `Coding` was 48x41 with
                // an SSH client at 59x25 — sixteen rows, including the composer,
                // below the fold.
                //
                // `smallest` sizes the window to the smallest attached client, so
                // every client sees the whole thing. That is the right trade for a
                // window several people watch: a clipped view that silently eats
                // typing is worse than a narrower one everybody can read.
                //
                // Set on BOTH the view and the base: grouped sessions share one
                // window list, so a `manual`/`smallest` split across the group
                // leaves whichever session holds the stricter policy pinning the
                // window for everyone.
                + `tmux set-option -t ${view} window-size smallest 2>/dev/null; `
                + `tmux set-option -t ${session} window-size smallest 2>/dev/null; `
                + `tmux set-window-option -t $wid automatic-rename off 2>/dev/null; `
                + `tmux select-window -t ${view}:$wid; `
                // `-u` forces UTF-8 mode so `utf8_sanitize` does not replace
                // non-ASCII bytes with `_` in format output (window names, pane
                // titles, `list-panes`/`capture-pane` format strings) on a headless
                // Pi where `LANG` may be unset. `%output` and `capture-pane -p`
                // bypass that path and are byte-exact regardless.
                // CONTROL MODE IS OFF. `exec tmux -u attach`, not `-u -CC attach`.
                //
                // Control mode puts a protocol parser between the agent and the
                // screen: tmux stops drawing and emits `%output`/`%begin` lines the
                // host must decode. Twelve distinct defects came out of that parser
                // in a single day — %extended-output dropped, block content wrongly
                // octal-decoded, no pane filter so seats crossed streams, %pause
                // armed with no resume, the DCS only matched at offset 0, 5 of 8
                // commands never pushed the block FIFO, `send-keys -lt -t`
                // delivering nothing while exiting 0, a missing space making the
                // target `%7hello`, the replay duplicating the visible screen, the
                // seating chain echoed into the pane, the FIFO double-pushed, and
                // `capture-pane -t %` issued before the pane id was known.
                //
                // The count is not the argument; the failure SHAPE is. A plain
                // attach has no interpretation in the path, so a bug cannot put
                // protocol text on the operator's screen or silently eat their
                // keystrokes. Every one of those twelve reported success while
                // delivering nothing.
                //
                // The parser and its fixes stay in the Go host, unreferenced at
                // runtime once `controlMode` is false. Re-enabling is this line plus
                // `usesControlMode` above, and should happen against a plan with a
                // live-seat acceptance gate — which is what was missing.
                + `exec tmux -u attach -t ${view}`;
        }

        const result = await this.supervisor.request('ptyCreateTerminal', {
            role,
            name,
            cwd: effectiveCwd,
            worktreePath,
            parentInstanceId: parentInstanceId ?? undefined,
            // Host-generated so the same id is inlined into a remote seat's
            // composed command (seatEnv above) AND set on the local pty env by
            // the Go host. A respawn replays the composed string verbatim, so
            // the remote env re-delivers itself without re-reading live config.
            agentInstanceId,
            hidden: opts?.hidden === true,
            claudeInlineRendering,
            apiToken: this.apiToken,
            _isTeamMember: opts?._isTeamMember === true,
            controlMode: usesControlMode,
            // The per-seat VIEW tmux session name, derived above as
            // `${session}-${suffix}` (or `session` for a solo seat). The Go host
            // stores it write-once at create time and fleet.close() reads it to
            // issue `tmux kill-session -t =<view>` when the operator closes the
            // seat. Empty for non-control-mode seats (view stays '' above) so
            // the Go host's close() skips the kill-session — matching the
            // extension host, which never sets controlMode.
            tmuxViewSession: view,
            // The BASE tmux session + the window name inside it. fleet.close()
            // kills the window (`tmux kill-window -t =<session>:<window>`) to
            // end the agent itself — closing a terminal closes it, not just the
            // pane's view onto it (change 2 of the
            // tmux-windows-duplicate-on-re-seat plan). After change 1 window
            // names are unique within a session, so the target is unambiguous.
            // Empty for non-control-mode seats; close() skips the kill-window.
            tmuxSession: tmuxSessionName,
            tmuxWindow: tmuxWindowName,
            // Recorded by the Go host so a clearStrategy "respawn" clear can
            // re-inject the seat's startup command verbatim — the only way a
            // declared --model holds across a reset, since /clear restarts
            // Devin's session internally and never re-reads the startup
            // command. The Go host replays this string into a fresh login
            // shell; it never re-derives or parses it. See
            // a-seats-clear-strategy-is-declared-per-cli-family-not-assumed.md.
            //
            // Machine threading: for a non-tmux seat this is the COMPOSED
            // command (transport-wrapped), so an SSH/mosh respawn re-runs the
            // remote CLI. For a tmux seat the chain above already reassigned
            // `effectiveStartupCommand` to the tmux command string (which
            // embeds the composed command in its send-keys).
            startupCommand: usesTmuxSeating ? effectiveStartupCommand : composedCli,
            startupCommandInner: innerCli,
            // The COMPOSED cli with NO tmux chain around it — the exact string
            // the seating chain hands to `tmux new-window`. A tmux seat's
            // respawn hands this back to `tmux respawn-window -k`, because the
            // pty is only the attach client and `startupCommand` above is the
            // whole chain (ending in `exec tmux attach`, so an argv suffix on
            // it is a usage error). Sent unconditionally so the Go host never
            // has to tell a tmux seat from a non-tmux one to read it.
            startupCommandComposed: composedCli,
            machineId,
        });
        if (!result || result.success === false) {
            throw new Error(result?.error || `PTY create failed (state: ${this.supervisor.getState()})`);
        }
        const row = (result.terminal || result) as ProjectedTerminal;
        const handle = this.materialize({
            ...row,
            friendlyName: row.friendlyName || name,
            role: row.role || role,
            cwd: row.cwd || effectiveCwd,
            worktreePath: row.worktreePath || worktreePath,
            parentInstanceId: row.parentInstanceId ?? parentInstanceId,
            hidden: opts?.hidden === true,
            claudeInlineRendering,
            _isTeamMember: opts?._isTeamMember === true,
            // COMPOSED command (or the tmux chain string) — what the pty types.
            startupCommand: usesTmuxSeating ? effectiveStartupCommand : composedCli,
            // INNER cli — what cliFamily re-derivation reads. Never transport-wrapped.
            startupCommandInner: innerCli,
            startupCommandSource: effectiveStartupSource,
            cliFamily: deriveCliFamily(innerCli),
            machineId,
            // Persisted in `runtime.terminals` so the boot reaper has an
            // ownership signal that survives a restart — the in-memory cache
            // is empty at boot. Empty (not undefined) for non-control-mode
            // seats; the reaper treats an empty `tmuxSession` as "no claim".
            tmuxSession: tmuxSessionName || undefined,
        });
        this.cache.set(handle.friendlyName, handle);
        this.updateRegistryState();
        this.emitter.emit('change', { type: 'created', terminal: handle });

        const injectCommand = usesTmuxSeating ? effectiveStartupCommand : composedCli;
        if (injectCommand) {
            await new Promise(resolve => setTimeout(resolve, SHELL_READINESS_DELAY_MS));
            if (handle.status === 'active') {
                handle.injectedAtMs = Date.now();
                handle.outputBytesSinceInjection = 0;
                handle.sendText(injectCommand, true);
            }
        }
        return handle;
    }

    public async spawnDelegates(
        parent: ExtendedTerminalHandle,
        definitions: DelegateDefinition[],
        opts?: { teamName?: string; tmuxSession?: string; machineId?: string },
    ): Promise<{ children: ExtendedTerminalHandle[]; createdNames: string[]; error?: string }> {
        // Machine threading: every delegate inherits the TEAM's machine
        // (opts.machineId, falling back to the parent's machineId). Per-member
        // startupCommand is retired — a team is one machine. See the plan
        // `agents-are-saved-per-machine-and-a-team-picks-one`.
        const delegateMachineId = opts?.machineId || parent.machineId || 'local';
        const perTeamRequested = definitions
            .filter(d => d.scope !== 'shared')
            .reduce((n, d) => n + Math.max(1, Math.min(d.count || 1, MAX_DELEGATES_PER_PARENT)), 0);
        if (perTeamRequested > MAX_DELEGATES_PER_PARENT) {
            return { children: [], createdNames: [], error: `Delegate cap: ${perTeamRequested} requested, ${MAX_DELEGATES_PER_PARENT} allowed per head agent` };
        }
        const liveDelegates = Array.from(this.cache.values()).filter(t => t.parentInstanceId).length;
        if (liveDelegates + perTeamRequested > MAX_LIVE_DELEGATE_PTYS) {
            return { children: [], createdNames: [], error: `Delegate cap: ${liveDelegates} live, ${perTeamRequested} requested, ${MAX_LIVE_DELEGATE_PTYS} allowed in total` };
        }

        const children: ExtendedTerminalHandle[] = [];
        const createdNames: string[] = [];
        for (const d of definitions) {
            const count = Math.max(1, Math.min(d.count || 1, MAX_DELEGATES_PER_PARENT));
            if (d.scope === 'shared') {
                const teamName = opts?.teamName || 'team';
                const sharedBaseName = `${teamName}-${d.label || d.role}`;
                for (let i = 0; i < count; i++) {
                    const suffix = count > 1 ? `-${i + 1}` : '';
                    const sharedName = `${sharedBaseName}${suffix}`;
                    let wasCreated = false;
                    try {
                        const existing = await this._sharedMemberChain(sharedName, async () => {
                            const live = this.listActive().find(t => t.friendlyName === sharedName);
                            if (live) { return live; }
                            wasCreated = true;
                            return this.create(d.role, sharedName, parent.cwd, parent.worktreePath, undefined, undefined, {
                                _isTeamMember: true,
                                claudeInlineRendering: parent.claudeInlineRendering,
                                tmuxSession: opts?.tmuxSession,
                                machineId: delegateMachineId,
                            });
                        });
                        children.push(existing);
                        if (wasCreated) { createdNames.push(existing.friendlyName); }
                    } catch (err) {
                        return { children, createdNames, error: `Shared member '${sharedName}' failed to spawn: ${err instanceof Error ? err.message : String(err)}` };
                    }
                }
                continue;
            }
            for (let i = 0; i < count; i++) {
                const suffix = count > 1 ? `-${i + 1}` : '';
                const baseName = `${parent.friendlyName}-${d.label || d.role}${suffix}`;
                try {
                    const child = await this.create(
                        d.role, baseName, parent.cwd, parent.worktreePath, parent.agentInstanceId, undefined,
                        { _isTeamMember: true, claudeInlineRendering: parent.claudeInlineRendering, tmuxSession: opts?.tmuxSession, machineId: delegateMachineId },
                    );
                    children.push(child);
                    createdNames.push(child.friendlyName);
                } catch (err) {
                    return { children, createdNames, error: `Delegate '${baseName}' failed to spawn: ${err instanceof Error ? err.message : String(err)}` };
                }
            }
        }
        return { children, createdNames };
    }

    public async createBatch(
        allocation: Array<{ role: string; count: number }>,
        cwd?: string,
        worktreePath?: string,
        claudeInlineRendering?: boolean,
        machineId?: string,
    ): Promise<{ success: boolean; created: Array<{ friendlyName: string; role: string }>; failed: Array<{ role: string; reason: string; kind: string }>; error?: string; estimatedDurationMs: number }> {
        const MAX_BATCH = 32;
        const created: Array<{ friendlyName: string; role: string }> = [];
        const failed: Array<{ role: string; reason: string; kind: string }> = [];
        if (!Array.isArray(allocation) || allocation.length === 0) {
            return { success: false, created, failed, error: 'allocation must be a non-empty array', estimatedDurationMs: 0 };
        }
        let total = 0;
        for (const a of allocation) {
            const count = Number(a?.count);
            if (!Number.isInteger(count) || count < 1) {
                return { success: false, created, failed, error: `count for role '${a?.role}' is not a positive integer`, estimatedDurationMs: 0 };
            }
            total += count;
        }
        if (total > MAX_BATCH) {
            return { success: false, created, failed, error: `batch cap: ${total} requested, ${MAX_BATCH} allowed`, estimatedDurationMs: 0 };
        }
        const resolvedMachineId = machineId || 'local';
        const commands = await GlobalIntegrationConfigService.getAgentStartupCommands(resolvedMachineId) || {};
        for (const a of allocation) {
            if (typeof a.role !== 'string' || !commands[a.role]) {
                return { success: false, created, failed, error: `no startup command for role '${a.role || ''}' on machine '${resolvedMachineId}'`, estimatedDurationMs: 0 };
            }
        }
        let abortResource = false;
        for (const a of allocation) {
            for (let i = 0; i < a.count; i++) {
                if (abortResource) {
                    failed.push({ role: a.role, reason: 'aborted after earlier resource failure', kind: 'aborted' });
                    continue;
                }
                try {
                    const t = await this.create(a.role, undefined, cwd, worktreePath, null, undefined, { claudeInlineRendering, machineId: resolvedMachineId });
                    created.push({ friendlyName: t.friendlyName, role: t.role });
                } catch (err: any) {
                    const msg = err instanceof Error ? err.message : String(err);
                    let kind = 'unknown';
                    if (/posix_openpt failed: Device not configured|No space left on device/i.test(msg)) { kind = 'pty-pool-exhausted'; }
                    else if (/posix_openpt failed: Too many open files|File table overflow/i.test(msg)) { kind = 'fd-limit'; }
                    else if (/posix_spawnp failed|spawn-helper ENOENT|PTY/i.test(msg)) { kind = 'spawn-failed'; }
                    failed.push({ role: a.role, reason: msg, kind });
                    if (kind === 'pty-pool-exhausted' || kind === 'fd-limit') { abortResource = true; }
                }
            }
        }
        return {
            success: created.length > 0 && failed.length === 0,
            created,
            failed,
            estimatedDurationMs: total * SHELL_READINESS_DELAY_MS,
            ...(failed.length > 0 && created.length === 0 ? { error: failed.map(f => `${f.role}: ${f.reason}`).join('; ') } : {}),
        };
    }

    public kill(name: string): boolean {
        const handle = this.cache.get(name);
        if (!handle) { return false; }
        const children = this.listChildren(handle.agentInstanceId);
        for (const child of children) { this.kill(child.friendlyName); }
        (handle as any)._live?.close?.();
        this.cache.delete(name);
        void this.supervisor.request('ptyCloseTerminal', { name }).catch(() => { /* already gone */ });
        this.updateRegistryState();
        this.emitter.emit('change', { type: 'closed', name });
        return true;
    }

    public rename(name: string, newAlias: string): boolean {
        const handle = this.cache.get(name);
        if (!handle || this.cache.has(newAlias)) { return false; }
        void this.supervisor.request('ptyRenameTerminal', { name, alias: newAlias }).catch(() => { /* best-effort */ });
        this.cache.delete(name);
        handle.friendlyName = newAlias;
        (handle as any).name = newAlias;
        this.cache.set(newAlias, handle);
        this.updateRegistryState();
        this.emitter.emit('change', { type: 'renamed', oldName: name, newName: newAlias });
        return true;
    }

    public async disposeAll(): Promise<void> {
        const names = Array.from(this.cache.keys());
        for (const name of names) { this.kill(name); }
        this.cache.clear();
        await this.supervisor.stop();
        this.updateRegistryState();
    }

    public static async purgePtyTerminals(db: KanbanDatabase): Promise<void> {
        try {
            const parsed = db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {});
            if (!parsed || typeof parsed !== 'object') { return; }
            let modified = false;
            for (const key of Object.keys(parsed)) {
                const item = parsed[key];
                if (item && (item.purpose === 'pty' || item.ideName === PTY_IDE_NAME)) {
                    delete parsed[key];
                    modified = true;
                }
            }
            if (modified) { await db.setConfigJson('runtime.terminals', parsed); }
        } catch (err) {
            console.warn('[GoPtyFleetProjection] Failed to purge PTY terminals on boot:', err);
        }
    }

    private _findSingletonHandle(identity: string): ExtendedTerminalHandle | undefined {
        for (const t of this.cache.values()) {
            if (singletonIdentityForRole(t.role) === identity) { return t; }
        }
        if (this._controllerSeatResolver) {
            try {
                const seatName = this._controllerSeatResolver()?.terminalName;
                if (seatName) { return this.cache.get(seatName); }
            } catch { /* best-effort */ }
        }
        return undefined;
    }

    private async _sharedMemberChain<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const chain = this._sharedMemberChains.get(name) || Promise.resolve();
        const p = chain.then(() => fn());
        const guarded = p.catch(() => {});
        this._sharedMemberChains.set(name, guarded);
        try {
            return await p;
        } finally {
            if (this._sharedMemberChains.get(name) === guarded) { this._sharedMemberChains.delete(name); }
        }
    }

    private _recordRecentlyClosed(name: string): void {
        if (this.recentlyClosed.has(name)) { this.recentlyClosed.delete(name); }
        this.recentlyClosed.set(name, Date.now());
        while (this.recentlyClosed.size > GoPtyFleetProjection.RECENTLY_CLOSED_CAP) {
            const oldest = this.recentlyClosed.keys().next().value;
            if (oldest === undefined) { break; }
            this.recentlyClosed.delete(oldest);
        }
    }

    /**
     * Reconcile the cache against the Go host's authoritative roster, for READ
     * paths.
     *
     * Why a read path needs this at all: `_ptyHostVerb` prefers
     * `_ptyHostSupervisor` over `_fleetVerb` (TaskViewerProvider.ts), and the
     * standalone host wires BOTH, so every `_ptyHostVerb` create goes straight to
     * the Go child and never touches this projection. Two such paths are
     * reachable under standalone — `createFleetTerminalAndDeliver` (Planning /
     * sidebar dispatch to a role with no seat yet) and `ensureWorktreeTerminals`
     * -> `_createAutobanTerminal` (worktree create). Standalone's
     * `ptyListTerminals` answers from `list()`, i.e. this cache, so a seat created
     * that way was absent from the sidebar, from `getLiveness()` (the activity-
     * light sweep then had no evidence for it and its card fell through to the
     * blind timer), and from `listActive()` turn-end recipient resolution — and it
     * had no live stream, so the natural-exit emit never fired for it either. The
     * extension host is unaffected because its `ptyListTerminals` arm returns the
     * Go child's own reply.
     *
     * Single-flighted: concurrent readers share one round-trip. `create()` calls
     * `refresh()` directly instead, because its name-collision loop needs a
     * snapshot taken after its own call rather than one a coalesced caller started
     * earlier.
     */
    public reconcile(): Promise<void> {
        if (!this._reconcileInFlight) {
            this._reconcileInFlight = this.refresh().finally(() => { this._reconcileInFlight = null; });
        }
        return this._reconcileInFlight;
    }

    private async refresh(): Promise<void> {
        // Names present BEFORE the round-trip. Eviction is scoped to these so a
        // handle added by a concurrent create() while the request was in flight
        // survives. The previous implementation replaced `this.cache` wholesale
        // with a map built from a snapshot that predated the new seat, which
        // dropped the handle and orphaned its live socket — a lost update that was
        // rare while `create()` was the only caller and is reachable on every list
        // now that read paths reconcile.
        const before = new Set(this.cache.keys());
        const listed = await this.supervisor.request('ptyListTerminals', {});
        const rows: ProjectedTerminal[] = Array.isArray(listed?.terminals) ? listed.terminals : [];
        // MERGE IN PLACE, never rebuild. The Go host lists from a Go map
        // (`for _, t := range f.terminals`), whose iteration order is randomized
        // by design, so rebuilding the cache from `rows` reshuffled it on every
        // refresh — a sidebar that reorders itself on every push, and a random
        // pick for `reportSingletonDuplicates`'s keeper. Merging preserves
        // creation order.
        //
        // The loop below is await-free, so it runs to completion as a single task:
        // a second concurrent refresh cannot interleave and materialize the same
        // row twice, which would open two sockets for one terminal and leak one.
        const seen = new Set<string>();
        for (const row of rows) {
            seen.add(row.friendlyName);
            // `rename()` fires its host request without awaiting, so a reconcile
            // can arrive while the host still reports the OLD name and the cache
            // already holds the NEW one. Fall back to the instance id, which
            // survives a rename and which the Go host stamps on every row
            // (`fleet.project`, cmd/switchboard-pty-host/main.go) — verified in the
            // emitted map literal, not in the optional TS field. Without this the
            // row materializes a duplicate handle, and a second socket, for a
            // terminal that is already cached.
            const existing = this.cache.get(row.friendlyName)
                ?? (row.agentInstanceId ? this.getByAgentInstanceId(row.agentInstanceId) : undefined);
            if (existing) {
                existing.status = row.status === 'exited' ? 'exited' : 'active';
                existing.lastDataAt = row.lastDataAt ?? existing.lastDataAt;
                existing.promptCount = row.promptCount ?? existing.promptCount;
                if (row.pid) { existing.pty = { ...existing.pty, pid: row.pid }; }
                // Its own key, which may differ from `row.friendlyName` on the
                // rename path above — otherwise the eviction pass below would drop
                // the handle it just matched.
                seen.add(existing.friendlyName);
                continue;
            }
            this.cache.set(row.friendlyName, this.materialize(row));
        }
        for (const name of before) {
            if (seen.has(name)) { continue; }
            // Close the live socket on eviction, as `kill()` does before its own
            // delete. The wholesale replace this rewrites leaked one socket per
            // evicted handle; that cost little while eviction was rare and costs
            // more now that every list reconciles.
            const stale = this.cache.get(name);
            (stale as any)?._live?.close?.();
            this.cache.delete(name);
        }
    }

    private attachLiveStream(
        name: string,
        dataListeners: Set<(chunk: string) => void>,
        exitListeners: Set<(code: number | undefined) => void>,
        handle: ExtendedTerminalHandle,
    ): { sendResize: (cols: number, rows: number) => void; close: () => void } {
        let socket: WebSocket | undefined;
        let closed = false;
        let pendingResize: { cols: number; rows: number } | undefined;
        const ready = this.supervisor.getReady();
        const sendResize = (cols: number, rows: number) => {
            pendingResize = { cols, rows };
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ t: 'resize', cols, rows }));
            }
        };
        const close = () => {
            closed = true;
            try { socket?.close(); } catch { /* ignore */ }
            socket = undefined;
        };
        if (!ready) { return { sendResize, close }; }
        const url = `ws://127.0.0.1:${ready.port}/ws/terminal?name=${encodeURIComponent(name)}&token=${encodeURIComponent(ready.terminalToken)}`;
        socket = new WebSocket(url);
        socket.on('open', () => {
            if (closed) { socket?.close(); return; }
            if (pendingResize && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ t: 'resize', cols: pendingResize.cols, rows: pendingResize.rows }));
            }
        });
        socket.on('message', (raw, isBinary) => {
            // Terminal output arrives as a BINARY frame — 4-byte big-endian seq
            // followed by UTF-8 (`encodeOutputFrame`, cmd/switchboard-pty-host/ws.go
            // and main.go's publish). Only `hello` and `exit` are JSON.
            //
            // This handler used to parse EVERY frame as JSON and `return` on failure,
            // so once the host moved output onto binary frames every chunk was
            // silently discarded here. That froze `lastDataAt`, and the freeze is not
            // inert: the Go host stamps `lastDataAt` at spawn, so the value stays
            // POSITIVE while never advancing. Every nudge site guards with
            // `lastDataAt <= 0 || now - lastDataAt < turnEndSilenceMs` — a frozen
            // positive stamp defeats the `<= 0` fail-safe and reads as "silent for
            // hours", the most confident possible wrong answer, so stall nudges fire
            // into actively working seats and the dead-seat sweep clears the card's
            // `owner_since` — blanking a working card's activity light.
            //
            // Decode binary first; fall back to the JSON arms for control frames.
            if (isBinary && Buffer.isBuffer(raw) && raw.length >= 4) {
                handle.lastDataAt = Date.now();
                handle.hasProducedOutput = true;
                const chunk = raw.subarray(4).toString('utf8');
                for (const cb of dataListeners) { cb(chunk); }
                return;
            }
            let message: { t?: string; data?: string; code?: number };
            try { message = JSON.parse(String(raw)); } catch { return; }
            if ((message.t === 'output' || message.t === 'replay') && typeof message.data === 'string') {
                handle.lastDataAt = Date.now();
                handle.hasProducedOutput = true;
                for (const cb of dataListeners) { cb(message.data); }
            } else if (message.t === 'exit') {
                handle.status = 'exited';
                handle.exitCode = message.code;
                for (const cb of exitListeners) { cb(message.code); }
                // Emit a fleet change so onDidChange subscribers (the
                // terminalsChanged push in bootstrap.ts) learn about natural
                // CLI exit. kill() emits {type:'closed'} itself, but a CLI
                // that exits on its own only reaches this arm — without this
                // emit the push never fires and the sidebar shows the seat
                // active until the next poll (now deleted). The extra emit
                // when kill() already removed the handle is harmless: the
                // client coalesces, and a second push for an already-closed
                // seat is a no-op refetch. Do NOT guard with
                // `if (this.cache.has(name))` — kill() deletes from cache
                // before the WebSocket closes, so that guard would suppress
                // the exit push for a seat killed while still running.
                this.emitter.emit('change', { type: 'closed', name });
            }
        });
        return { sendResize, close };
    }

    private materialize(row: ProjectedTerminal): ExtendedTerminalHandle {
        const name = row.friendlyName;
        const dataListeners = new Set<(chunk: string) => void>();
        const exitListeners = new Set<(code: number | undefined) => void>();
        const startedAtMs = Date.now();
        const handle: ExtendedTerminalHandle = {
            name,
            friendlyName: name,
            role: row.role || 'coder',
            agentInstanceId: row.agentInstanceId || crypto.randomUUID(),
            parentInstanceId: row.parentInstanceId,
            startTime: row.startTime || new Date().toISOString(),
            status: row.status === 'exited' ? 'exited' : 'active',
            worktreePath: row.worktreePath,
            cwd: row.cwd || this.workspaceRoot,
            cliFamily: row.cliFamily || deriveCliFamily(row.startupCommandInner || row.startupCommand),
            startupCommand: row.startupCommand,
            startupCommandInner: row.startupCommandInner,
            startupCommandSource: row.startupCommandSource,
            machineId: row.machineId,
            tmuxSession: row.tmuxSession,
            startedAtMs,
            lastDataAt: row.lastDataAt || startedAtMs,
            promptCount: row.promptCount || 0,
            hidden: row.hidden === true,
            claudeInlineRendering: row.claudeInlineRendering,
            _isTeamMember: row._isTeamMember === true,
            pty: {
                pid: row.pid || 0,
                // `teardown: true` — this is the shutdown path (disposeAll on
                // board stop), NOT an operator closing a seat. Without it the Go
                // host treats it as an operator close and kills the seat's tmux
                // session, so every board restart destroyed the whole fleet.
                kill: (signal?: string) => { void this.supervisor.request('ptyCloseTerminal', { name, signal, teardown: true }).catch(() => { /* ignore */ }); },
            },
            sendText: (text: string, addNewLine?: boolean) => {
                void this.supervisor.request('ptyWrite', { name, data: addNewLine ? `${text}\r` : text }).catch(() => { /* ignore */ });
            },
            write: (data: string) => {
                void this.supervisor.request('ptyWrite', { name, data }).catch(() => { /* ignore */ });
            },
            onData: (cb: (chunk: string) => void) => {
                dataListeners.add(cb);
                return { dispose: () => { dataListeners.delete(cb); } };
            },
            onExit: (cb: (code: number | undefined) => void) => {
                exitListeners.add(cb);
                return { dispose: () => { exitListeners.delete(cb); } };
            },
            resize: (cols: number, rows: number) => { stream.sendResize(cols, rows); },
            dispose: () => { stream.close(); this.kill(name); },
            kill: () => { stream.close(); this.kill(name); },
            show: () => { /* headless */ },
        } as ExtendedTerminalHandle & TerminalHandle;
        const stream = this.attachLiveStream(name, dataListeners, exitListeners, handle);
        (handle as any)._live = stream;
        return handle;
    }

    private updateRegistryState(): void {
        if (!this.db) { return; }
        const db = this.db;
        this._registryWrite = this._registryWrite.then(async () => {
            const existing = db.getConfigJsonSync<Record<string, any>>('runtime.terminals', {}) || {};
            const terminalMap: Record<string, any> = {};
            for (const [entryName, entry] of Object.entries(existing)) {
                if (entry && entry.purpose === 'pty') { continue; }
                if (entry && entry.ideName === PTY_IDE_NAME) { continue; }
                terminalMap[entryName] = entry;
            }
            for (const [entryName, t] of this.cache.entries()) {
                terminalMap[entryName] = {
                    friendlyName: t.friendlyName,
                    role: t.role,
                    status: t.status,
                    pid: t.pty?.pid,
                    startTime: t.startTime,
                    worktreePath: t.worktreePath,
                    cwd: t.cwd,
                    ideName: PTY_IDE_NAME,
                    purpose: 'pty',
                    agentInstanceId: t.agentInstanceId,
                    parentInstanceId: t.parentInstanceId,
                    cliFamily: t.cliFamily,
                    // Persisted so the boot reaper has an ownership signal
                    // that survives a restart — the in-memory cache is empty
                    // at boot. Undefined for raw PTYs; the reaper treats an
                    // absent `tmuxSession` as "no claim" and will reap the
                    // session if no other live seat claims it.
                    tmuxSession: t.tmuxSession,
                } satisfies FleetTerminalInfo;
            }
            await db.setConfigJson('runtime.terminals', terminalMap);
        }).catch(err => {
            console.warn('[GoPtyFleetProjection] Failed to update terminal registry state:', err);
        });
    }
}
