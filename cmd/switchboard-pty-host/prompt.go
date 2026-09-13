package main

import (
	"fmt"
	"strings"
	"time"
)

const (
	chunkSize           = 256
	chunkDelay          = 8 * time.Millisecond
	submitSettle        = 40 * time.Millisecond
	confirmEnterDelay   = 200 * time.Millisecond
	clearInputSettle    = 30 * time.Millisecond
	defaultClearSettle  = 600 * time.Millisecond
	clearInputLine      = "\x15"
	bracketedPasteOpen  = "\x1b[200~"
	bracketedPasteClose = "\x1b[201~"
)

func sleep(d time.Duration) { time.Sleep(d) }

func writeSlashLocked(t *terminal, command string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := writeToPty(t, clearInputLine); err != nil {
		return err
	}
	sleep(clearInputSettle)
	if err := writeToPty(t, strings.TrimRight(command, "\r\n")); err != nil {
		return err
	}
	sleep(submitSettle)
	return writeToPty(t, "\r")
}

// Whether a payload the caller ALREADY declared to be a slash command is
// well-formed enough to get the Ctrl+U / settle / CR treatment.
//
// This is a validity check, never a discovery one. It is called only after a
// caller has set `slashCommand: true` on the ptyWrite payload. `fleet.write`
// used to call it on EVERY write to decide for itself what the bytes meant,
// and the same door carries the operator's keystrokes from the browser: a
// single "/" keypress passed this test, so typing a slash sent Ctrl+U (killing
// the half-typed line) followed by "/" and a CR (submitting the bare slash).
// Every CLI, every pane, and invisible to the gates — a keystroke and a
// command are byte-identical, so no test could tell them apart. Intent is
// declared by the caller now. Do not reintroduce a content test on this path.
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

// clearReadinessWindows is the POST-CLEAR readiness policy. It is the live one:
// delivery runs here, in the pty host, not in src/standalone/ptyPromptDelivery.ts
// (whose sendPromptToPty has no production caller). A timing fix applied only to
// the TypeScript copy reaches no seat.
//
// Devin's quiet window was 100ms while claude and antigravity were raised to
// 300ms, and 100ms is the wrong shape for devin regardless: devin emits ~12
// content-free redraw frames per second — a frame every ~82ms — so a window near
// that interval fires in an ordinary gap between two redraws and calls a
// repainting editor ready. 1500ms is ~18 frames of margin, which means the quiet
// branch effectively does not fire on a live seat and the ceiling becomes the
// real timer: a predictable wait instead of a race against the paint loop.
//
// Erring long is deliberate. Resolving early pastes into an editor that has not
// finished repainting; the prompt is lost, the receipt still says success, and
// the lead blocks on a callback that never comes — ~55 minutes on
// Coding-coder-1, 2026-09-12. Resolving late costs seconds.
func clearReadinessWindows(family string) (ceiling, quiet time.Duration, detect bool) {
	switch family {
	case "claude", "antigravity":
		return 3 * time.Second, 300 * time.Millisecond, true
	case "devin":
		return 15 * time.Second, 1500 * time.Millisecond, true
	default:
		return 15 * time.Second, 0, false
	}
}

// clearStrategy is the DECLARED per-family context-reset mechanism, never
// inferred from observed behaviour. "in-process" keeps the /clear input-box
// path (cheap and correct for CLIs that empty an input buffer). "respawn"
// kills the CLI in the pty and starts a fresh login shell, then re-injects the
// seat's startup command — used where /clear is already a session restart
// (Devin), so driving it through the composer pays the full delivery
// machinery to reach a process that is about to be replaced anyway.
//
// Defaults to "in-process": an unrecognised family keeps today's behaviour
// rather than being respawned on a guessed argv shape.
func clearStrategy(family string) string {
	switch family {
	case "devin":
		return "respawn"
	default:
		return "in-process"
	}
}

// respawnArgvSuffix is the DECLARED per-family argv template — where the
// prompt goes relative to the startup command. Applied by the Go host when
// it re-injects the startup command after a respawn. The shapes differ in a
// way that fails silently if guessed: claude takes a positional prompt,
// devin takes a prompt only after `--` (a bare string before `--` is read as
// a PATH, so a mis-shaped call does not error; it treats the prompt as a
// directory).
//
// The prompt is shell-quoted so a prompt containing metacharacters is passed
// as a single argument, not interpreted by the shell.
func respawnArgvSuffix(family, prompt string) string {
	if prompt == "" {
		return ""
	}
	quoted := shellQuote(prompt)
	switch family {
	case "claude":
		return " " + quoted
	case "devin":
		return " -- " + quoted
	default:
		return " -- " + quoted
	}
}

// shellQuote wraps a string in single quotes for safe shell consumption,
// escaping embedded single quotes as '\” (the standard POSIX-safe idiom).
// A multi-line prompt inside single quotes is literal to the shell — the
// newlines are part of the argument, not command separators — so a composed
// prompt (seat block + standing orders + task) survives as one argv entry.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
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

func (f *fleet) deliverPrompt(name, text string, clearBefore bool, delayMs int, family string, attended bool) map[string]any {
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
		// Respawn families: replace the CLI with a fresh login shell and
		// re-inject the startup command with the prompt in the family's argv
		// shape. The prompt is delivered AS the argv argument, so the
		// bracketed-paste path below is skipped entirely — no text is typed
		// into a composer, no completion menu opens, no blind CR is sent, and
		// the declared --model is re-applied because the startup command is
		// re-read. See
		// a-seats-clear-strategy-is-declared-per-cli-family-not-assumed.md.
		if clearStrategy(family) == "respawn" {
			t.mu.Lock()
			res := f.respawnAndReinject(t, family, text)
			t.mu.Unlock()
			if res["success"] == false {
				return res
			}
			cleared = true
			readiness = map[string]any{"reason": "respawn", "elapsedMs": time.Since(start).Milliseconds()}
			deliveredAt := time.Now().UnixMilli()
			out := map[string]any{
				"success": true, "bytesWritten": len(text), "deliveredAt": deliveredAt,
				"promptSeq": t.promptCount, "bootPhase": bootPhase, "cleared": cleared,
				"respawned": true, "pid": res["pid"],
			}
			out["deliveryReason"] = readiness["reason"]
			out["readiness"] = readiness
			f.logPrompt(name, text)
			return out
		}
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
	// The floor exists for ONE case: a send that follows a clear. `/clear`
	// restarts the CLI's session, so the seat is booting and a paste that lands
	// before it is ready is swallowed. That is what familyFloor measures —
	// devin's 15s is boot time, not think time.
	//
	// A send to a seat that was NOT just cleared has nothing to wait for. The
	// CLI is already up with a live composer, so the floor was pure latency:
	// every prompt to an idle seat sat out 5-15s for a boot that had happened
	// long ago, and a four-seat round paid it four times.
	//
	// This was previously applied to EVERY send, gated on attendance rather than
	// on whether a clear had run — so the sleep was decided by who sent the
	// prompt instead of by whether the receiver was restarting. Those are
	// unrelated: the seat boots for the same 15s whoever is typing at it.
	if text != "" && cleared {
		floor := deliveryFloor(family, attended)
		if elapsed := time.Since(start); elapsed < floor {
			sleep(floor - elapsed)
		}
	}
	t.mu.Lock()
	if err := writeToPty(t, bracketedPasteOpen); err != nil {
		t.mu.Unlock()
		return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
	}
	for i := 0; i < len(text); i += chunkSize {
		end := i + chunkSize
		if end > len(text) {
			end = len(text)
		}
		if err := writeToPty(t, text[i:end]); err != nil {
			t.mu.Unlock()
			return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
		}
		if end < len(text) {
			t.mu.Unlock()
			sleep(chunkDelay)
			t.mu.Lock()
		}
	}
	if err := writeToPty(t, bracketedPasteClose); err != nil {
		t.mu.Unlock()
		return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
	}
	t.mu.Unlock()
	f.logPrompt(name, text)
	sleep(submitSettle)
	t.mu.Lock()
	if err := writeToPty(t, "\r"); err != nil {
		t.mu.Unlock()
		return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
	}
	t.mu.Unlock()
	sleep(confirmEnterDelay)
	t.mu.Lock()
	if err := writeToPty(t, "\r"); err != nil {
		t.mu.Unlock()
		return map[string]any{"success": false, "cleared": cleared, "error": err.Error()}
	}
	t.mu.Unlock()
	// Change 4: verify the delivery reached the seat's own window — one
	// display-message query, no polling. A control-mode seat's pty is a tmux
	// client; tmux forwards input to the view session's CURRENT window. If that
	// is not the seat's own window (captured at spawn from the pane id), the
	// prompt was delivered to a previous generation's agent and this send must
	// NOT report success. This is the check whose absence let bytesWritten stand
	// in for evidence it never had. The seat's own window id is captured at spawn
	// (onPaneIDLearned); if that goroutine has not landed yet it is resolved here
	// from the pane id. A failure to query (no tmux, no view, no pane id) is NOT
	// a misroute — it is "cannot verify", and the send proceeds: the chain's own
	// select-window (Change 2) is the correctness mechanism, this is the
	// backstop that catches it drifting.
	//
	// NOT gated on controlMode. A non-control seat's pty is a `tmux attach`
	// client exactly as a control-mode seat's is, so it has the identical
	// hazard — and with control mode off the pane id is never learned, so the
	// old `controlMode &&` guard disabled this check precisely where nothing
	// else could catch it. Observed 2026-09-13: `lc-coding-team-coder-1`'s view
	// had `Coding-coder-2` current, so coder-1's prompts were typed into
	// coder-2's agent and every send reported success.
	//
	// ensureTmuxRouting repairs first and re-queries, so a drifted view is
	// corrected rather than left to fail every send forever; the refusal below
	// fires only when the correction did not take.
	t.mu.Lock()
	view := t.tmuxViewSession
	t.mu.Unlock()
	if view != "" {
		if own, ok := ensureTmuxRouting(t); !ok {
			return map[string]any{
				"success":      false,
				"error":        fmt.Sprintf("prompt misrouted: view %s could not be pointed at seat own window %s", view, own),
				"bytesWritten": len(text), "deliveredAt": time.Now().UnixMilli(),
				"bootPhase": bootPhase, "cleared": cleared, "misrouted": true,
			}
		}
	}
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

// Floor caps by attendance. attended is true only when a person made this send
// and is watching the terminal (a UI button, a drag-to-terminal drop). The
// caller declares it; anything that is not an explicit true takes the longer
// unattended cap, so a call site that forgets costs seconds and is visible
// rather than silently shortening automated delivery.
const (
	attendedFloorCap   = 5 * time.Second
	unattendedFloorCap = 10 * time.Second
)

// familyFloor is the minimum elapsed time from the start of delivery to the
// first paste byte, before any attendance cap is applied.
//
// The default arm used to be 0. An unrecognised CLI is the seat to be most
// careful with, not the least — guessing short breaks delivery and guessing
// long costs seconds — so it takes the devin floor, matching the patient
// default the TypeScript copy already used.
func familyFloor(family string) time.Duration {
	switch family {
	case "claude", "antigravity":
		return 3 * time.Second
	case "devin":
		return 15 * time.Second
	default:
		return 15 * time.Second
	}
}

// deliveryFloor is familyFloor, capped ONLY when a person is watching.
//
// An automated send is never capped. The cap only ever shortens, and the
// comment it replaces admitted it does nothing else: "claude and antigravity
// sit below both caps and are unchanged in either mode." Its entire effect was
// to cut devin's measured 15s down to 10s for an agent-to-agent send and 5s for
// a composer send — so the one family that needs a long floor was the only one
// that never got it.
//
// What that costs is not seconds. A paste that lands before the seat is ready is
// swallowed by a busy composer, and the receipt still reports success because it
// is assembled from bytesWritten. The sender records a delivered prompt, ends its
// turn, and waits on a reply that can never come. Measured twice on this team:
// ~55 minutes on Coding-coder-1 (2026-09-12) and a full stall on Coding-intern
// (2026-09-13, promptSeq 4 — success:true, bytesWritten:1023, never processed).
//
// An attended send keeps its cap: a person is watching, will see nothing happen,
// and can send again. Nobody is watching an automated one, which is exactly why
// it must be allowed to wait as long as the family actually needs.
//
// This remains a blind timer and is not the real fix — readiness should be
// observed, not slept through (see the plan on the blind five-second floor).
// Waiting the full declared floor is the honest version of the wrong mechanism.
func deliveryFloor(family string, attended bool) time.Duration {
	floor := familyFloor(family)
	if !attended {
		return floor
	}
	if floor < attendedFloorCap {
		return floor
	}
	return attendedFloorCap
}
