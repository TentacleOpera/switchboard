package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:    4096,
	WriteBufferSize:   4096,
	EnableCompression: true,
	// Accept loopback, and accept SAME-ORIGIN.
	//
	// A loopback-only allowlist refuses every remote viewer while passing every
	// terminal-based test, because a browser always sends Origin and curl does
	// not (note the empty-Origin case below returns true). The board proxies
	// terminal upgrades from its own listener — which in tailnet mode is a
	// 100.64.0.0/10 address — and forwards Host and Origin verbatim, so the
	// honest test is whether the page came from the same origin it is dialling,
	// not whether that origin happens to be loopback.
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		switch u.Hostname() {
		case "127.0.0.1", "localhost", "::1", "[::1]":
			return true
		}
		return u.Host == r.Host
	},
}

type wsMessage struct {
	T    string `json:"t"`
	Data string `json:"data"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// One concurrent writer per connection is gorilla/websocket's documented contract.
// With EnableCompression the writers share one flate compressor, so violating it is
// not interleaved frames but a panic inside compress/flate — see the 2026-09-12
// deflateFast.matchLen crash. This mutex is the only thing enforcing the contract.
type wsClient struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
}

func (c *wsClient) writeMessage(messageType int, data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteMessage(messageType, data)
}

func (c *wsClient) writeJSON(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteJSON(v)
}

func (f *fleet) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("token") != f.token || f.token == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	name := r.URL.Query().Get("name")
	t, ok := f.get(name)
	if !ok {
		http.Error(w, "Terminal not found", http.StatusNotFound)
		return
	}
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	client := &wsClient{conn: conn}
	f.mu.Lock()
	if f.clients[name] == nil {
		f.clients[name] = make(map[*wsClient]struct{})
	}
	f.clients[name][client] = struct{}{}
	replay := append([]outputEvent(nil), f.rings[name]...)
	f.mu.Unlock()
	defer func() { f.removeClient(name, client); _ = conn.Close() }()
	// hello + ONE coalesced binary replay frame — the shape terminals.js is built
	// for (see setupClient in terminalWsGateway.ts, the reference implementation).
	//
	// `replayChars` is load-bearing and was previously omitted. The client arms
	// `awaitingReplayFrame` only when hello reports replayChars > 0, and only that
	// path routes the next binary frame through writeReplay(), which sets
	// `suppressAnswerback` while the scrollback is parsed. Without it the replay is
	// treated as LIVE output, so xterm dutifully answers the device queries buried
	// in it — an OSC 10/11 colour query replayed from the ring gets a fresh
	// `ESC]10;rgb:...` reply typed straight back into the pty, which the shell then
	// echoes as literal text.
	//
	// One frame, not one per ring event: the client's contract is "the NEXT binary
	// frame after hello is the replay, and nothing else can be".
	lastSeq, _ := strconv.ParseUint(r.URL.Query().Get("lastSeq"), 10, 64)
	var replayBuf strings.Builder
	var replaySeq uint64
	for _, event := range replay {
		if event.Seq > lastSeq {
			replayBuf.WriteString(event.Data)
			replaySeq = event.Seq
		}
	}
	replayText := replayBuf.String()
	// hello + the ONE coalesced replay frame must reach the client back-to-back: the
	// client arms awaitingReplayFrame from hello.replayChars and treats the NEXT binary
	// frame as the replay. A publish landing between them is parsed as scrollback.
	// The lock is taken explicitly (not via client.writeJSON/writeMessage) because the
	// mutex is non-reentrant and is already held here — this is the one place in the
	// host that takes the lock by hand, and the comment says why.
	client.writeMu.Lock()
	_ = conn.WriteJSON(map[string]any{
		"t": "hello", "name": name, "seq": f.next(name),
		"replayChars": utf16Len(replayText),
	})
	if replayText != "" {
		_ = conn.WriteMessage(websocket.BinaryMessage, encodeOutputFrame(replaySeq, replayText))
	}
	client.writeMu.Unlock()
	for {
		// Read the raw message, not ReadJSON.
		//
		// terminals.js sends keystrokes as a BINARY frame — encodeInputFrame():
		// one 0x01 opcode byte followed by UTF-8 — and only sends JSON for
		// resize/ack. ReadJSON on a binary frame fails, and the old `return` on
		// error closed the socket, so the first keypress killed the connection
		// and the pane went back to "connecting". Typing was not merely ignored;
		// it disconnected the terminal.
		messageType, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType == websocket.BinaryMessage {
			if len(raw) > 1 && raw[0] == 0x01 {
				// Operator keystrokes. Raw, always: `false` is what keeps a
				// typed "/" from being read as a slash command and answered
				// with Ctrl+U and a submitting CR.
				_, _ = f.write(name, string(raw[1:]), false)
			}
			continue
		}
		var message wsMessage
		if err := json.Unmarshal(raw, &message); err != nil {
			// A frame we cannot parse is skipped, never fatal. Dropping the
			// session over one bad frame is what turned a parse mismatch into a
			// dead terminal.
			continue
		}
		switch message.T {
		case "input":
			// Legacy JSON input frame — operator keystrokes, same as above.
			_, _ = f.write(name, message.Data, false)
		case "resize":
			if message.Cols > 0 && message.Rows > 0 {
				_ = ptyResize(t, message.Cols, message.Rows)
			}
		case "ack":
			// Acknowledgements are accepted for wire compatibility. Output replay
			// is bounded by the ring; live writes remain serialized by the PTY lock.
		}
	}
}

// encodeOutputFrame mirrors encodeOutputFrame() in terminalWsGateway.ts: a
// 4-byte big-endian sequence number followed by the UTF-8 payload. terminals.js
// reads the seq with DataView.getUint32(0, false) and decodes the remainder.
func encodeOutputFrame(seq uint64, payload string) []byte {
	body := []byte(payload)
	frame := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(frame[0:4], uint32(seq))
	copy(frame[4:], body)
	return frame
}

// utf16Len counts UTF-16 code units, which is what JavaScript's String.length
// returns. The client bills replayChars against that, so counting bytes or runes
// would leave its ack ledger permanently skewed on any non-ASCII output — and a
// CLI banner is full of box-drawing and braille characters.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func (f *fleet) next(name string) uint64 { f.mu.RLock(); defer f.mu.RUnlock(); return f.nextSeq[name] }

func ptyResize(t *terminal, cols, rows uint16) error {
	if t.controlMode && t.controlActive {
		return ptyResizeControlMode(t, cols, rows)
	}
	// NOT control mode. Size the host pty first: for a plain seat that is the
	// agent's own terminal, and for a tmux-backed seat it is the terminal the
	// `tmux attach` CLIENT runs in.
	if err := pty.Setsize(t.file, &pty.Winsize{Cols: cols, Rows: rows}); err != nil {
		return err
	}
	// ...but sizing the CLIENT does not size the WINDOW. The seat chain sets
	// `window-size manual`, and under `manual` a window takes its size from
	// `resize-window` and ignores every attached client — the same trap the
	// control-mode branch below documents for `refresh-client -C`. A pty ioctl
	// is that same class of no-op: it sets the client, not the window.
	//
	// The `resize-window` fix was originally written into the control-mode
	// branch ONLY, so turning control mode off put every seat back on the
	// broken path and no browser resize reached any tmux window. Measured on a
	// live team: the lead window sat at 59x24 while its client was 96x33 and
	// its sibling windows were 96x33, because those were merely BORN the right
	// size by `new-window` and nothing had resized any of them since.
	//
	// `t.controlMode` is not the test — being tmux-backed is. This is the same
	// one-flag-two-decisions shape that previously turned "control mode off"
	// into "tmux off" and into "closing a terminal no longer closes its tmux
	// session".
	resizeTmuxWindow(t, cols, rows)
	return nil
}

// resizeTmuxWindow drives `resize-window` for a tmux-backed seat outside
// control mode, where there is no block FIFO to write the command through.
// Best-effort and non-throwing, exactly like the kill-window in fleet.close():
// no tmux, no such session, or a window that has gone away are all "cannot
// resize", never a failed resize for the caller.
//
// `=<session>:<window>` forces an exact session-name match so `lc-coding-team`
// cannot match `lc-coding-team-coder-1`, matching close()'s kill-window target.
// The base session is the right target even though the seat attaches to a view:
// grouped sessions share one window list, so resizing the window there resizes
// it for every view onto it.
//
// The last applied size is cached because the browser sends a resize frame on
// every fit pass, not only on a size CHANGE (`fitAndReportSize` in
// terminalViewport.js sends unconditionally). Without the cache a stationary
// panel would fork a tmux process per frame. A failed resize clears the cache
// so a transient failure is retried rather than latched.
func resizeTmuxWindow(t *terminal, cols, rows uint16) {
	t.mu.Lock()
	session, window := t.tmuxSession, t.tmuxWindow
	if session == "" || window == "" || (t.tmuxSizedCols == cols && t.tmuxSizedRows == rows) {
		t.mu.Unlock()
		return
	}
	t.tmuxSizedCols, t.tmuxSizedRows = cols, rows
	t.mu.Unlock()
	// Run OUTSIDE t.mu — a fork+exec must never be held under the lock the
	// read/write paths take on every chunk.
	if err := exec.Command("tmux", "resize-window", "-t", "="+session+":"+window,
		"-x", strconv.Itoa(int(cols)), "-y", strconv.Itoa(int(rows))).Run(); err != nil {
		t.mu.Lock()
		t.tmuxSizedCols, t.tmuxSizedRows = 0, 0
		t.mu.Unlock()
	}
}

func ptyResizeControlMode(t *terminal, cols, rows uint16) error {
	// Control mode: a pty ioctl does not resize the agent's pane.
	//
	// `resize-window`, NOT `refresh-client -C`. The seat chain sets
	// `window-size manual`, and under `manual` a window takes its size from
	// `resize-window` and IGNORES client size entirely — so `refresh-client -C`,
	// which only sets the CLIENT's size, was a no-op on every seat. The two
	// settings contradict each other and the pane stayed frozen at whatever it
	// started as however large the browser pane was. Measured on tmux 3.4
	// against a live 30x21 seat: `refresh-client -C 160x48` left it 30x21;
	// `resize-window -x 160 -y 48` made it 160x48.
	//
	// `manual` is still the right choice — it is what gives the browser panel
	// deterministic authority instead of ping-ponging with a second attached
	// client — so the fix is to drive it with the command `manual` listens to.
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.paneID == "" {
		// The pane id is not known yet (no %session-changed / list-panes).
		// Remember the desired size and apply it once the pane id arrives.
		t.pendingCols = cols
		t.pendingRows = rows
		return nil
	}
	return writeControlCommandLocked(t, fmt.Sprintf("resize-window -t %%%s -x %d -y %d", t.paneID, cols, rows), blockNone)
}
