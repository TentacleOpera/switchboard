package main

// ws_race_test.go — reproduces the 2026-09-12 deflateFast.matchLen panic: a
// client subscribing while its terminal is producing output raced the upgrade
// handler's hello+replay writes against readOutput's routeOutput writes on the
// SAME *websocket.Conn. With EnableCompression the two writers share one flate
// compressor, so the race is not interleaved frames but a panic inside
// compress/flate.
//
// This test runs under `go test -race`. The race detector fails the test on any
// concurrent write to a conn's internal state; a passing run proves the
// per-connection write lock serialises every write site. A functional test
// proves nothing here — the current code passes every functional test today —
// so the assertion is "completes under -race with no detector report and no
// panic", nothing else.
//
// The test exercises the REAL upgrade handler (handleWebSocket) and the REAL
// fan-out path (publish → routeOutput) with EnableCompression: true on both
// sides, so it sees the same shared-flateWriteWrapper that panicked in
// production.

import (
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestSubscribeUnderLoadRace drives concurrent subscribe/unsubscribe against a
// terminal that is continuously publishing output. Under -race on the
// pre-fix code this reports a concurrent write on the conn; after the fix it
// completes cleanly.
func TestSubscribeUnderLoadRace(t *testing.T) {
	if testing.Short() {
		t.Skip("race test runs a real pty + sustained IO")
	}
	root := t.TempDir()

	// One fleet, one HTTP server, the real /ws/terminal handler. The upgrader
	// (wsUpgrader) has EnableCompression: true, so every upgraded conn carries
	// the shared flateWriteWrapper that panicked in production.
	f := &fleet{
		root:      root,
		token:     randomToken(),
		terminals: map[string]*terminal{},
		clients:   map[string]map[*wsClient]struct{}{},
		rings:     map[string][]outputEvent{},
		nextSeq:   map[string]uint64{},
		logDir:    root,
		logState:  map[string]*sessionLog{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/terminal", f.handleWebSocket)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	defer func() { _ = srv.Close() }()
	time.Sleep(20 * time.Millisecond)
	wsBase := "ws://" + ln.Addr().String()

	created, err := f.create(map[string]any{"name": "race-seat", "role": "coder"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if succ, _ := created["success"].(bool); !succ {
		t.Fatalf("create failed: %v", created)
	}

	// Sustained publisher: drive publish() directly so output is flowing for
	// the entire test regardless of how quiet the login shell is. publish()
	// is the same path readOutput takes, so this exercises routeOutput's
	// WriteMessage fan-out against the same conns the upgrade handler writes
	// hello+replay to.
	chunk := strings.Repeat("x", 256)
	stop := make(chan struct{})
	var pubWG sync.WaitGroup
	pubWG.Add(1)
	go func() {
		defer pubWG.Done()
		for {
			select {
			case <-stop:
				return
			default:
				f.publish("race-seat", chunk)
			}
		}
	}()

	// N subscribers repeatedly dial, read hello (+ replay), then close. The
	// dialer requests permessage-deflate so the server's EnableCompression
	// arms the shared flateWriteWrapper — the exact configuration that
	// panicked in production.
	dialer := websocket.Dialer{
		EnableCompression: true,
	}
	endpoint := wsBase + "/ws/terminal?" + url.Values{"token": {f.token}, "name": {"race-seat"}}.Encode()

	const subscribers = 16
	const iters = 25
	var subWG sync.WaitGroup
	for i := 0; i < subscribers; i++ {
		subWG.Add(1)
		go func() {
			defer subWG.Done()
			for j := 0; j < iters; j++ {
				c, _, err := dialer.Dial(endpoint, nil)
				if err != nil {
					continue
				}
				// Read hello (JSON) and any replay (binary). The race is in
				// the upgrade handler's writes, which complete before Dial
				// returns; reading here keeps the conn alive long enough for
				// routeOutput to fan out to it concurrently.
				_ = c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
				if _, _, err := c.ReadMessage(); err != nil {
					_ = c.Close()
					continue
				}
				_ = c.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
				_, _, _ = c.ReadMessage()
				_ = c.Close()
			}
		}()
	}
	subWG.Wait()

	close(stop)
	pubWG.Wait()

	// A panic would have failed the test already; the race detector fails it
	// on any concurrent-write report. Reaching here is the assertion.
	_ = f.close("race-seat", false)
}
