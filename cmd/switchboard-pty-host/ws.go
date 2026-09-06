package main

import (
	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"net/http"
	"net/url"
	"strconv"
)

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:    4096,
	WriteBufferSize:   4096,
	EnableCompression: true,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		return err == nil && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "[::1]")
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
	_ = conn.WriteJSON(map[string]any{"t": "hello", "name": name, "seq": f.next(name)})
	lastSeq, _ := strconv.ParseUint(r.URL.Query().Get("lastSeq"), 10, 64)
	for _, event := range replay {
		if event.Seq > lastSeq {
			_ = conn.WriteJSON(map[string]any{"t": "replay", "seq": event.Seq, "data": event.Data})
		}
	}
	for {
		var message wsMessage
		if err := conn.ReadJSON(&message); err != nil {
			return
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

func (f *fleet) next(name string) uint64 { f.mu.RLock(); defer f.mu.RUnlock(); return f.nextSeq[name] }

func ptyResize(t *terminal, cols, rows uint16) error {
	return pty.Setsize(t.file, &pty.Winsize{Cols: cols, Rows: rows})
}
