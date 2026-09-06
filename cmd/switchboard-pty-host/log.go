package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	logFenceOpen  = "```console"
	logFenceClose = "```"
	logCapBytes   = 10 * 1024 * 1024
)

var ansiRE = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x1b]*(?:\x1b\\|\x9c)|\x1b[()*+].|\x1b[@-Z\\-_]|\x9b[ -/]*[@-~]|\x9c`)

type sessionLog struct {
	path     string
	open     bool
	size     int
	session  string
}

func stripAnsi(text string) string { return ansiRE.ReplaceAllString(text, "") }

func sanitizeFence(text string) string {
	var b strings.Builder
	run := 0
	for _, r := range text {
		if r == '`' {
			run++
			if run == 3 {
				b.WriteString("`\u200b`\u200b`")
				run = 0
			}
			continue
		}
		if run > 0 {
			b.WriteString(strings.Repeat("`", run))
			run = 0
		}
		b.WriteRune(r)
	}
	if run > 0 {
		b.WriteString(strings.Repeat("`", run))
	}
	return b.String()
}

func (f *fleet) getLog(name string) *sessionLog {
	if f.logState == nil {
		f.logState = map[string]*sessionLog{}
	}
	if existing := f.logState[name]; existing != nil {
		return existing
	}
	_ = os.MkdirAll(f.logDir, 0o700)
	session := time.Now().UTC().Format("20060102T150405.000000000Z")
	path := filepath.Join(f.logDir, filepath.Base(name)+"-"+session+".md")
	state := &sessionLog{path: path, session: session}
	f.logState[name] = state
	header := "# Terminal log: " + name + "\n\n"
	_ = os.WriteFile(path, []byte(header), 0o600)
	state.size = len(header)
	return state
}

func (f *fleet) appendLog(name, text string, asFence bool) {
	f.logMu.Lock()
	defer f.logMu.Unlock()
	if f.logDir == "" {
		return
	}
	state := f.getLog(name)
	if asFence && !state.open {
		text = logFenceOpen + "\n" + text
		state.open = true
	}
	if err := appendFile(state.path, text); err == nil {
		state.size += len(text)
	}
	if state.size > logCapBytes {
		f.rollLogLocked(name, state)
	}
}

func appendFile(path, text string) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(text)
	return err
}

func (f *fleet) closeFenceLocked(state *sessionLog) {
	if state == nil || !state.open {
		return
	}
	_ = appendFile(state.path, "\n"+logFenceClose+"\n")
	state.open = false
}

func (f *fleet) logPrompt(name, prompt string) {
	f.logMu.Lock()
	defer f.logMu.Unlock()
	state := f.getLog(name)
	f.closeFenceLocked(state)
	first := sanitizeFence(strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(prompt, "\r", " "), "\n", " ")))
	if len(first) > 80 {
		first = first[:80]
	}
	heading := "\n## " + time.Now().UTC().Format(time.RFC3339) + " — " + first + "\n\n"
	_ = appendFile(state.path, heading)
	state.size += len(heading)
}

func (f *fleet) logOutput(name, data string) {
	cleaned := sanitizeFence(stripAnsi(data))
	if cleaned == "" {
		return
	}
	f.appendLog(name, cleaned, true)
}

func (f *fleet) logClose(name string) {
	f.logMu.Lock()
	defer f.logMu.Unlock()
	state := f.logState[name]
	f.closeFenceLocked(state)
	delete(f.logState, name)
}

func (f *fleet) renameLog(oldName, newName string) {
	f.logMu.Lock()
	defer f.logMu.Unlock()
	if state := f.logState[oldName]; state != nil {
		f.logState[newName] = state
		delete(f.logState, oldName)
	}
}

func (f *fleet) rollLog(name string) {
	f.logMu.Lock()
	defer f.logMu.Unlock()
	state := f.logState[name]
	if state == nil {
		return
	}
	f.rollLogLocked(name, state)
}

func (f *fleet) rollLogLocked(name string, state *sessionLog) {
	f.closeFenceLocked(state)
	delete(f.logState, name)
	_ = f.getLog(name)
}
