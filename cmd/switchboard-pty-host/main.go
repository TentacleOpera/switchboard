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
	clients        map[string]map[*websocket.Conn]struct{}
	rings          map[string][]outputEvent
	nextSeq        map[string]uint64
	logMu          sync.Mutex
	logDir         string
	logState       map[string]*sessionLog
	controllerSeat map[string]any
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
		// Recorded at create so a respawn (clearStrategy "respawn") can
		// re-inject the seat's startup command verbatim — the only way a
		// declared --model holds across a reset, since /clear restarts
		// Devin's session internally and never re-reads the startup command.
		// The Go host replays this string into a fresh login shell; it never
		// re-derives or parses it. See
		// a-seats-clear-strategy-is-declared-per-cli-family-not-assumed.md.
		startupCommand: strField(payload, "startupCommand"),
		env:            env,
	}
	if controlMode {
		t.parseState = &ParseState{}
	}
	f.terminals[name] = t
	f.clients[name] = make(map[*websocket.Conn]struct{})
	f.rings[name] = nil
	f.nextSeq[name] = 0
	go f.readOutput(name, file)
	return map[string]any{"success": true, "terminal": f.project(t)}, nil
}

func (f *fleet) readOutput(name string, file *os.File) {
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
			f.mu.Lock()
			if t := f.terminals[name]; t != nil {
				t.status = "exited"
			}
			clients := f.clients[name]
			delete(f.clients, name)
			f.mu.Unlock()
			for client := range clients {
				_ = client.WriteJSON(map[string]any{"t": "exit", "code": 0})
				_ = client.Close()
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
					if !t.historyFetched {
						t.historyFetched = true
						t.pendingBlocks = append(t.pendingBlocks, blockScrollback, blockPending)
						_ = sendHistoryFetchLocked(t)
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
func (f *fleet) onPaneIDLearned(name string, t *terminal) {
	t.mu.Lock()
	cols, rows := t.pendingCols, t.pendingRows
	t.pendingCols, t.pendingRows = 0, 0
	t.mu.Unlock()
	if cols > 0 && rows > 0 {
		_ = ptyResize(t, cols, rows)
	}
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
			t.pendingBlocks = append(t.pendingBlocks, blockPaneID)
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
	clients := make([]*websocket.Conn, 0, len(f.clients[name]))
	for client := range f.clients[name] {
		clients = append(clients, client)
	}
	f.mu.Unlock()
	msg := map[string]any{"t": "control", "event": event}
	if fields != nil {
		msg["fields"] = fields
	}
	for _, client := range clients {
		if err := client.WriteJSON(msg); err != nil {
			_ = client.Close()
			f.removeClient(name, client)
		}
	}
}

// routeOutput feeds decoded terminal bytes to the three consumers: the log
// tee, the scrollback ring, and the browser (binary WS frames). This is the
// body the old publish() had, factored out so the control-mode demux can call
// it with decoded output instead of raw bytes.
func (f *fleet) routeOutput(name, data string) {
	f.logOutput(name, data)
	f.mu.Lock()
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
	clients := make([]*websocket.Conn, 0, len(f.clients[name]))
	for client := range f.clients[name] {
		clients = append(clients, client)
	}
	f.mu.Unlock()
	for _, client := range clients {
		// Binary frames, matching terminalWsGateway.ts — see encodeOutputFrame and
		// the note in ws.go. The client's binary branch is the one that tracks seq,
		// handles the replay boundary and suppresses answerback; the JSON `out`
		// path is a legacy fallback that does none of that.
		if err := client.WriteMessage(websocket.BinaryMessage, encodeOutputFrame(event.Seq, event.Data)); err != nil {
			_ = client.Close()
			f.removeClient(name, client)
		}
	}
}

func (f *fleet) removeClient(name string, client *websocket.Conn) {
	f.mu.Lock()
	if clients := f.clients[name]; clients != nil {
		delete(clients, client)
	}
	f.mu.Unlock()
}

func (f *fleet) close(name string) bool {
	f.mu.Lock()
	t := f.terminals[name]
	clients := f.clients[name]
	delete(f.terminals, name)
	delete(f.clients, name)
	delete(f.rings, name)
	delete(f.nextSeq, name)
	f.mu.Unlock()
	for client := range clients {
		_ = client.WriteJSON(map[string]any{"t": "exit", "code": 0})
		_ = client.Close()
	}
	if t == nil {
		return false
	}
	killProcessTree(t)
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
		f.close(n)
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
	t.copyModeActive = false
	t.pendingInput = nil
	t.pendingCols = 0
	t.pendingRows = 0
	t.parseState = &ParseState{}
	t.pendingBlocks = nil
	t.sessionTarget = ""
	t.historyFetched = false
	go f.readOutput(t.name, file)
	return t.pid, nil
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
		return map[string]any{"success": f.close(name)}, nil
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
		return f.deliverPrompt(name, prompt, clearBefore, delayMs, strField(payload, "cliFamily")), nil
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
	f := &fleet{root: root, token: randomToken(), terminals: map[string]*terminal{}, clients: map[string]map[*websocket.Conn]struct{}{}, rings: map[string][]outputEvent{}, nextSeq: map[string]uint64{}, logDir: filepath.Join(root, ".switchboard", "logs"), logState: map[string]*sessionLog{}}
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
