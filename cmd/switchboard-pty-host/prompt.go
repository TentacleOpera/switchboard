package main

import (
	"strings"
	"time"
)

const (
	chunkSize            = 256
	chunkDelay           = 8 * time.Millisecond
	submitSettle         = 40 * time.Millisecond
	confirmEnterDelay    = 200 * time.Millisecond
	clearInputSettle     = 30 * time.Millisecond
	defaultClearSettle   = 600 * time.Millisecond
	clearInputLine       = "\x15"
	bracketedPasteOpen   = "\x1b[200~"
	bracketedPasteClose  = "\x1b[201~"
)

func sleep(d time.Duration) { time.Sleep(d) }

func writeSlashLocked(t *terminal, command string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, err := t.file.WriteString(clearInputLine); err != nil {
		return err
	}
	sleep(clearInputSettle)
	if _, err := t.file.WriteString(strings.TrimRight(command, "\r\n")); err != nil {
		return err
	}
	sleep(submitSettle)
	_, err := t.file.WriteString("\r")
	return err
}

func isSlashCommand(data string) bool {
	body := strings.TrimRight(data, "\r\n")
	return body != "" && !strings.Contains(body, "\n") && strings.HasPrefix(strings.TrimLeft(body, " \t"), "/")
}

func firstReadinessWindows(family string) (ceiling, quiet time.Duration) {
	switch family {
	case "claude", "antigravity":
		return 8 * time.Second, 250 * time.Millisecond
	default:
		return 20 * time.Second, 250 * time.Millisecond
	}
}

func clearReadinessWindows(family string) (ceiling, quiet time.Duration, detect bool) {
	switch family {
	case "claude", "antigravity":
		return 3 * time.Second, 300 * time.Millisecond, true
	case "devin":
		return 15 * time.Second, 100 * time.Millisecond, true
	default:
		return 15 * time.Second, 0, false
	}
}

func devinReady(buf string) bool {
	disabledAt := strings.LastIndex(buf, "\x1b[?2004l")
	enabledAt := strings.LastIndex(buf, "\x1b[?2004h")
	if disabledAt < 0 || enabledAt <= disabledAt {
		return false
	}
	after := buf[enabledAt:]
	return strings.Contains(after, "\x1b[?25h") && strings.Contains(after, "\x1b[?2026l")
}

func (f *fleet) alreadyHasOutput(name string) bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return len(f.rings[name]) > 0
}

func (f *fleet) waitReadiness(t *terminal, timeout, quiet time.Duration, alreadySaw bool, pred func(string) bool, kick func() error) (string, int64, error) {
	start := time.Now()
	ch, unsub := t.subscribe()
	defer unsub()
	if kick != nil {
		if err := kick(); err != nil {
			return "", time.Since(start).Milliseconds(), err
		}
	}
	var quietC <-chan time.Time
	var quietTimer *time.Timer
	armQuiet := func() {
		if quiet <= 0 {
			return
		}
		if quietTimer != nil {
			if !quietTimer.Stop() {
				select {
				case <-quietTimer.C:
				default:
				}
			}
		}
		quietTimer = time.NewTimer(quiet)
		quietC = quietTimer.C
	}
	defer func() {
		if quietTimer != nil {
			quietTimer.Stop()
		}
	}()
	if alreadySaw && pred == nil {
		armQuiet()
	}
	ceiling := time.NewTimer(timeout)
	defer ceiling.Stop()
	buf := ""
	saw := alreadySaw
	for {
		if t.status == "exited" {
			return "exit", time.Since(start).Milliseconds(), nil
		}
		select {
		case chunk := <-ch:
			saw = true
			buf += chunk
			if len(buf) > 65536 {
				buf = buf[len(buf)-65536:]
			}
			if pred != nil && !pred(buf) {
				continue
			}
			armQuiet()
		case <-quietC:
			if saw && (pred == nil || pred(buf)) {
				return "signal", time.Since(start).Milliseconds(), nil
			}
		case <-ceiling.C:
			if pred == nil && !saw {
				return "timeout", time.Since(start).Milliseconds(), nil
			}
			return "fallback", time.Since(start).Milliseconds(), nil
		}
	}
}

func (f *fleet) deliverPrompt(name, text string, clearBefore bool, delayMs int, family string) map[string]any {
	t, ok := f.get(name)
	if !ok {
		return map[string]any{"success": false, "error": "No such terminal: " + name}
	}
	if t.status != "active" {
		return map[string]any{"success": false, "error": "Terminal " + name + " is not active"}
	}
	bootPhase := t.promptCount == 0
	effectiveClear := clearBefore && !bootPhase
	readiness := map[string]any{}
	start := time.Now()
	cleared := false
	if family == "" {
		family = t.cliFamily
	}
	if bootPhase && t.status == "exited" {
		return map[string]any{
			"success": false, "error": "Terminal '" + name + "' exited during boot — prompt was not delivered",
			"bytesWritten": 0, "deliveredAt": time.Now().UnixMilli(), "bootPhase": true, "cleared": false,
			"deliveryReason": "exit", "readiness": map[string]any{"reason": "exit", "elapsedMs": 0},
		}
	}
	if bootPhase {
		ceiling, quiet := firstReadinessWindows(family)
		reason, elapsed, err := f.waitReadiness(t, ceiling, quiet, f.alreadyHasOutput(name), nil, nil)
		if err != nil {
			return map[string]any{"success": false, "error": err.Error(), "bootPhase": true, "cleared": false}
		}
		readiness = map[string]any{"reason": reason, "elapsedMs": elapsed}
		if reason == "exit" {
			return map[string]any{
				"success": false, "error": "Terminal '" + name + "' exited during boot — prompt was not delivered",
				"bytesWritten": 0, "deliveredAt": time.Now().UnixMilli(), "bootPhase": true, "cleared": false,
				"deliveryReason": "exit", "readiness": readiness,
			}
		}
	}
	if effectiveClear {
		ceiling, quiet, detect := clearReadinessWindows(family)
		if !detect {
			if err := writeSlashLocked(t, "/clear"); err != nil {
				return map[string]any{"success": false, "cleared": false, "error": err.Error()}
			}
			settle := defaultClearSettle
			if delayMs > 0 {
				settle = time.Duration(delayMs) * time.Millisecond
			}
			sleep(settle)
			cleared = true
			readiness = map[string]any{"reason": "fallback", "elapsedMs": time.Since(start).Milliseconds()}
		} else {
			var pred func(string) bool
			if family == "devin" {
				pred = devinReady
			}
			reason, elapsed, err := f.waitReadiness(t, ceiling, quiet, false, pred, func() error {
				return writeSlashLocked(t, "/clear")
			})
			if err != nil {
				return map[string]any{"success": false, "cleared": false, "error": err.Error()}
			}
			if reason == "exit" {
				return map[string]any{"success": false, "cleared": false, "error": "terminal exited during clear", "readiness": map[string]any{"reason": reason, "elapsedMs": elapsed}}
			}
			cleared = true
			readiness = map[string]any{"reason": reason, "elapsedMs": elapsed}
			if delayMs > 0 {
				floor := time.Duration(delayMs) * time.Millisecond
				if waited := time.Since(start); waited < floor {
					sleep(floor - waited)
				}
			}
		}
	}
	if text != "" {
		floor := familyFloor(family)
		if elapsed := time.Since(start); elapsed < floor {
			sleep(floor - elapsed)
		}
	}
	t.mu.Lock()
	if _, err := t.file.WriteString(bracketedPasteOpen); err != nil {
		t.mu.Unlock()
		return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
	}
	for i := 0; i < len(text); i += chunkSize {
		end := i + chunkSize
		if end > len(text) {
			end = len(text)
		}
		if _, err := t.file.WriteString(text[i:end]); err != nil {
			t.mu.Unlock()
			return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
		}
		if end < len(text) {
			t.mu.Unlock()
			sleep(chunkDelay)
			t.mu.Lock()
		}
	}
	if _, err := t.file.WriteString(bracketedPasteClose); err != nil {
		t.mu.Unlock()
		return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
	}
	t.mu.Unlock()
	f.logPrompt(name, text)
	sleep(submitSettle)
	t.mu.Lock()
	if _, err := t.file.WriteString("\r"); err != nil {
		t.mu.Unlock()
		return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
	}
	t.mu.Unlock()
	sleep(confirmEnterDelay)
	t.mu.Lock()
	if _, err := t.file.WriteString("\r"); err != nil {
		t.mu.Unlock()
		return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
	}
	t.mu.Unlock()
	t.promptCount++
	deliveredAt := time.Now().UnixMilli()
	out := map[string]any{
		"success": true, "bytesWritten": len(text), "deliveredAt": deliveredAt,
		"promptSeq": t.promptCount, "bootPhase": bootPhase, "cleared": cleared,
	}
	if len(readiness) > 0 {
		out["deliveryReason"] = readiness["reason"]
		out["readiness"] = readiness
	}
	return out
}

func familyFloor(family string) time.Duration {
	switch family {
	case "claude", "antigravity":
		return 3 * time.Second
	case "devin":
		return 15 * time.Second
	default:
		// Bare shells and unknown CLIs have no composer to wait for.
		return 0
	}
}
