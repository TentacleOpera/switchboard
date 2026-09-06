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
	name                  string
	role                  string
	cmd                   *exec.Cmd
	file                  *os.File
	pid                   int
	mu                    sync.Mutex
	status                string
	cwd                   string
	worktreePath          string
	agentInstanceId       string
	parentInstanceId      string
	startTime             string
	lastDataAt            int64
	promptCount           int
	hidden                bool
	cliFamily             string
	startupCommand        string
	startupCommandSource  string
	claudeInlineRendering bool
	isTeamMember          bool
	listenersMu           sync.Mutex
	listeners             map[chan string]struct{}
}

type outputEvent struct {
	Seq  uint64 `json:"seq"`
	Data string `json:"data"`
}

type fleet struct {
	root      string
	token     string
	mu        sync.RWMutex
	terminals map[string]*terminal
	clients   map[string]map[*websocket.Conn]struct{}
	rings     map[string][]outputEvent
	nextSeq   map[string]uint64
	logMu     sync.Mutex
	logDir    string
	logState  map[string]*sessionLog
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
	name := strField(payload, "name")
	if name == "" {
		name = "terminal-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	role := strField(payload, "role")
	if role == "" {
		role = "coder"
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
	if _, exists := f.terminals[name]; exists {
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
	t := &terminal{
		name: name, role: role, cmd: cmd, file: file, pid: cmd.Process.Pid,
		status: "active", cwd: cwd, worktreePath: strField(payload, "worktreePath"),
		agentInstanceId: agentID, parentInstanceId: strField(payload, "parentInstanceId"),
		startTime: now.UTC().Format(time.RFC3339Nano), lastDataAt: now.UnixMilli(),
		hidden: boolField(payload, "hidden"), claudeInlineRendering: claudeInline,
		isTeamMember: boolField(payload, "_isTeamMember"),
		listeners: make(map[chan string]struct{}),
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
				t.emit(chunk)
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

func (f *fleet) publish(name, data string) {
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
		if err := client.WriteJSON(map[string]any{"t": "output", "seq": event.Seq, "data": event.Data}); err != nil {
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

func (f *fleet) write(name, data string) (map[string]any, error) {
	t, ok := f.get(name)
	if !ok {
		return map[string]any{"success": false, "error": "No such terminal: " + name}, nil
	}
	if t.status != "active" {
		return map[string]any{"success": false, "error": "Terminal " + name + " is not active"}, nil
	}
	if isSlashCommand(data) {
		if err := writeSlashLocked(t, strings.TrimRight(data, "\r\n")); err != nil {
			return nil, err
		}
		return map[string]any{"success": true}, nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	_, err := io.WriteString(t.file, data)
	if err != nil {
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
		return map[string]any{"success": true, "terminals": rows, "liveness": liveness}, nil
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
		for _, t := range active {
			_ = writeSlashLocked(t, "/clear")
		}
		return map[string]any{"success": true, "cleared": len(active)}, nil
	case "ptyClearTerminal":
		name, _ := payload["name"].(string)
		t, ok := f.get(name)
		if !ok {
			return map[string]any{"success": false, "error": "No such terminal: " + name}, nil
		}
		if t.status == "active" {
			if err := writeSlashLocked(t, "/clear"); err != nil {
				return nil, err
			}
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
		return f.write(name, data)
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
	for i := 1; i+1 < len(os.Args); i++ {
		if os.Args[i] == "--workspace" {
			root = os.Args[i+1]
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
			if _, err := f.write(name, "\x1b[200~"+atPath+"\x1b[201~"); err != nil {
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
	fmt.Printf("%s\n", mustJSON(ptyhost.Ready{T: "ready", Version: ptyhost.ProtocolVersion, Port: listener.Addr().(*net.TCPAddr).Port, Token: f.token}))
	_ = os.Stdout.Sync()
	term := make(chan os.Signal, 1)
	signal.Notify(term, os.Interrupt, syscall.SIGTERM)
	go func() { <-term; f.dispose(); _ = server.Close() }()
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		f.dispose()
		_ = server.Close()
	}()
	if runtime.GOOS != "windows" {
		initialParent := os.Getppid()
		go func() {
			for {
				time.Sleep(200 * time.Millisecond)
				if os.Getppid() != initialParent {
					f.dispose()
					_ = server.Close()
					return
				}
			}
		}()
	}
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
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
