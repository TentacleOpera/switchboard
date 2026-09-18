package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/TentacleOpera/switchboard/internal/ptyhost"
	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

type terminal struct {
	name                 string
	role                 string
	cmd                  *exec.Cmd
	file                 *os.File
	pid                  int
	mu                   sync.Mutex
	status               string
	cwd                  string
	worktreePath         string
	agentInstanceId      string
	parentInstanceId     string
	startTime            string
	lastDataAt           int64
	promptCount          int
	hidden               bool
	cliFamily            string
	startupCommand       string
	startupCommandSource string
	// startupCommandInner is the per-machine CLI BEFORE transport composition
	// (e.g. `claude`), while startupCommand holds the COMPOSED command that is
	// typed into the pty and replayed on respawn (e.g. `ssh host 'claude'`).
	// Used by the TS projection to re-derive cliFamily without seeing a
	// transport-wrapped string. See the plan
	// `agents-are-saved-per-machine-and-a-team-picks-one`.
	startupCommandInner string
	// startupCommandComposed is the transport-composed CLI (inner + any
	// `ssh`/`mosh` prefix) WITHOUT the tmux seating chain wrapped around it —
	// i.e. the exact string the seating chain hands to `tmux new-window`.
	// It is the only recorded field a tmux respawn can hand back to
	// `tmux respawn-window`: startupCommand holds the whole chain (which ends
	// in `exec tmux attach`, so appending an argv suffix to it is a usage
	// error) and startupCommandInner drops the transport prefix (so an
	// ssh/mosh seat would respawn the CLI on the WRONG machine). Empty for a
	// non-tmux seat, where startupCommand already IS the composed command.
	startupCommandComposed string
	// generation counts how many times this seat's pty has been replaced by a
	// clearStrategy "respawn". readOutput captures it at spawn and compares on
	// EOF: a read error on a PREVIOUS generation's fd is the respawn closing
	// it, not the seat exiting, and must not run the exit teardown (which
	// marks the terminal exited, closes every WebSocket client and ends the
	// session log). Written under f.mu by respawnTerminal BEFORE the old fd is
	// closed, so the old goroutine can never observe a stale value.
	generation int
	// machineId is the machine this seat spawns on (`'local'` default). The
	// transport prefix lives on the machine definition (TS-side), not here.
	machineId string
	// env is the environment slice the terminal was spawned with, retained so
	// a respawn can start a fresh login shell under the SAME identity env
	// (SWITCHBOARD_TERMINAL, SWITCHBOARD_AGENT_INSTANCE_ID, SWITCHBOARD_API_TOKEN,
	// CLAUDE_CODE_*). Without it a respawned devin seat would lose its seat
	// identity and its board API token.
	env                   []string
	claudeInlineRendering bool
	isTeamMember          bool
	listenersMu           sync.Mutex
	listeners             map[chan string]struct{}
	// ── control mode (`tmux -CC`) state ──────────────────────────────────────
	// controlMode is set at create time from the ptyCreateTerminal payload. The
	// standalone host sets it for seats that run the tmux control-mode chain;
	// the extension host never sets it, so its terminals stay raw. This is the
	// one read that distinguishes "render as a plain terminal" from "render
	// tmux's UI" — a fallback here would make a control-mode seat look
	// identical to a raw one, so it is an explicit flag, never inferred.
	controlMode bool
	// tmuxViewSession is the per-seat VIEW tmux session name (e.g.
	// `lc-coding-team-coder-1`), set once at create time from the
	// ptyCreateTerminal payload under f.mu and never modified after. This is
	// the target fleet.close() kills when a control-mode terminal is closed —
	// it is NOT sessionTarget (main.go:78), which is publish-only (written on
	// the read goroutine in publish() with no lock) and would race close().
	// The standalone host derives the view name in goPtyFleetProjection.ts and
	// passes it here; the extension host never sets controlMode, so this field
	// is empty for extension terminals and close() skips the kill-session.
	// Write-once under f.mu at create, read under f.mu in close() — no race.
	tmuxViewSession string
	// tmuxSession + tmuxWindow name the BASE tmux session and the window
	// inside it that this seat's agent runs in (e.g. `lc-coding-team` +
	// `Coding-coder-1`). fleet.close() kills the window
	// (`tmux kill-window -t =<session>:<window>`) to end the agent itself
	// — closing a terminal closes it, not just the pane's view onto it.
	// After the window-reuse fix in goPtyFleetProjection.ts window names are
	// unique within a session, so `=<session>:<window>` is unambiguous. The
	// `=` prefix forces exact session-name match so `lc-coding-team` cannot
	// match `lc-coding-team-coder-1`. Empty for non-control-mode seats;
	// close() skips the kill-window. Write-once under f.mu at create, read
	// under f.mu in close() — no race.
	tmuxSession string
	tmuxWindow  string
	// tmuxMu serializes SEQUENCES of tmux commands for this seat — the
	// check-correct-verify in ensureTmuxRouting and the cache-then-resize in
	// resizeTmuxWindow. Both are read-modify-write against tmux, and both can
	// run concurrently: the spawn-time routing goroutine overlaps a first
	// prompt delivery, and resize frames arrive per fit pass.
	//
	// Deliberately NOT t.mu. t.mu is taken on every chunk by the read and write
	// paths, so holding it across a fork+exec would stall output for the length
	// of a tmux round trip. This lock is only ever held by tmux sequences, and
	// t.mu is taken and released INSIDE it for the field reads — never the
	// reverse, so the two cannot deadlock.
	tmuxMu sync.Mutex
	// tmuxSizedCols/Rows are the last size actually pushed to the seat's tmux
	// WINDOW by resizeTmuxWindow, so a stationary panel does not fork a tmux
	// process per resize frame. mu-protected. Zeroed on respawn: the seating
	// chain re-runs and the new window must be sized again from scratch.
	tmuxSizedCols uint16
	tmuxSizedRows uint16
	// tmuxWindowId is the seat's OWN window id (e.g. `@7`), the stable,
	// unambiguous handle for the window this seat's agent runs in. Captured
	// after the seating chain completes (controlActive flips + pane id is
	// learned) by querying the window containing the seat's pane — the pane
	// id is the source of truth for "the seat's own window", independent of
	// the name-based ambiguity across generations. Empty until the chain
	// completes or when tmux is unavailable; deliverPrompt falls back to
	// capturing it on the first send if the spawn-time capture has not
	// landed yet. mu-protected (written by onPaneIDLearned's verifier
	// goroutine and by deliverPrompt, read by deliverPrompt).
	tmuxWindowId string
	// tmuxMisrouted is set when the spawn-time verification found the view
	// session's current window was NOT the seat's own window — i.e. the
	// seating chain's select-window never ran or targeted a previous
	// generation. A seat in this state forwards every prompt to the wrong
	// agent; the flag names it so the failure is observable instead of
	// silent for hours. mu-protected. Reset on respawn (the chain re-runs).
	tmuxMisrouted bool
	// controlActive is the runtime gate: it flips true only when tmux's DCS
	// entry is actually seen in the stream, i.e. `exec tmux -u -CC attach` has
	// taken over the pty. Before that the pty runs the login shell and the
	// seat's startup command (the tmux chain) must be written RAW — encoding
	// it as send-keys would type `send-keys -H …` into the shell. controlMode
	// says "this seat will use control mode"; controlActive says "tmux has
	// taken over now". mu-protected (read by write/ptyResize, set by publish).
	controlActive bool
	// The fields below marked "publish-only" are touched solely in publish(),
	// which runs on the single read goroutine for this terminal; they need no
	// lock. paneID, copyModeActive, pendingInput, pendingCols/Rows are read
	// from write()/ptyResize too, so they live under mu.
	parseState     *ParseState // publish-only: the carried partial line + open block
	pendingBlocks  []blockKind // publish-only: FIFO of expected block kinds
	sessionTarget  string      // publish-only: session id/name from %session-changed
	historyFetched bool        // publish-only: capture-pane has been issued
	paneID         string      // mu: tmux pane id without `%`, learned from %output/list-panes
	copyModeActive bool        // mu: a copy/choose mode is active (from %pane-mode-changed)
	pendingInput   []byte      // mu: keystrokes buffered before the pane id was known
	pendingCols    uint16      // mu: resize issued before the pane id was known
	pendingRows    uint16      // mu: resize issued before the pane id was known
}

type outputEvent struct {
	Seq  uint64 `json:"seq"`
	Data string `json:"data"`
}

type fleet struct {
	root           string
	token          string
	mu             sync.RWMutex
	terminals      map[string]*terminal
	clients        map[string]map[*wsClient]struct{}
	rings          map[string][]outputEvent
	nextSeq        map[string]uint64
	logMu          sync.Mutex
	logDir         string
	logState       map[string]*sessionLog
	controllerSeat map[string]any
	// pendingOutput is the per-terminal coalescing queue: pty chunks wait
	// here for the shared flush tick (or an immediate flush) before becoming
	// one seq, one ring entry and one WS frame per client. Entries live for
	// the terminal's lifetime — allocated at create, deleted at close/rename.
	pendingOutput map[string]*pendingBuf
	// flushWindowMs is the last resolved coalescing window per terminal —
	// cached so a change (attach, detach, new RTT observation) can be
	// detected and pushed to clients as {t:'flushWindow'}.
	flushWindowMs map[string]int64
	// flushTicker/flushStop are the ONE fleet-level flush tick — armed while
	// any terminal has queued output, disarmed when the pending set empties.
	// No per-terminal timers: the tick runs at the window floor and skips
	// terminals whose notBefore is still in the future.
	flushTicker *time.Ticker
	flushStop   chan struct{}
}

// ensureOutputMapsLocked lazily initialises the coalescing maps. A fleet not
// built by main() — the test harness constructs its own literal — must not
// panic on a nil-map write in create, routeOutput, reresolveFlushWindow or
// rename. Caller holds f.mu (write lock).
func (f *fleet) ensureOutputMapsLocked() {
	if f.pendingOutput == nil {
		f.pendingOutput = make(map[string]*pendingBuf)
	}
	if f.flushWindowMs == nil {
		f.flushWindowMs = make(map[string]int64)
	}
}

func randomToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("token generation failed: %v", err)
	}
	return hex.EncodeToString(buf)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (f *fleet) authorized(r *http.Request) bool {
	return f.token != "" && r.Header.Get("Authorization") == "Bearer "+f.token
}

func strField(payload map[string]any, key string) string {
	v, _ := payload[key].(string)
	return v
}

func boolField(payload map[string]any, key string) bool {
	v, _ := payload[key].(bool)
	return v
}

func (f *fleet) project(t *terminal) map[string]any {
	parent := any(nil)
	if t.parentInstanceId != "" {
		parent = t.parentInstanceId
	}
	return map[string]any{
		"friendlyName": t.name, "role": t.role, "status": t.status, "pid": t.pid,
		"startTime": t.startTime, "worktreePath": t.worktreePath, "cwd": t.cwd,
		"agentInstanceId": t.agentInstanceId, "parentInstanceId": parent,
		"cliFamily": t.cliFamily, "startupCommand": t.startupCommand,
		"startupCommandSource": t.startupCommandSource, "lastDataAt": t.lastDataAt,
		"promptCount": t.promptCount, "hidden": t.hidden,
		"startupCommandInner": t.startupCommandInner,
		"machineId":           t.machineId,
		// The seat's tmux identity. Set at create from the payload and used by
		// every tmux path in this host (resizeTmuxWindow, ensureTmuxRouting,
		// close's kill-window) — but never REPORTED, so `ptyListTerminals`
		// showed `tmuxSession: null` for four seats that were plainly seated in
		// tmux. That makes the board unable to tell a tmux-backed seat from a
		// plain pty, and makes "is this seat in tmux?" unanswerable from the
		// outside while the host knew the answer all along.
		"tmuxSession":     t.tmuxSession,
		"tmuxWindow":      t.tmuxWindow,
		"tmuxViewSession": t.tmuxViewSession,
	}
}

func (f *fleet) create(payload map[string]any) (map[string]any, error) {
	if runtime.GOOS == "windows" {
		return map[string]any{"success": false, "error": "PTY host unsupported on windows until a verified ConPTY adapter exists"}, nil
	}
	role := strField(payload, "role")
	if role == "" {
		role = "coder"
	}
	name := strField(payload, "name")
	autoName := name == ""
	if autoName {
		// Auto-derive from the role, matching PtyFleetService.create's
		// `${role}-1` default. Previously this fell back to
		// `terminal-<nanos>`, which diverged from the standalone fleet's
		// role-based naming and produced unreadable seat names on the
		// extension host (e.g. a team head named after its definition).
		// Collision handling rolls forward to `${role}-2`, ... below.
		name = role + "-1"
	}
	cwd := strField(payload, "cwd")
	if cwd == "" {
		cwd = f.root
	}
	cwd, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	// Auto-derived names roll forward to the next free slot, matching
	// PtyFleetService.create's collision counter. An explicitly-supplied
	// name that already exists is still a hard error (the caller asked for
	// that exact name); only the auto-derived `${role}-N` rolls forward.
	if autoName {
		counter := 1
		for {
			if _, exists := f.terminals[name]; !exists {
				break
			}
			counter++
			name = fmt.Sprintf("%s-%d", role, counter)
		}
	} else if _, exists := f.terminals[name]; exists {
		return map[string]any{"success": false, "error": "terminal name already exists"}, nil
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell, "-l")
	cmd.Dir = cwd
	env := os.Environ()
	agentID := randomToken()[:32]
	if existing := strField(payload, "agentInstanceId"); existing != "" {
		agentID = existing
	}
	env = append(env, "SWITCHBOARD_TERMINAL="+name, "SWITCHBOARD_AGENT_INSTANCE_ID="+agentID)
	if token := strField(payload, "apiToken"); token != "" {
		env = append(env, "SWITCHBOARD_API_TOKEN="+token)
	}
	claudeInline := true
	if v, ok := payload["claudeInlineRendering"].(bool); ok {
		claudeInline = v
	}
	if claudeInline {
		env = append(env, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1", "CLAUDE_CODE_DISABLE_MOUSE=1")
	}
	cmd.Env = env
	applySession(cmd)
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		return nil, err
	}
	now := time.Now()
	controlMode := boolField(payload, "controlMode")
	t := &terminal{
		name: name, role: role, cmd: cmd, file: file, pid: cmd.Process.Pid,
		status: "active", cwd: cwd, worktreePath: strField(payload, "worktreePath"),
		agentInstanceId: agentID, parentInstanceId: strField(payload, "parentInstanceId"),
		startTime: now.UTC().Format(time.RFC3339Nano), lastDataAt: now.UnixMilli(),
		hidden: boolField(payload, "hidden"), claudeInlineRendering: claudeInline,
		isTeamMember: boolField(payload, "_isTeamMember"),
		listeners:    make(map[chan string]struct{}),
		controlMode:  controlMode,
		// The per-seat VIEW tmux session name, set once at create time under
		// f.mu (this constructor runs under f.mu). fleet.close() reads it to
		// issue `tmux kill-session -t =<view>` for a control-mode terminal.
		// Empty for extension terminals (controlMode is false there) and for
		// any create payload that predates this field — close() skips the
		// kill-session when it is empty.
		tmuxViewSession: strField(payload, "tmuxViewSession"),
		// The BASE tmux session + window name, set once at create time under
		// f.mu. fleet.close() reads them to issue
		// `tmux kill-window -t =<session>:<window>` and end the agent itself.
		// Empty for extension terminals and any payload that predates these
		// fields — close() skips the kill-window when either is empty.
		tmuxSession: strField(payload, "tmuxSession"),
		tmuxWindow:  strField(payload, "tmuxWindow"),
		// Recorded at create so a respawn (clearStrategy "respawn") can
		// re-inject the seat's startup command verbatim — the only way a
		// declared --model holds across a reset, since /clear restarts
		// Devin's session internally and never re-reads the startup command.
		// The Go host replays this string into a fresh login shell; it never
		// re-derives or parses it. See
		// a-seats-clear-strategy-is-declared-per-cli-family-not-assumed.md.
		startupCommand:      strField(payload, "startupCommand"),
		startupCommandInner: strField(payload, "startupCommandInner"),
		machineId:           strField(payload, "machineId"),
		env:                 env,
	}
	// The COMPOSED cli with no tmux chain around it — the string the seating
	// chain hands to `tmux new-window`, and the only one a tmux respawn can
	// hand back to `tmux respawn-window`. Assigned outside the literal above so
	// the literal's gofmt alignment is untouched.
	t.startupCommandComposed = strField(payload, "startupCommandComposed")
	if controlMode {
		t.parseState = &ParseState{}
	}
	f.ensureOutputMapsLocked()
	f.terminals[name] = t
	f.clients[name] = make(map[*wsClient]struct{})
	f.rings[name] = nil
	f.nextSeq[name] = 0
	f.pendingOutput[name] = &pendingBuf{}
	// Generation 0 — the seat's first pty. A respawn bumps it.
	go f.readOutput(name, file, t.generation)
	// Spawn-time routing verification for a seat with NO control stream. A
	// control-mode seat arms this from onPaneIDLearned; with control mode off
	// the pane id never arrives, so that hook never fires and nothing checks
	// where the view is pointed until the first prompt. The browser renders the
	// view immediately, so an unchecked seat shows a sibling's window in the
	// grid — two panes of one agent and none of another.
	//
	// Delayed because the seating chain is still running: the pty was just
	// handed `tmux ... select-window ...; exec tmux attach`, and querying
	// before that lands would read a view that legitimately has no window yet.
	// A miss here is not fatal — the delivery path re-checks and repairs on
	// every send — so this is the early fix, not the gate.
	if t.tmuxViewSession != "" && !t.controlMode {
		go func() {
			time.Sleep(tmuxRoutingSettleDelay)
			_, _ = ensureTmuxRouting(t)
		}()
	}
	return map[string]any{"success": true, "terminal": f.project(t)}, nil
}

// tmuxRoutingSettleDelay is how long the spawn-time routing check waits for the
// seating chain to finish before asking where the view points. It only has to
// outlast `select-window` + `exec tmux attach` on a local socket; the delivery
// path is the backstop if it is ever short.
const tmuxRoutingSettleDelay = 2 * time.Second

// readOutput pumps one pty fd. `gen` is the seat's respawn generation at the
// moment this fd was opened: a clearStrategy "respawn" replaces the fd and
// bumps the generation, so a read error on a SUPERSEDED fd is that respawn
// closing it, not the seat exiting. Running the exit teardown for it would
// mark the live terminal `exited`, close and DELETE every WebSocket client
// (the browser sees `[exited]`), and end the session log — churning exactly
// the things the respawn design promises survive, and racing the respawn's own
// `status = "active"`. A stale generation therefore returns silently.
func (f *fleet) readOutput(name string, file *os.File, gen int) {
	buf := make([]byte, 4096)
	for {
		n, err := file.Read(buf)
		if n > 0 {
			chunk := string(buf[:n])
			f.mu.Lock()
			if t := f.terminals[name]; t != nil {
				t.lastDataAt = time.Now().UnixMilli()
			}
			f.mu.Unlock()
			f.publish(name, chunk)
		}
		if err != nil {
			// Superseded fd: a respawn closed it. Not an exit — return before
			// touching any shared state, including the preamble flush, which
			// would otherwise splice a previous incarnation's held output into
			// the fresh one.
			f.mu.Lock()
			stale := false
			if t := f.terminals[name]; t != nil && t.generation != gen {
				stale = true
			}
			f.mu.Unlock()
			if stale {
				return
			}
			// A seat whose tmux never started holds its shell output in the
			// preamble (suppressed so the seating chain does not render). At EOF
			// that held text is the ONLY explanation for the dead pane —
			// `tmux: command not found`, a chain error — so surface it before
			// tearing down rather than losing it with the terminal.
			if t := f.terminals[name]; t != nil && t.controlMode {
				if held := FlushPreamble(t.parseState); len(held) > 0 {
					t.emit(string(held))
					f.routeOutput(name, string(held))
				}
			}
			// An exit drain must not wait out a coalescing window — the final
			// bytes flush synchronously, ahead of the exit frame.
			f.flushPending(name)
			f.mu.Lock()
			if t := f.terminals[name]; t != nil {
				t.status = "exited"
			}
			clients := f.clients[name]
			delete(f.clients, name)
			delete(f.pendingOutput, name)
			delete(f.flushWindowMs, name)
			f.mu.Unlock()
			for client := range clients {
				_ = client.writeJSON(map[string]any{"t": "exit", "code": 0})
				_ = client.conn.Close()
			}
			f.logClose(name)
			return
		}
	}
}

// publish is the single fan-out point for pty output. In raw mode it routes
// the bytes verbatim to the log tee, the scrollback ring and the browser. In
// control mode it first demuxes the chunk through the control-mode parser
// (controlmode.go) and routes the DECODED output to all three consumers —
// one parse, one call site, three consumers fed from the parsed output. The
// `rest` (partial-line remainder) is per-terminal state in t.parseState,
// threaded across calls. Control events (%exit, %layout-change, …) are sent
// to the browser as JSON WS messages; the browser already handles JSON
// (hello, resize, ack), so a new message type is additive.
func (f *fleet) publish(name, data string) {
	t, ok := f.get(name)
	if !ok {
		return
	}
	if !t.controlMode {
		t.emit(data)
		f.routeOutput(name, data)
		return
	}
	// Control mode: demux once, feed all three consumers from the parsed
	// output. parseState is publish-only (this goroutine), so no lock here.
	if t.parseState == nil {
		t.parseState = &ParseState{}
	}
	wasDcs := t.parseState.dcsSeen
	msgs := ParseControlMode(data, t.parseState)
	// Flip the runtime gate the moment tmux's DCS entry is actually seen —
	// before that the pty is the login shell and input must stay raw.
	if !wasDcs && t.parseState.dcsSeen {
		t.mu.Lock()
		t.controlActive = true
		t.mu.Unlock()
	}
	for _, msg := range msgs {
		switch msg.Kind {
		case KindOutput:
			// Learn the pane id from the first %output that carries one. This
			// is the fallback path; the list-panes reply (blockPaneID) usually
			// arrives first because %session-changed fires before %output.
			if msg.PaneID != "" {
				learned := false
				t.mu.Lock()
				if t.paneID == "" {
					t.paneID = msg.PaneID
					learned = true
					_ = flushPendingInputLocked(t)
				}
				t.mu.Unlock()
				if learned {
					f.onPaneIDLearned(name, t)
				}
			}
			// Route ONLY this seat's pane. A view session is GROUPED with its
			// team base session, so one -CC client receives %output for every
			// pane in the group — measured on tmux 3.4: a single client on a
			// two-window group saw both panes' output. Unfiltered, every seat in
			// a team rendered all four agents interleaved and wrote all four
			// into its own .md transcript, destroying the per-seat diagnostic
			// record. `list-panes -t <view-session>` resolves to the view's OWN
			// current window (verified), so t.paneID is the right key.
			// Before the id is learned there is nothing to filter on, so those
			// first bytes still pass — the list-panes reply lands on the first
			// %session-changed, ahead of steady-state output.
			t.mu.Lock()
			mine := t.paneID
			t.mu.Unlock()
			if mine != "" && msg.PaneID != "" && msg.PaneID != mine {
				continue
			}
			decoded := string(msg.Data)
			t.emit(decoded)
			f.routeOutput(name, decoded)
		case KindBlock:
			// Pop the expected block kind. Blocks return strictly in command
			// order, so a FIFO matches them up.
			kind := blockNone
			if len(t.pendingBlocks) > 0 {
				kind = t.pendingBlocks[0]
				t.pendingBlocks = t.pendingBlocks[1:]
			}
			if kind == blockPaneID {
				// list-panes reply: parse the pane id, then fetch history.
				paneID := parsePaneIDFromBlock(msg.Block)
				if paneID != "" {
					learned := false
					t.mu.Lock()
					// The list-panes reply is AUTHORITATIVE and may CORRECT an id
					// latched from a foreign %output. In a grouped session the
					// first %output can belong to another seat's pane; the old
					// `if t.paneID == ""` guard made that latch permanent, which
					// mis-targeted send-keys and — now that output is filtered on
					// this id — would blank the pane for good.
					if t.paneID != paneID {
						t.paneID = paneID
						learned = true
						_ = flushPendingInputLocked(t)
					}
					// NO explicit pendingBlocks push here. writeControlCommandLocked
					// owns the push (controlmode_io.go:55) precisely so the writer
					// and the FIFO cannot drift; pushing here too queues each kind
					// TWICE, so every block after the history fetch pops a stale
					// kind — a list-panes reply routed to the browser as terminal
					// content, a capture reply parsed as a pane id.
					//
					// And latch historyFetched only when the fetch was actually
					// issued: sendHistoryFetchLocked returns nil without sending
					// when the pane id is not yet known, and latching regardless
					// would lose the scrollback for the life of the seat.
					if !t.historyFetched && t.paneID != "" {
						if err := sendHistoryFetchLocked(t); err == nil {
							t.historyFetched = true
						}
					}
					t.mu.Unlock()
					if learned {
						f.onPaneIDLearned(name, t)
					}
				}
				// A list-panes reply is a query response, NOT terminal content
				// — never route it to the ring/log/browser.
			} else {
				// capture-pane reply (scrollback or pending fragment): terminal
				// content, route to all three consumers.
				//
				// The two captures use DIFFERENT encodings, so the decode is
				// per-kind and cannot live in the parser. `-peqJN -S -50000`
				// (blockScrollback) returns RAW bytes — real ESC included, via
				// `-e` — and must be routed verbatim. `-p -P -C` (blockPending)
				// is `-C`-escaped (backslash doubled, non-printables as \ooo)
				// and must be decoded with decodeCaptureC. Octal-decoding the
				// raw scrollback turned literal `\033` in an agent's output
				// into a live escape sequence.
				var decoded string
				if kind == blockPending {
					decoded = string(decodeCaptureC(string(msg.Block.Data)))
				} else {
					decoded = string(msg.Block.Data)
				}
				t.emit(decoded)
				f.routeOutput(name, decoded)
			}
		case KindControl:
			f.handleControlEvent(name, t, msg)
		case KindIgnored:
			// A non-`%` line outside a block (Type == "") is not control
			// protocol — in normal operation there are none, so this is a
			// safety net that surfaces a broken tmux (or no tmux at all) as
			// readable output instead of a blank pane. An unknown `%` type is
			// dropped: a future tmux must not break rendering.
			if msg.Type == "" && len(msg.Fields) > 0 {
				line := msg.Fields[0]
				t.emit(line)
				f.routeOutput(name, line)
			}
		}
	}
}

// onPaneIDLearned fires the first time the pane id becomes known. It flushes
// any resize that was issued before the pane id existed (a control client is
// invisible to sizing until its first `refresh-client -C`).
//
// It also arms the spawn-time routing verification (Change 3): the seating
// chain has completed by now (controlActive flipped, select-window ran), so
// the view session's current window must be the seat's own — the one this pane
// belongs to. A mismatch means select-window never ran or targeted a previous
// generation, and every prompt would be forwarded to the wrong agent. The
// check runs in a goroutine so the read goroutine never blocks on tmux; the
// seat's own window id is captured here so delivery can verify with one query
// instead of two.
func (f *fleet) onPaneIDLearned(_ string, t *terminal) {
	t.mu.Lock()
	cols, rows := t.pendingCols, t.pendingRows
	t.pendingCols, t.pendingRows = 0, 0
	paneID := t.paneID
	view := t.tmuxViewSession
	t.mu.Unlock()
	if cols > 0 && rows > 0 {
		_ = ptyResize(t, cols, rows)
	}
	if paneID == "" || view == "" {
		return
	}
	// One routing path, shared with the non-control spawn check and the
	// delivery check. It previously had its own verify-and-flag twin here,
	// which logged a misroute and left the seat misrouted; a seat that repairs
	// itself is strictly better, and two paths that disagree about what to do
	// on a mismatch is how one of them rots.
	go func() { _, _ = ensureTmuxRouting(t) }()
}

// tmuxQuery runs a tmux format query and returns the trimmed stdout, or "" on
// any failure. exec.Command uses an argv array — no shell, no interpolation —
// so a pane/session id reaching -t is never re-parsed as a command. A failure
// (no tmux, no such session/pane) returns "" rather than propagating: the
// callers treat "" as "cannot verify" and fall through, never as a positive
// result.
func tmuxQuery(args ...string) string {
	out, err := exec.Command("tmux", args...).Output()
	if err != nil {
		return ""
	}
	return strings.TrimRight(string(out), "\n")
}

// tmuxRun executes a side-effecting tmux command. It is a package var, not a
// direct exec, so a test can substitute a fake and observe ORDER — the hazard
// these sequences carry is a lost update, not a data race, and the race
// detector cannot see it (every field access is already under t.mu). Without a
// seam here, a test of "are these serialised" passes whether or not the lock
// exists, which is worse than no test.
//
// Failures are returned, never logged here: each caller decides whether a
// failed tmux command is fatal (a misroute that could not be corrected) or
// simply "cannot act" (a resize against a window that has gone away).
var tmuxRun = func(args ...string) error {
	return exec.Command("tmux", args...).Run()
}

// tmuxPaneWindowID returns the window id containing the seat's own pane. The
// pane id is the stable handle learned from the control stream; its window is
// the seat's own, regardless of how many duplicate-named windows a previous
// generation left behind. Empty when the pane id is unknown or tmux is
// unavailable.
func tmuxPaneWindowID(paneID string) string {
	if paneID == "" {
		return ""
	}
	return tmuxQuery("display-message", "-p", "-t", "%"+paneID, "#{window_id}")
}

// tmuxViewWindowID returns the view session's CURRENT window id — the window
// tmux forwards input to. This is what a delivered prompt actually reaches.
// Empty when the view does not exist or tmux is unavailable.
func tmuxViewWindowID(view string) string {
	if view == "" {
		return ""
	}
	return tmuxQuery("display-message", "-p", "-t", view, "#{window_id}")
}

// tmuxNamedWindowID resolves the seat's own window id from its BASE session and
// window NAME, with no control stream involved. This is the non-control-mode
// twin of tmuxPaneWindowID: a pane id is learned only from `%output` and the
// `list-panes` reply, both of which exist solely in control mode, so with
// control mode off `t.paneID` is permanently "" and every pane-id-based lookup
// returns "" — taking the routing checks with it.
//
// Names are unambiguous here: the window-reuse fix in goPtyFleetProjection.ts
// makes window names unique within a session (it is the same guarantee that
// lets fleet.close() target `=<session>:<window>` for kill-window). `=` forces
// an exact session-name match so `lc-coding-team` cannot match
// `lc-coding-team-coder-1`.
func tmuxNamedWindowID(session, window string) string {
	if session == "" || window == "" {
		return ""
	}
	out := tmuxQuery("list-windows", "-t", "="+session, "-F", "#{window_name} #{window_id}")
	if out == "" {
		return ""
	}
	for _, line := range strings.Split(out, "\n") {
		name, id, ok := strings.Cut(line, " ")
		if ok && name == window {
			return id
		}
	}
	return ""
}

// tmuxOwnWindowID returns the window this seat's agent actually runs in,
// preferring what is already cached, then the control stream's pane id, then
// the seat's own session+window names. Empty means "cannot determine" — never
// a positive answer, so every caller treats it as "cannot verify" rather than
// as a mismatch.
func tmuxOwnWindowID(t *terminal) string {
	t.mu.Lock()
	own, paneID, session, window := t.tmuxWindowId, t.paneID, t.tmuxSession, t.tmuxWindow
	t.mu.Unlock()
	if own != "" {
		return own
	}
	if paneID != "" {
		own = tmuxPaneWindowID(paneID)
	}
	if own == "" {
		own = tmuxNamedWindowID(session, window)
	}
	if own != "" {
		t.mu.Lock()
		t.tmuxWindowId = own
		t.mu.Unlock()
	}
	return own
}

// ensureTmuxRouting points the seat's VIEW session at the seat's OWN window and
// reports whether it is now correct. It returns ("", true) for "cannot verify"
// — no tmux, no view, unknown window — which is never treated as a misroute.
//
// Grouped sessions share one window LIST but each keeps its own CURRENT window,
// and the seat's pty is a `tmux attach` client, so tmux forwards every byte to
// whatever that view currently shows. A view pointed at a sibling's window
// therefore renders the sibling in the browser AND types this seat's prompts
// into the sibling's agent, while the send reports success.
//
// Observed 2026-09-13 on a live team: `lc-coding-team-coder-1` had
// `Coding-coder-2` current, so the 2x2 grid showed coder-2 twice and coder-1
// never — and coder-1's prompts were reaching coder-2.
//
// This CORRECTS rather than only flagging. The seating chain's select-window is
// the intended state; re-asserting it is idempotent, and a seat that repairs
// itself beats one that reports a misroute forever. The re-query after the
// correction is what makes the return value evidence instead of an assumption:
// if the seat is still misrouted after select-window, the caller must not
// pretend otherwise.
func ensureTmuxRouting(t *terminal) (own string, ok bool) {
	// Whole sequence under tmuxMu: without it two callers can both observe the
	// mismatch, both issue select-window, and each re-query the OTHER's result
	// — so a verdict would describe a state neither of them established.
	t.tmuxMu.Lock()
	defer t.tmuxMu.Unlock()
	t.mu.Lock()
	view := t.tmuxViewSession
	t.mu.Unlock()
	if view == "" {
		return "", true
	}
	own = tmuxOwnWindowID(t)
	if own == "" {
		return "", true
	}
	current := tmuxViewWindowID(view)
	if current == "" || current == own {
		if current == own {
			t.mu.Lock()
			t.tmuxMisrouted = false
			t.mu.Unlock()
		}
		return own, true
	}
	_ = tmuxRun("select-window", "-t", "="+view+":"+own)
	current = tmuxViewWindowID(view)
	misrouted := current != "" && current != own
	t.mu.Lock()
	t.tmuxMisrouted = misrouted
	t.mu.Unlock()
	if misrouted {
		log.Printf("[pty-host] view %s still on window %s after select-window to %s", view, current, own)
		return own, false
	}
	return own, true
}

// handleControlEvent routes a tmux notification to the browser as a JSON WS
// message and arms any host-side response (%session-changed → pane-id query +
// flow control; %pane-mode-changed → copy-mode tracking).
func (f *fleet) handleControlEvent(name string, t *terminal, msg ControlMessage) {
	switch msg.Type {
	case "%exit":
		// %exit comes from the client process's stdio, not the server's
		// buffered output — they are not ordered against each other and it
		// can arrive mid-block (the parser force-closes any open block).
		// Surface it as a stated end state; the read goroutine's EOF path
		// still closes the socket.
		f.broadcastControl(name, "exit", msg.Fields)
	case "%session-changed":
		// The first notification on attach. Arm flow control and learn the
		// pane id via list-panes (works for idle seats that emit no %output).
		// The reply is a block tagged blockPaneID; history fetch follows once
		// the pane id is parsed from it.
		target := ""
		if len(msg.Fields) >= 2 {
			target = msg.Fields[1] // session name
		} else if len(msg.Fields) >= 1 {
			target = msg.Fields[0] // session id
		}
		t.mu.Lock()
		t.sessionTarget = target
		_ = sendFlowControlLocked(t)
		if target != "" && t.paneID == "" {
			// sendListPanesLocked pushes blockPaneID itself — see the note on the
			// history fetch above. Pushing here as well double-queues the kind and
			// desyncs every block that follows.
			_ = sendListPanesLocked(t, target)
		}
		t.mu.Unlock()
		f.broadcastControl(name, "session-changed", msg.Fields)
	case "%pause":
		// sendFlowControlLocked arms `pause-after=30`, so tmux PAUSES a pane
		// whose client falls 30s behind and then emits nothing for it until the
		// client resumes it. Nothing resumed it: there was no %pause arm and no
		// `refresh-client -A` anywhere in the host, so a seat whose panel lagged
		// (a phone over the tailnet is the stated use case) went permanently
		// silent with no recovery short of a reattach. Resume immediately — the
		// pre-control-mode seat had no backpressure either, so resuming restores
		// the previous behaviour rather than inventing a new one.
		pane := ""
		if len(msg.Fields) >= 1 {
			pane = strings.TrimPrefix(msg.Fields[0], "%")
		}
		if pane != "" {
			t.mu.Lock()
			_ = writeControlCommandLocked(t, fmt.Sprintf("refresh-client -A '%%%s:continue'", pane), blockNone)
			t.mu.Unlock()
		}
		f.broadcastControl(name, "pause", msg.Fields)
	case "%pane-mode-changed":
		// %pane-mode-changed <pane> <mode>: a non-empty mode means a copy/choose
		// mode is active and would swallow send-keys. Track it; sendKeysLocked
		// cancels it before the next input. An empty mode means it cleared.
		mode := ""
		if len(msg.Fields) >= 2 {
			mode = msg.Fields[1]
		}
		t.mu.Lock()
		t.copyModeActive = mode != ""
		t.mu.Unlock()
		f.broadcastControl(name, "pane-mode-changed", msg.Fields)
	default:
		// Every other notification (%layout-change, %window-close,
		// %window-renamed, %sessions-changed, %pause, …) is forwarded to the
		// browser by name so it can render it without the host having to
		// understand it. The parser only returns KindControl for the tmux 3.4
		// notification inventory, so this never fires for an unknown type.
		event := strings.TrimPrefix(msg.Type, "%")
		f.broadcastControl(name, event, msg.Fields)
	}
}

// broadcastControl sends a control event to every WS client of a terminal as
// a JSON message: `{"t":"control","event":"<name>","fields":[...]}`. The WS
// protocol already handles JSON (hello, resize, ack); this is additive.
func (f *fleet) broadcastControl(name, event string, fields []string) {
	f.mu.Lock()
	clients := make([]*wsClient, 0, len(f.clients[name]))
	for client := range f.clients[name] {
		clients = append(clients, client)
	}
	f.mu.Unlock()
	msg := map[string]any{"t": "control", "event": event}
	if fields != nil {
		msg["fields"] = fields
	}
	for _, client := range clients {
		if err := client.writeJSON(msg); err != nil {
			_ = client.conn.Close()
			f.removeClient(name, client)
		}
	}
}

// ─── Output coalescing ────────────────────────────────────────────────────
//
// The window is sized to the LINK, not to a 60 Hz renderer: floor 6 ms (right
// for loopback), ceiling 40 ms (a tailnet-scale link never waits longer), and
// the resolved value is the MAX RTT reported by the terminal's attached
// clients — the slowest link sets the pace. Max, not mean: a remote client
// must not be throttled to a local one's link, and a local client must not
// wait on a remote one's window invisibly. It is the same class of explicit
// trade-off the retired gateway's reconcileTerminalSize made for size votes.
const (
	flushWindowFloorMs   = 6
	flushWindowCeilingMs = 40
	flushTickMs          = flushWindowFloorMs
	// A lone chunk under this size bypasses the window entirely — a keystroke
	// echo is a handful of bytes and holding it for coalescing buys nothing.
	loneFrameMaxBytes = 512
	// Per-flush byte cap: one firehose cannot build an unbounded frame.
	// Leftovers stay queued and drain on the next tick — the same shape as
	// the retired gateway's MAX_FLUSH_BYTES leftovers rule.
	maxFlushBytes = 128 * 1024
)

// pendingBuf is one terminal's coalescing queue. parts/bytes/notBefore are
// accessed ONLY under f.mu (routeOutput's read goroutine and the tick
// goroutine both touch them). flushMu serializes an entire drain+write so two
// racing flushes — an immediate one on the read goroutine and the shared tick
// — cannot interleave on the wire: a client drops any seq it has already
// seen, so an overtaken frame is data loss, not a benign reorder.
type pendingBuf struct {
	parts     []string
	bytes     int
	notBefore time.Time
	flushMu   sync.Mutex
}

// resolveFlushWindowLocked returns the coalescing window for a terminal in
// milliseconds: the floor, stretched toward the ceiling by the slowest
// attached client's measured RTT. A client with rttMs == 0 is unmeasured and
// contributes the floor — an all-unmeasured terminal resolves to the floor,
// which is also the loopback case. Caller holds f.mu.
func (f *fleet) resolveFlushWindowLocked(name string) int64 {
	window := int64(flushWindowFloorMs)
	for client := range f.clients[name] {
		if client.rttMs > window {
			window = client.rttMs
		}
	}
	if window > flushWindowCeilingMs {
		window = flushWindowCeilingMs
	}
	return window
}

// reresolveFlushWindow recomputes a terminal's window after anything that can
// move it — attach, detach, a new RTT observation. On a change it caches the
// value and pushes {t:'flushWindow'} to every client: a tuning value that
// changes behaviour and cannot be read back is the shape of bug this codebase
// keeps paying for.
func (f *fleet) reresolveFlushWindow(name string) {
	f.mu.Lock()
	// A departed terminal leaves nothing to retune — and without this check a
	// removeClient racing the exit/close teardown would re-create a
	// flushWindowMs entry for a name that is already gone.
	if f.terminals[name] == nil {
		f.mu.Unlock()
		return
	}
	window := f.resolveFlushWindowLocked(name)
	if f.flushWindowMs[name] == window {
		f.mu.Unlock()
		return
	}
	f.ensureOutputMapsLocked()
	f.flushWindowMs[name] = window
	clients := make([]*wsClient, 0, len(f.clients[name]))
	for client := range f.clients[name] {
		clients = append(clients, client)
	}
	f.mu.Unlock()
	for _, client := range clients {
		if err := client.writeJSON(map[string]any{"t": "flushWindow", "ms": window}); err != nil {
			_ = client.conn.Close()
			f.removeClient(name, client)
		}
	}
}

// armFlushTickLocked starts the ONE fleet-level flush tick. Called with a
// chunk queued and f.mu held; a no-op when the tick is already armed.
func (f *fleet) armFlushTickLocked() {
	if f.flushTicker != nil {
		return
	}
	f.flushTicker = time.NewTicker(flushTickMs * time.Millisecond)
	stop := make(chan struct{})
	f.flushStop = stop
	ticker := f.flushTicker
	go func() {
		for {
			select {
			case <-ticker.C:
				f.flushAllPending()
			case <-stop:
				return
			}
		}
	}()
}

// disarmFlushTickLocked stops the tick. The goroutine exits via the stop
// channel rather than leaking on a stopped ticker channel.
func (f *fleet) disarmFlushTickLocked() {
	if f.flushTicker == nil {
		return
	}
	f.flushTicker.Stop()
	close(f.flushStop)
	f.flushTicker = nil
	f.flushStop = nil
}

// routeOutput feeds decoded terminal bytes to the three consumers: the log
// tee, the scrollback ring, and the browser (binary WS frames). The log tee
// is fed per chunk here; the ring append, seq advance and per-client write
// all happen per FLUSH inside flushPending, so a coalesced burst still gets
// one seq and one ring entry (the client's seq/lastSeq gap logic is
// unchanged).
//
// The lone-frame bypass is the load-bearing half of the window: a single
// small chunk on an empty queue flushes immediately, so a keystroke echo
// never waits on a timer. The window only ever delays QUEUED output — chunks
// that arrive while a burst is already forming.
func (f *fleet) routeOutput(name, data string) {
	f.logOutput(name, data)
	f.mu.Lock()
	f.ensureOutputMapsLocked()
	buf := f.pendingOutput[name]
	if buf == nil {
		buf = &pendingBuf{}
		f.pendingOutput[name] = buf
	}
	buf.parts = append(buf.parts, data)
	buf.bytes += len(data)
	lone := len(buf.parts) == 1 && len(data) < loneFrameMaxBytes
	full := buf.bytes >= maxFlushBytes
	if !lone {
		// The adaptive window applies ONLY when a queue is forming
		// (len(parts) > 1). A lone chunk of 512+ bytes is bulk output, not
		// keystroke echo — it does not bypass — but with no queue forming it
		// gets no notBefore either: it waits for the next tick (the floor)
		// rather than the resolved window, and its brief sit is what lets
		// following chunks join into a coalesced burst.
		if !full && len(buf.parts) > 1 && buf.notBefore.IsZero() {
			// Anchor the window at burst start. Refreshing it per chunk
			// would let a sustained stream push the deadline forever — the
			// hold on a queued burst is bounded at one window.
			buf.notBefore = time.Now().Add(time.Duration(f.resolveFlushWindowLocked(name)) * time.Millisecond)
		}
		// Armed for the `full` case too: a cap-triggered flush can leave
		// leftovers, and they drain on the next tick — without the tick
		// armed they would sit until the next chunk arrived.
		f.armFlushTickLocked()
	}
	f.mu.Unlock()
	if lone || full {
		f.flushPending(name)
	}
}

// flushPending drains one terminal's pending queue into a single binary
// frame per client. Called by routeOutput for the immediate cases (lone
// frame, byte cap) and by flushAllPending for windowed output; it ignores
// notBefore — due-ness is the caller's decision, so the exit path can drain
// synchronously without waiting out a window.
func (f *fleet) flushPending(name string) {
	f.mu.RLock()
	buf := f.pendingOutput[name]
	f.mu.RUnlock()
	if buf == nil {
		return
	}
	buf.flushMu.Lock()
	defer buf.flushMu.Unlock()
	f.mu.Lock()
	if len(buf.parts) == 0 {
		f.mu.Unlock()
		return
	}
	// Drain up to maxFlushBytes. The first part always goes even when it
	// alone exceeds the cap — a single oversize chunk must not stall.
	var b strings.Builder
	total := 0
	n := 0
	for n < len(buf.parts) {
		if n > 0 && total+len(buf.parts[n]) > maxFlushBytes {
			break
		}
		total += len(buf.parts[n])
		b.WriteString(buf.parts[n])
		n++
	}
	data := b.String()
	buf.parts = append([]string(nil), buf.parts[n:]...)
	buf.bytes -= total
	// Cleared after every drain: leftover parts (cap) become immediately due,
	// and the next queued burst re-anchors its own window.
	buf.notBefore = time.Time{}
	f.nextSeq[name]++
	event := outputEvent{Seq: f.nextSeq[name], Data: data}
	f.rings[name] = append(f.rings[name], event)
	bytes := 0
	start := 0
	for i := len(f.rings[name]) - 1; i >= 0; i-- {
		bytes += len(f.rings[name][i].Data)
		if bytes > 256*1024 {
			start = i + 1
			break
		}
	}
	if start > 0 {
		f.rings[name] = append([]outputEvent(nil), f.rings[name][start:]...)
	}
	clients := make([]*wsClient, 0, len(f.clients[name]))
	for client := range f.clients[name] {
		clients = append(clients, client)
	}
	f.mu.Unlock()
	for _, client := range clients {
		// Binary frames, matching terminalWsGateway.ts — see encodeOutputFrame and
		// the note in ws.go. The client's binary branch is the one that tracks seq,
		// handles the replay boundary and suppresses answerback; the JSON `out`
		// path is a legacy fallback that does none of that.
		if err := client.writeMessage(websocket.BinaryMessage, encodeOutputFrame(event.Seq, event.Data)); err != nil {
			_ = client.conn.Close()
			f.removeClient(name, client)
		}
	}
}

// flushAllPending is the shared tick's pass over the fleet: flush every
// terminal whose queued output is due, then disarm the tick when nothing is
// queued anywhere.
func (f *fleet) flushAllPending() {
	now := time.Now()
	f.mu.RLock()
	due := make([]string, 0, len(f.pendingOutput))
	for name, buf := range f.pendingOutput {
		// A cleared notBefore (zero) is always due — that is the leftover-
		// after-cap case, which must not wait out a fresh window.
		if len(buf.parts) > 0 && !buf.notBefore.After(now) {
			due = append(due, name)
		}
	}
	f.mu.RUnlock()
	for _, name := range due {
		f.flushPending(name)
	}
	f.mu.Lock()
	pending := false
	for _, buf := range f.pendingOutput {
		if len(buf.parts) > 0 {
			pending = true
			break
		}
	}
	if !pending {
		f.disarmFlushTickLocked()
	}
	f.mu.Unlock()
}

func (f *fleet) removeClient(name string, client *wsClient) {
	f.mu.Lock()
	if clients := f.clients[name]; clients != nil {
		delete(clients, client)
	}
	f.mu.Unlock()
	// A departing high-RTT client relaxes the window for whoever remains.
	f.reresolveFlushWindow(name)
}

func (f *fleet) close(name string, killTmuxView bool) bool {
	// Queued output flushes synchronously before the terminal's state is
	// deleted — the last bytes must not wait out a coalescing window, and
	// must not write into a map entry that is already gone.
	f.flushPending(name)
	f.mu.Lock()
	t := f.terminals[name]
	clients := f.clients[name]
	delete(f.terminals, name)
	delete(f.clients, name)
	delete(f.rings, name)
	delete(f.nextSeq, name)
	delete(f.pendingOutput, name)
	delete(f.flushWindowMs, name)
	f.mu.Unlock()
	for client := range clients {
		_ = client.writeJSON(map[string]any{"t": "exit", "code": 0})
		_ = client.conn.Close()
	}
	if t == nil {
		return false
	}
	killProcessTree(t)
	// Per-seat close: kill the seat's VIEW tmux session. The view is the
	// per-seat control-mode session the operator's close action should end —
	// the BASE session is a shared team resource killed only by an explicit
	// team close or the tmux tab close control, never as a side-effect of a
	// per-seat close (the plan's invariant: nothing closes itself).
	//
	// Gated by killTmuxView: only the explicit ptyCloseTerminal verb passes
	// true. dispose() (process shutdown) passes false so the view session
	// survives a full exit — the plan's invariant says "process exit must
	// not automatically kill tmux sessions." A restart never reaches close()
	// at all (disposeAll is gated by !surviveBoard in bootstrap.ts), so the
	// view also survives a restart. The existing kill-window below is NOT
	// gated because it kills a window (not a session) and the session
	// survives — only kill-session takes the whole view.
	//
	// t.tmuxViewSession is write-once (set at create under f.mu, never
	// modified) so reading it here is race-free — unlike sessionTarget, which
	// is publish-only on the read goroutine. The `=` prefix forces exact-match
	// targeting so `lc-coding-team` cannot match `lc-coding-team-coder-1`.
	// exec.Command uses an argv array — no shell, no interpolation. The error
	// is swallowed: the session may already be gone (the agent exited and tmux
	// cleaned up) or this may be a non-tmux terminal whose field is empty.
	// NOT gated on t.controlMode. controlMode says who DRAWS the pane; it says
	// nothing about whether tmux owns the session. Gating the kill on it meant
	// that turning control mode off silently turned "closing a terminal closes
	// its tmux session" back off too, and sessions leaked on every close — the
	// exact behaviour the close-on-close work fixed. tmuxViewSession being
	// non-empty is the honest test: it is set at create time only for a
	// tmux-backed seat, and is empty for extension terminals and non-tmux ptys.
	if killTmuxView && t.tmuxViewSession != "" {
		_ = exec.Command("tmux", "kill-session", "-t", "="+t.tmuxViewSession).Run()
	}
	// Per-seat close: kill the seat's WINDOW in the base session, ending the
	// agent itself — "closing a terminal closes it", not just the pane's view
	// onto a still-running agent (change 2 of the
	// tmux-windows-duplicate-on-re-seat plan). The window lives in the shared
	// base session; `kill-window -t =<session>:<window>` removes it from the
	// shared list, and tmux destroys the base session (and its grouped views)
	// automatically when this was the last window — so the "kill-session when
	// the last window goes" case needs no separate code. After the window-reuse
	// fix window names are unique within a session, so the target is
	// unambiguous; the `=` prefix forces exact session-name match. The view
	// kill above already took the seat's pane; this takes the agent. Both are
	// best-effort: the window may already be gone (agent exited naturally) or
	// this may be a non-tmux terminal whose fields are empty. Crash survival
	// on a board RESTART is preserved because the standalone host gates
	// disposeAll() behind `!surviveBoard` (bootstrap.ts:5366) — a restart never
	// reaches this close(), so the window survives the PTY dying, which is the
	// durability property the seating design is built on.
	// Gated by killTmuxView for the SAME reason as the session kill above: this
	// line kills the AGENT, and a board shutdown must not. The old comment here
	// claimed "a restart never reaches this close(), because disposeAll is gated
	// behind !surviveBoard" — that reads the gate backwards. surviveBoard is
	// false by default, so !surviveBoard is TRUE and disposeAll runs on every
	// restart, reaching this line for every seat.
	//
	// Observed 2026-09-12: with only the session kill gated, a board restart
	// still destroyed seats. kill-window removes the window from the SHARED base
	// session, and tmux destroys the base (and its grouped views) when the last
	// window goes — so one ungated line took a coder and the team's base session
	// with it while the other views survived.
	//
	// Both kills now answer to the same question: is this an operator closing a
	// seat, or the board shutting down? Only the former ends an agent.
	// Also not gated on t.controlMode — same reasoning as the session kill above.
	if killTmuxView && t.tmuxSession != "" && t.tmuxWindow != "" {
		_ = exec.Command("tmux", "kill-window", "-t", "="+t.tmuxSession+":"+t.tmuxWindow).Run()
	}
	_ = t.file.Close()
	return true
}

func (f *fleet) dispose() {
	f.mu.RLock()
	names := make([]string, 0, len(f.terminals))
	for n := range f.terminals {
		names = append(names, n)
	}
	f.mu.RUnlock()
	for _, n := range names {
		// dispose() passes killTmuxView=false: the plan's invariant says
		// "process exit must not automatically kill tmux sessions." The view
		// sessions survive a full exit and become seatless — the operator can
		// re-attach or close them from the tmux tab. A restart never reaches
		// here (disposeAll is gated by !surviveBoard in bootstrap.ts).
		f.close(n, false)
	}
}

// respawnTerminal replaces the CLI running inside an existing pty with a fresh
// login shell, reusing the terminal name, listeners, ring, WebSocket clients
// and fleet registry row. The underlying pty fd is replaced (a new process
// needs a new pty pair), but everything keyed by name survives — readOutput
// emits to t.emit(chunk) and f.publish(name, chunk), both keyed by name, not
// by fd. This is the clearStrategy "respawn" mechanism: instead of typing
// /clear into a TUI composer (which on Devin restarts the session internally
// and never re-applies the startup command's --model), the CLI is killed and
// a fresh shell is started, into which the startup command is re-injected.
//
// Caller MUST hold t.mu (the per-terminal lock) so the fd replacement is
// atomic against every other writer. The new readOutput goroutine is started
// before the lock is released so the first bytes reach subscribers.
//
// Returns the new pid and an error if the fresh shell could not be started.
// A respawn with no startup command is a seat that should never have been
// created (only the shell role is legitimately CLI-less, and it is not a
// respawn family) — fail loudly here and name the role; do not substitute
// /clear to paper over it.
func (f *fleet) respawnTerminal(t *terminal) (int, error) {
	if t.startupCommand == "" {
		return 0, fmt.Errorf("respawn requires a startup command for role %q (none recorded at create)", t.role)
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell, "-l")
	cmd.Dir = t.cwd
	cmd.Env = t.env
	applySession(cmd)
	// Bump the generation BEFORE anything can make the old fd readable-with-
	// error. The old readOutput goroutine compares the generation it was
	// spawned with against this value and returns silently when they differ,
	// so the close below is read as "this fd was superseded" rather than
	// "the seat exited" — which would otherwise mark the terminal exited,
	// close every WebSocket client and end the session log.
	f.mu.Lock()
	t.generation++
	gen := t.generation
	f.mu.Unlock()
	// Kill the old process tree and close the old master fd BEFORE starting
	// the new pty pair. killProcessTree waits up to 500ms for SIGTERM then
	// SIGKILLs, so the old fd is released by the time the new one opens.
	killProcessTree(t)
	_ = t.file.Close()
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 80, Rows: 24})
	if err != nil {
		t.status = "exited"
		return 0, err
	}
	// Update the terminal struct in place — name, listeners, ring, clients
	// and registry row all stay. Reset the per-delivery and control-mode
	// state so the fresh shell starts clean.
	t.cmd = cmd
	t.file = file
	t.pid = cmd.Process.Pid
	t.status = "active"
	t.promptCount = 0
	t.lastDataAt = time.Now().UnixMilli()
	t.controlActive = false
	t.paneID = ""
	// The respawn re-runs the seating chain (the startup command IS the
	// chain), so the routing state is re-derived afterwards: controlActive
	// flips again, the pane id is re-learned, and onPaneIDLearned re-captures
	// tmuxWindowId and re-runs the routing verification. Clear both so a
	// stale id/flag from the previous incarnation does not survive the reset.
	t.tmuxWindowId = ""
	t.tmuxMisrouted = false
	t.copyModeActive = false
	t.pendingInput = nil
	t.tmuxSizedCols = 0
	t.tmuxSizedRows = 0
	t.pendingCols = 0
	t.pendingRows = 0
	t.parseState = &ParseState{}
	t.pendingBlocks = nil
	t.sessionTarget = ""
	t.historyFetched = false
	go f.readOutput(t.name, file, gen)
	return t.pid, nil
}

// respawnTmuxWindowLocked is the clearStrategy "respawn" mechanism for a
// TMUX-SEATED seat, where replacing the pty is the wrong operation entirely.
//
// A tmux seat's pty runs a `tmux attach` CLIENT. The agent lives in a tmux
// WINDOW owned by the tmux server, which is a separate daemon session and not
// in this pty's process group — killProcessTree kills the client and leaves
// the agent running (fleet.close() has to issue an explicit `tmux kill-window`
// for exactly this reason). Re-running t.startupCommand does not help either:
// for a tmux seat that field holds the whole seating chain, which finds the
// session AND the window still present, takes its reuse branch (which
// deliberately does NOT re-run the CLI) and `exec tmux attach`es back to the
// very session the reset was meant to replace. Nothing is cleared, the
// declared --model is never re-read, and the argv suffix would land after
// `exec tmux -u attach`, where tmux reads it as a usage error and the pane
// dies.
//
// `respawn-window -k` is the operation that matches the intent: tmux kills the
// window's current command and starts a new one IN THE SAME WINDOW, so the
// window id, the pane, this pty, the session log and every attached client
// survive while the CLI is genuinely a new process started from the seat's own
// declared command.
//
// Caller MUST hold t.mu.
func (f *fleet) respawnTmuxWindowLocked(t *terminal, family, prompt string) (int, error) {
	// The composed CLI is the only honest source here. startupCommand is the
	// seating chain (see above) and startupCommandInner drops the transport
	// prefix, so falling back to it on a non-local seat would respawn the CLI
	// on the wrong machine. Inner is accepted ONLY where it is the same string
	// by construction (a local seat, whose composition adds no prefix), and the
	// source is logged either way.
	cmdStr, source := t.startupCommandComposed, "composed"
	if cmdStr == "" && (t.machineId == "" || t.machineId == "local") {
		cmdStr, source = t.startupCommandInner, "inner(local)"
	}
	if cmdStr == "" {
		return 0, fmt.Errorf("respawn requires a recorded CLI command for role %q on machine %q (tmux seat %s:%s); refusing to guess one out of the seating chain",
			t.role, t.machineId, t.tmuxSession, t.tmuxWindow)
	}
	target := "=" + t.tmuxSession + ":" + t.tmuxWindow
	line := cmdStr + respawnArgvSuffix(family, prompt)
	log.Printf("[respawn] %s: tmux respawn-window -k -t %s (command source: %s)", t.name, target, source)
	if out, err := exec.Command("tmux", "respawn-window", "-k", "-t", target, line).CombinedOutput(); err != nil {
		return 0, fmt.Errorf("tmux respawn-window failed for %s: %v: %s", target, err, strings.TrimSpace(string(out)))
	}
	// Read the NEW pane's pid back: this pty's own pid is the attach client's
	// and does not change, so reporting it would make a respawn look like a
	// no-op. A failed read-back returns 0, which the caller reports as
	// `pidSource: "unavailable"` rather than as a plausible-looking pid.
	out, err := exec.Command("tmux", "list-panes", "-t", target, "-F", "#{pane_pid}").Output()
	if err != nil {
		return 0, nil
	}
	pid, convErr := strconv.Atoi(strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0]))
	if convErr != nil {
		return 0, nil
	}
	return pid, nil
}

// respawnAndReinject is the full clearStrategy "respawn" sequence: replace the
// CLI with a fresh login shell, wait for the shell to produce output (so the
// re-injected startup command lands in a shell that is reading stdin), then
// write startupCommand + argv-suffix + \r. The argv suffix carries the prompt
// in the family's declared shape (e.g. ` -- "prompt"` for devin); an empty
// prompt (the clear button) re-injects the bare startup command, restarting
// the CLI idle — exactly as at initial spawn.
//
// Returns a delivery-shaped map so the clear verbs and deliverPrompt's clear
// branch can report the same fields (cleared, respawned, pid, error) callers
// already read. A child that exits immediately is reported as cleared=false
// with the error — unlike the old /clear path, which returned {cleared: true}
// even on failure.
func (f *fleet) respawnAndReinject(t *terminal, family, prompt string) map[string]any {
	// A tmux-seated seat is respawned IN ITS WINDOW, never by replacing this
	// pty — the pty is only the attach client, and the seating chain is not
	// re-runnable as a reset. See respawnTmuxWindowLocked.
	if t.tmuxSession != "" && t.tmuxWindow != "" {
		pid, err := f.respawnTmuxWindowLocked(t, family, prompt)
		if err != nil {
			return map[string]any{"success": false, "cleared": false, "respawned": true, "error": err.Error()}
		}
		t.promptCount = 1
		res := map[string]any{"success": true, "cleared": true, "respawned": true, "tmuxWindow": true}
		if pid > 0 {
			res["pid"] = pid
			res["pidSource"] = "tmux-pane"
		} else {
			res["pidSource"] = "unavailable"
		}
		return res
	}
	pid, err := f.respawnTerminal(t)
	if err != nil {
		return map[string]any{"success": false, "cleared": false, "respawned": true, "error": err.Error()}
	}
	// Wait for the fresh login shell to produce output before re-injecting,
	// reusing the cold-boot first-readiness gate. Readiness here is the shell
	// coming up (it prints its prompt), not a signal scraped from post-clear
	// output — respawn is a cold boot.
	ceiling, quiet := firstReadinessWindows(family)
	reason, _, waitErr := f.waitReadiness(t, ceiling, quiet, false, nil, nil)
	if waitErr != nil {
		return map[string]any{"success": false, "cleared": false, "respawned": true, "error": waitErr.Error(), "pid": pid}
	}
	if reason == "exit" {
		return map[string]any{"success": false, "cleared": false, "respawned": true, "error": "terminal exited during respawn boot", "pid": pid}
	}
	// Re-inject the startup command with the prompt appended in the family's
	// argv shape. The shell is fresh — no completion menu, no leftover
	// buffer, no running TUI composer — so a single write + \r starts the
	// CLI with the prompt as an argument, exactly as at initial spawn.
	line := t.startupCommand + respawnArgvSuffix(family, prompt) + "\r"
	if err := writeToPty(t, line); err != nil {
		return map[string]any{"success": false, "cleared": false, "respawned": true, "error": err.Error(), "pid": pid}
	}
	t.promptCount = 1
	return map[string]any{"success": true, "cleared": true, "respawned": true, "pid": pid}
}

func (t *terminal) subscribe() (<-chan string, func()) {
	ch := make(chan string, 256)
	t.listenersMu.Lock()
	if t.listeners == nil {
		t.listeners = make(map[chan string]struct{})
	}
	t.listeners[ch] = struct{}{}
	t.listenersMu.Unlock()
	return ch, func() {
		t.listenersMu.Lock()
		delete(t.listeners, ch)
		t.listenersMu.Unlock()
	}
}

func (t *terminal) emit(chunk string) {
	t.listenersMu.Lock()
	defer t.listenersMu.Unlock()
	for ch := range t.listeners {
		select {
		case ch <- chunk:
		default:
		}
	}
}

func (f *fleet) get(name string) (*terminal, bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	t, ok := f.terminals[name]
	return t, ok
}

// write puts bytes on the pty. `slashCommand` is the CALLER'S declaration that
// this write is a deliberate slash command and wants the input line reset and a
// submitting CR; it is never inferred from the data.
//
// This function is the transport. The operator's keystrokes reach it from the
// browser by the same door the board's own commands do — gateway -> handle.write
// -> ptyWrite -> here — so any content rule applied at this level applies to a
// human's fingers. See isSlashCommand for what that cost.
func (f *fleet) write(name, data string, slashCommand bool) (map[string]any, error) {
	t, ok := f.get(name)
	if !ok {
		return map[string]any{"success": false, "error": "No such terminal: " + name}, nil
	}
	if t.status != "active" {
		return map[string]any{"success": false, "error": "Terminal " + name + " is not active"}, nil
	}
	if slashCommand {
		if !isSlashCommand(data) {
			return map[string]any{"success": false, "error": "slashCommand write is not a single-line slash command"}, nil
		}
		if err := writeSlashLocked(t, strings.TrimRight(data, "\r\n")); err != nil {
			return nil, err
		}
		return map[string]any{"success": true}, nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := writeToPty(t, data); err != nil {
		return nil, err
	}
	return map[string]any{"success": true}, nil
}

func (f *fleet) handleVerb(verb string, payload map[string]any) (any, error) {
	if !ptyhost.IsSupportedVerb(verb) {
		return ptyhost.ErrorResponse{Success: false, Error: fmt.Sprintf("Unknown terminal verb '%s'", verb), Code: "unknown_verb"}, nil
	}
	switch verb {
	case "ptyCreateTerminal":
		return f.create(payload)
	case "ptyCreateBatch":
		items, _ := payload["terminals"].([]any)
		if items == nil {
			if allocation, ok := payload["allocation"].([]any); ok {
				items = allocation
			}
		}
		created := make([]any, 0, len(items))
		failed := make([]any, 0)
		for _, item := range items {
			spec, ok := item.(map[string]any)
			if !ok {
				continue
			}
			result, err := f.create(spec)
			if err != nil {
				failed = append(failed, map[string]any{"role": strField(spec, "role"), "reason": err.Error(), "kind": "spawn-failed"})
				continue
			}
			created = append(created, result)
		}
		return map[string]any{"success": len(failed) == 0, "created": created, "failed": failed}, nil
	case "ptyListTerminals":
		f.mu.RLock()
		defer f.mu.RUnlock()
		rows := make([]map[string]any, 0, len(f.terminals))
		liveness := make([]map[string]any, 0, len(f.terminals))
		for _, t := range f.terminals {
			rows = append(rows, f.project(t))
			liveness = append(liveness, map[string]any{"friendlyName": t.name, "lastDataAt": t.lastDataAt, "status": t.status, "role": t.role})
		}
		return map[string]any{
			"success":         true,
			"terminals":       rows,
			"liveness":        liveness,
			"workspaceRoot":   f.root,
			"protocolVersion": ptyhost.ProtocolVersion,
			"pid":             os.Getpid(),
		}, nil
	case "ptyCloseTerminal":
		name, _ := payload["name"].(string)
		// killTmuxView is true ONLY for an operator close. A `teardown: true`
		// caller is the board shutting the fleet down, and must leave tmux alone.
		//
		// This verb is not reached only by operator clicks: `disposeAll()`
		// (bootstrap.ts `stop()`, run whenever `!surviveBoard` — which is the
		// DEFAULT) kills every seat through `handle.pty.kill()`, and that is
		// wired to this same verb (goPtyFleetProjection.ts:893). So every board
		// restart was arriving here with killTmuxView=true and destroying the
		// whole fleet's tmux sessions — agents included.
		//
		// The old comment here claimed "a restart never reaches close() at all
		// (disposeAll is gated by !surviveBoard)". That reads the gate backwards:
		// !surviveBoard is TRUE by default, so disposeAll runs on every restart.
		// Observed 2026-09-12: a restart for an unrelated fix took a running
		// coding team with it, leaving one orphaned view session behind.
		//
		// This restores the plan's invariant: "A board restart closes nothing —
		// session count and agent pids are identical across it."
		teardown, _ := payload["teardown"].(bool)
		return map[string]any{"success": f.close(name, !teardown)}, nil
	case "ptyClearAllTerminals":
		f.mu.RLock()
		active := make([]*terminal, 0, len(f.terminals))
		for _, t := range f.terminals {
			if t.status == "active" {
				active = append(active, t)
			}
		}
		f.mu.RUnlock()
		clearedCount := 0
		for _, t := range active {
			// Consult the declared per-family strategy. Respawn families get
			// a fresh login shell + startup-command re-inject (the operator-
			// facing clear button respawns a Devin seat instead of driving a
			// hidden restart through its composer). in-process families keep
			// the /clear input-box path. The per-terminal lock serializes the
			// respawn against any in-flight deliverPrompt paste on the same
			// seat — the clear button bypasses the Node-side withTerminalLock,
			// so t.mu is the only serialization here.
			if clearStrategy(t.cliFamily) == "respawn" {
				t.mu.Lock()
				res := f.respawnAndReinject(t, t.cliFamily, "")
				t.mu.Unlock()
				if res["success"] == true {
					clearedCount++
				}
				continue
			}
			if err := writeSlashLocked(t, "/clear"); err == nil {
				clearedCount++
			}
		}
		return map[string]any{"success": true, "cleared": clearedCount}, nil
	case "ptyClearTerminal":
		name, _ := payload["name"].(string)
		t, ok := f.get(name)
		if !ok {
			return map[string]any{"success": false, "error": "No such terminal: " + name}, nil
		}
		if t.status != "active" {
			return map[string]any{"success": true}, nil
		}
		// Consult the declared per-family strategy. Respawn families get a
		// fresh login shell + startup-command re-inject; in-process families
		// keep /clear. The per-terminal lock (t.mu) serializes the respawn
		// against an in-flight deliverPrompt paste — the clear button bypasses
		// the Node-side withTerminalLock, so t.mu is the only serialization.
		if clearStrategy(t.cliFamily) == "respawn" {
			t.mu.Lock()
			res := f.respawnAndReinject(t, t.cliFamily, "")
			t.mu.Unlock()
			return res, nil
		}
		if err := writeSlashLocked(t, "/clear"); err != nil {
			return nil, err
		}
		return map[string]any{"success": true}, nil
	case "ptySendModel":
		name, _ := payload["name"].(string)
		t, ok := f.get(name)
		if !ok {
			return map[string]any{"success": false, "error": "No such terminal: " + name}, nil
		}
		if t.status == "active" {
			if err := writeSlashLocked(t, "/model"); err != nil {
				return nil, err
			}
		}
		return map[string]any{"success": true}, nil
	case "ptySendPrompt":
		name, _ := payload["name"].(string)
		prompt := strField(payload, "data")
		if prompt == "" {
			prompt = strField(payload, "prompt")
		}
		if prompt == "" {
			prompt = strField(payload, "text")
		}
		clearBefore, _ := payload["clearBeforePrompt"].(bool)
		delayMs := 0
		if v, ok := payload["clearBeforePromptDelayMs"].(float64); ok {
			delayMs = int(v)
		}
		// Only an explicit true shortens the delivery floor; absent or malformed
		// takes the longer unattended cap. The safe direction is the default.
		attended, _ := payload["attended"].(bool)
		return f.deliverPrompt(name, prompt, clearBefore, delayMs, strField(payload, "cliFamily"), attended), nil
	case "ptyWrite":
		name, _ := payload["name"].(string)
		data, _ := payload["data"].(string)
		return f.write(name, data, boolField(payload, "slashCommand"))
	case "ptyRenameTerminal":
		name, _ := payload["name"].(string)
		alias, _ := payload["alias"].(string)
		if alias == "" {
			return map[string]any{"success": false, "error": "missing alias"}, nil
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		t, ok := f.terminals[name]
		if !ok {
			return map[string]any{"success": false, "error": "terminal not found"}, nil
		}
		if _, exists := f.terminals[alias]; exists {
			return map[string]any{"success": false, "error": "terminal name already exists"}, nil
		}
		delete(f.terminals, name)
		t.name = alias
		f.terminals[alias] = t
		if f.clients[name] != nil {
			f.clients[alias] = f.clients[name]
			delete(f.clients, name)
		}
		f.rings[alias] = f.rings[name]
		delete(f.rings, name)
		f.nextSeq[alias] = f.nextSeq[name]
		delete(f.nextSeq, name)
		f.ensureOutputMapsLocked()
		f.pendingOutput[alias] = f.pendingOutput[name]
		delete(f.pendingOutput, name)
		f.flushWindowMs[alias] = f.flushWindowMs[name]
		delete(f.flushWindowMs, name)
		f.renameLog(name, alias)
		return map[string]any{"success": true, "name": alias}, nil
	case "ptySetControllerSeat":
		if seat, ok := payload["seat"].(map[string]any); ok {
			f.controllerSeat = seat
		} else {
			f.controllerSeat = nil
		}
		return map[string]any{"success": true}, nil
	case "ptyRollLogSession":
		name, _ := payload["name"].(string)
		f.rollLog(name)
		return map[string]any{"success": true}, nil
	case "ptyPasteImage":
		return map[string]any{"success": false, "error": "image paste requires the host image adapter", "code": "unsupported_implementation"}, nil
	default:
		return ptyhost.ErrorResponse{Success: false, Error: "verb is reserved until its conformance adapter is installed", Code: "unsupported_implementation"}, nil
	}
}

func main() {
	root := "."
	surviveParent := false
	for i := 1; i < len(os.Args); i++ {
		if os.Args[i] == "--workspace" && i+1 < len(os.Args) {
			root = os.Args[i+1]
			i++
		} else if os.Args[i] == "--survive-parent" {
			surviveParent = true
		}
	}
	root, _ = filepath.Abs(root)
	f := &fleet{root: root, token: randomToken(), terminals: map[string]*terminal{}, clients: map[string]map[*wsClient]struct{}{}, rings: map[string][]outputEvent{}, nextSeq: map[string]uint64{}, logDir: filepath.Join(root, ".switchboard", "logs"), logState: map[string]*sessionLog{}, pendingOutput: map[string]*pendingBuf{}, flushWindowMs: map[string]int64{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/terminal", f.handleWebSocket)
	mux.HandleFunc("/api/pty/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !f.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, ptyhost.ErrorResponse{Success: false, Error: "unauthorized"})
			return
		}
		verb := strings.TrimPrefix(r.URL.Path, "/api/pty/")
		if verb == "ptyPasteImage" && r.Header.Get("Content-Type") == "application/octet-stream" {
			name := r.URL.Query().Get("name")
			if _, ok := f.get(name); !ok {
				writeJSON(w, http.StatusNotFound, ptyhost.ErrorResponse{Success: false, Error: "terminal not found"})
				return
			}
			body, err := io.ReadAll(io.LimitReader(r.Body, 4*1024*1024+1))
			if err != nil {
				writeJSON(w, http.StatusBadRequest, ptyhost.ErrorResponse{Success: false, Error: err.Error()})
				return
			}
			if len(body) > 4*1024*1024 {
				writeJSON(w, http.StatusRequestEntityTooLarge, ptyhost.ErrorResponse{Success: false, Error: "Image exceeds max size"})
				return
			}
			ext := ".png"
			mime := r.URL.Query().Get("mimeType")
			if mime == "image/jpeg" {
				ext = ".jpg"
			} else if mime == "image/gif" {
				ext = ".gif"
			} else if mime == "image/webp" {
				ext = ".webp"
			}
			dir := filepath.Join(os.TempDir(), "switchboard-paste")
			if err := os.MkdirAll(dir, 0o700); err != nil {
				writeJSON(w, 500, ptyhost.ErrorResponse{Success: false, Error: err.Error()})
				return
			}
			filePath := filepath.Join(dir, fmt.Sprintf("paste-%d-%s%s", time.Now().UnixNano(), randomToken()[:8], ext))
			if err := os.WriteFile(filePath, body, 0o600); err != nil {
				writeJSON(w, 500, ptyhost.ErrorResponse{Success: false, Error: err.Error()})
				return
			}
			atPath := "@" + filePath
			if strings.ContainsAny(filePath, " \t") {
				atPath = `@"` + filePath + `"`
			}
			if _, err := f.write(name, "\x1b[200~"+atPath+"\x1b[201~", false); err != nil {
				writeJSON(w, 500, ptyhost.ErrorResponse{Success: false, Error: err.Error()})
				return
			}
			writeJSON(w, 200, map[string]any{"success": true, "filePath": filePath})
			return
		}
		if r.ContentLength > 10*1024*1024 {
			writeJSON(w, http.StatusRequestEntityTooLarge, ptyhost.ErrorResponse{Success: false, Error: "request exceeds 10 MB"})
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 10*1024*1024+1))
		if err != nil {
			writeJSON(w, 400, ptyhost.ErrorResponse{Success: false, Error: err.Error()})
			return
		}
		var payload map[string]any
		if len(body) != 0 {
			if err := json.Unmarshal(body, &payload); err != nil {
				writeJSON(w, 400, ptyhost.ErrorResponse{Success: false, Error: "Invalid JSON payload"})
				return
			}
		} else {
			payload = map[string]any{}
		}
		result, err := f.handleVerb(verb, payload)
		if err != nil {
			writeJSON(w, 500, ptyhost.ErrorResponse{Success: false, Error: err.Error()})
			return
		}
		writeJSON(w, 200, result)
	})
	server := &http.Server{Handler: mux}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	listenPort := listener.Addr().(*net.TCPAddr).Port
	startedAt := time.Now().UnixMilli()
	pid := os.Getpid()

	stateFilePath := filepath.Join(f.root, ".switchboard", "pty-host-state.json")
	// `surviveParent` records whether this host was started to outlive its parent.
	// Every host writes a state file, so the successor board needs it to tell an
	// adoptable host from one whose parent-death watcher is about to dispose it.
	// (Kept above the literal: a comment inside breaks gofmt's key-alignment
	// group for every entry that follows it.)
	stateFilePayload := map[string]any{
		"port":            listenPort,
		"token":           f.token,
		"protocolVersion": ptyhost.ProtocolVersion,
		"workspaceRoot":   f.root,
		"pid":             pid,
		"startedAt":       startedAt,
		"surviveParent":   surviveParent,
	}
	if stateBytes, err := json.Marshal(stateFilePayload); err == nil {
		_ = os.MkdirAll(filepath.Dir(stateFilePath), 0o755)
		_ = os.WriteFile(stateFilePath, stateBytes, 0o600)
	}

	cleanStateFile := func() {
		_ = os.Remove(stateFilePath)
	}

	fmt.Printf("%s\n", mustJSON(ptyhost.Ready{T: "ready", Version: ptyhost.ProtocolVersion, Port: listenPort, Token: f.token}))
	_ = os.Stdout.Sync()
	term := make(chan os.Signal, 1)
	signal.Notify(term, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-term
		cleanStateFile()
		f.dispose()
		_ = server.Close()
	}()
	if !surviveParent {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			cleanStateFile()
			f.dispose()
			_ = server.Close()
		}()
		if runtime.GOOS != "windows" {
			initialParent := os.Getppid()
			go func() {
				for {
					time.Sleep(200 * time.Millisecond)
					if os.Getppid() != initialParent {
						cleanStateFile()
						f.dispose()
						_ = server.Close()
						return
					}
				}
			}()
		}
	}
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		cleanStateFile()
		log.Fatal(err)
	}
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		log.Fatal(err)
	}
	return string(b)
}
