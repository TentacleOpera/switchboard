package client

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// timeNowUTC mirrors Node's new Date().toISOString(): RFC3339 with milliseconds.
func timeNowUTC() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// timeSleep is the default sleep used by probe; swapped in tests.
var timeSleep = func(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }

// readProcRss reads VmRSS from /proc/<pid>/status (Linux only). Returns 0 on
// any error or non-Linux platform.
func readProcRss(pid int) int64 {
	if pid <= 0 {
		return 0
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0
	}
	re := regexp.MustCompile(`(?m)^VmRSS:\s+(\d+)\s+kB`)
	m := re.FindSubmatch(b)
	if len(m) < 2 {
		return 0
	}
	kb, err := strconv.ParseInt(string(m[1]), 10, 64)
	if err != nil {
		return 0
	}
	return kb * 1024
}

// readInotifyWatchCount mirrors src/standalone/planIngestionHost.ts
// getInotifyWatchCount: counts inotify watches by scanning /proc/<pid>/fd for
// anon_inode:inotify links and summing the inotify lines in fdinfo. Returns 0
// off Linux or on any error.
func readInotifyWatchCount(pid int) int {
	if pid <= 0 {
		return 0
	}
	fdDir := fmt.Sprintf("/proc/%d/fd", pid)
	entries, err := os.ReadDir(fdDir)
	if err != nil {
		return 0
	}
	count := 0
	for _, e := range entries {
		link, err := os.Readlink(filepath.Join(fdDir, e.Name()))
		if err != nil {
			continue
		}
		if link != "anon_inode:inotify" {
			continue
		}
		info, err := os.ReadFile(fmt.Sprintf("/proc/%d/fdinfo/%s", pid, e.Name()))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(info), "\n") {
			if strings.HasPrefix(line, "inotify ") {
				count++
			}
		}
	}
	return count
}

// readOpenFdCount mirrors getOpenFdCount: the number of entries in
// /proc/<pid>/fd. Returns 0 off Linux or on any error.
func readOpenFdCount(pid int) int {
	if pid <= 0 {
		return 0
	}
	entries, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
	if err != nil {
		return 0
	}
	return len(entries)
}

// writeCsv writes the probe samples to a CSV file, appending without a header
// when the existing file already starts with the header (matching cli.ts).
func writeCsv(path, header string, rows []any) {
	var lines []string
	lines = append(lines, header)
	for _, r := range rows {
		lines = append(lines, csvRow(r))
	}
	content := strings.Join(lines, "\n") + "\n"
	if existing, err := os.ReadFile(path); err == nil && strings.HasPrefix(string(existing), header) {
		// Append without re-writing the header.
		appendLines := make([]string, 0, len(rows))
		for _, r := range rows {
			appendLines = append(appendLines, csvRow(r))
		}
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			defer f.Close()
			f.WriteString(strings.Join(appendLines, "\n") + "\n")
			return
		}
	}
	dir := filepath.Dir(path)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		_ = os.MkdirAll(dir, 0o755)
	}
	_ = os.WriteFile(path, []byte(content), 0o644)
}

// csvRow renders a probe sample as a CSV row.
func csvRow(r any) string {
	b, err := jsonMarshal(r)
	if err != nil {
		return ""
	}
	var s probeSample
	_ = jsonUnmarshal(b, &s)
	return fmt.Sprintf("%s,%d,%d,%d,%d,%d,%d,%d,%d", s.Timestamp, s.PID, s.RSS, s.HeapUsed, s.HeapTotal, s.External, s.ArrayBuffers, s.Inotify, s.OpenFds)
}

// followLogs polls a log file for new content, handling rotation by restarting
// from 0 when the file shrinks. Terminates on SIGINT/SIGTERM.
func followLogs(logFile string, startSize int64) {
	size := startSize
	stop := make(chan struct{})
	go func() {
		// Block until signal; the caller's os.Exit handles cleanup.
		ch := make(chan os.Signal, 1)
		signalNotify(ch)
		<-ch
		close(stop)
		os.Exit(0)
	}()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			st, err := os.Stat(logFile)
			if err != nil {
				continue
			}
			if st.Size() < size {
				size = 0
			}
			if st.Size() > size {
				f, err := os.Open(logFile)
				if err != nil {
					continue
				}
				if _, err := f.Seek(size, 0); err == nil {
					r := bufio.NewReader(f)
					buf := make([]byte, 0, 4096)
					tmp := make([]byte, 4096)
					for {
						n, err := r.Read(tmp)
						if n > 0 {
							buf = append(buf, tmp[:n]...)
						}
						if err != nil {
							break
						}
					}
					if len(buf) > 0 {
						os.Stdout.Write(buf)
					}
				}
				f.Close()
				size = st.Size()
			}
		}
	}
}
