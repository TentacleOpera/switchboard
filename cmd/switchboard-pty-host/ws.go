package main

import (
	"encoding/binary"
	"encoding/json"
	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"net/http"
	"net/url"
	"strconv"
	"strings"
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
	f.mu.Lock()
	if f.clients[name] == nil {
		f.clients[name] = make(map[*websocket.Conn]struct{})
	}
	f.clients[name][conn] = struct{}{}
	replay := append([]outputEvent(nil), f.rings[name]...)
	f.mu.Unlock()
	defer func() { f.removeClient(name, conn); _ = conn.Close() }()
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
	_ = conn.WriteJSON(map[string]any{
		"t": "hello", "name": name, "seq": f.next(name),
		"replayChars": utf16Len(replayText),
	})
	if replayText != "" {
		_ = conn.WriteMessage(websocket.BinaryMessage, encodeOutputFrame(replaySeq, replayText))
	}
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
				_, _ = f.write(name, string(raw[1:]))
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
			_, _ = f.write(name, message.Data)
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
	return pty.Setsize(t.file, &pty.Winsize{Cols: cols, Rows: rows})
}
