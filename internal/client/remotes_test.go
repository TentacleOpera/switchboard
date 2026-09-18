package client

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// captureRun runs fn while capturing os.Stdout/os.Stderr — emitHuman and
// emitErr write to the package-level handles, so swapping them is how the
// remote subcommand's output is observed in tests.
func captureRun(t *testing.T, fn func() int) (int, string, string) {
	t.Helper()
	ro, wo, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	re, we, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	oldOut, oldErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = wo, we
	code := fn()
	wo.Close()
	we.Close()
	os.Stdout, os.Stderr = oldOut, oldErr
	outB, _ := io.ReadAll(ro)
	errB, _ := io.ReadAll(re)
	return code, string(outB), string(errB)
}

func remotesOpts(path string) Options {
	return Options{RemotesFile: path, Env: map[string]string{}}
}

func TestWriteReadRemotesConfig_RoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "remotes.json")
	cfg := &RemotesConfig{
		DefaultRemote: "labcom",
		Remotes: map[string]StoredRemote{
			"labcom": {URL: "http://labcom:7777", WorkspaceRoot: "/srv/board", Roots: []string{"/srv/board"}, LastContact: "2026-09-18T00:00:00Z"},
		},
	}
	if err := writeRemotesConfig(p, cfg); err != nil {
		t.Fatalf("writeRemotesConfig: %v", err)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Errorf("remotes.json mode = %o, want 0600", st.Mode().Perm())
		}
	}
	got, err := loadRemotesConfig(p)
	if err != nil {
		t.Fatalf("loadRemotesConfig: %v", err)
	}
	if got.DefaultRemote != "labcom" {
		t.Errorf("DefaultRemote = %q, want labcom", got.DefaultRemote)
	}
	e := got.Remotes["labcom"]
	if e.URL != "http://labcom:7777" || e.WorkspaceRoot != "/srv/board" || len(e.Roots) != 1 || e.LastContact == "" {
		t.Errorf("round-trip entry mismatch: %+v", e)
	}
}

func TestLoadRemotesConfig_Corrupt(t *testing.T) {
	p := filepath.Join(t.TempDir(), "remotes.json")
	if err := os.WriteFile(p, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := loadRemotesConfig(p)
	if err == nil || !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("corrupt file must surface as corrupt, got %v", err)
	}
}

func TestRunRemote_ListEmpty(t *testing.T) {
	p := filepath.Join(t.TempDir(), "remotes.json")
	code, out, _ := captureRun(t, func() int {
		return RunRemote([]string{"list"}, remotesOpts(p))
	})
	if code != 0 {
		t.Fatalf("remote list exit = %d", code)
	}
	if !strings.Contains(out, "switchboard remote add <name> <url>") {
		t.Errorf("empty-state line must name the add command, got: %q", out)
	}
}

func TestRunRemote_RemoveClearsDefault(t *testing.T) {
	p := filepath.Join(t.TempDir(), "remotes.json")
	cfg := &RemotesConfig{
		DefaultRemote: "labcom",
		Remotes:       map[string]StoredRemote{"labcom": {URL: "http://labcom:7777"}},
	}
	if err := writeRemotesConfig(p, cfg); err != nil {
		t.Fatal(err)
	}
	code, out, _ := captureRun(t, func() int {
		return RunRemote([]string{"remove", "labcom"}, remotesOpts(p))
	})
	if code != 0 {
		t.Fatalf("remove exit = %d", code)
	}
	if !strings.Contains(out, "default is cleared") {
		t.Errorf("remove of the default must say the default is cleared, got: %q", out)
	}
	got, err := loadRemotesConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	if got.DefaultRemote != "" || len(got.Remotes) != 0 {
		t.Errorf("dangling state after remove: %+v", got)
	}
}

func TestRunRemote_RemoveUnknown(t *testing.T) {
	p := filepath.Join(t.TempDir(), "remotes.json")
	if err := writeRemotesConfig(p, &RemotesConfig{Remotes: map[string]StoredRemote{"a": {URL: "http://a:1"}}}); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := captureRun(t, func() int {
		return RunRemote([]string{"remove", "ghost"}, remotesOpts(p))
	})
	if code != 1 {
		t.Fatalf("remove unknown exit = %d, want 1", code)
	}
	if !strings.Contains(stderr, "configured remotes: a") {
		t.Errorf("unknown-name error must name configured remotes, got: %q", stderr)
	}
}

func TestRunRemote_DefaultSetAndClear(t *testing.T) {
	p := filepath.Join(t.TempDir(), "remotes.json")
	if err := writeRemotesConfig(p, &RemotesConfig{Remotes: map[string]StoredRemote{"labcom": {URL: "http://labcom:7777"}}}); err != nil {
		t.Fatal(err)
	}
	code, out, _ := captureRun(t, func() int {
		return RunRemote([]string{"default", "labcom"}, remotesOpts(p))
	})
	if code != 0 || !strings.Contains(out, "config:remotes.labcom") {
		t.Fatalf("default set: code=%d out=%q", code, out)
	}
	got, _ := loadRemotesConfig(p)
	if got.DefaultRemote != "labcom" {
		t.Fatalf("DefaultRemote = %q", got.DefaultRemote)
	}
	code, out, _ = captureRun(t, func() int {
		return RunRemote([]string{"default", "--clear"}, remotesOpts(p))
	})
	if code != 0 || !strings.Contains(out, "default remote cleared") {
		t.Fatalf("default clear: code=%d out=%q", code, out)
	}
	got, _ = loadRemotesConfig(p)
	if got.DefaultRemote != "" {
		t.Fatalf("DefaultRemote still set: %q", got.DefaultRemote)
	}
}

func TestRunRemote_DefaultUnknown(t *testing.T) {
	p := filepath.Join(t.TempDir(), "remotes.json")
	code, _, stderr := captureRun(t, func() int {
		return RunRemote([]string{"default", "ghost"}, remotesOpts(p))
	})
	if code != 1 || !strings.Contains(stderr, "switchboard remote add ghost <url>") {
		t.Fatalf("default unknown must name the add remedy: code=%d err=%q", code, stderr)
	}
}

// boardStub serves /health and /kanban/plans like a real board.
func boardStub(t *testing.T, roots []string, plansStatus int) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"service":"switchboard","status":"ok","port":7777,"roots":` + mustJSON(t, roots) + `}`))
	})
	mux.HandleFunc("/kanban/plans", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("workspaceRoot") == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.WriteHeader(plansStatus)
		w.Write([]byte(`{"success":true,"data":[]}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := jsonMarshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestRunRemote_AddStoresUsableRemote(t *testing.T) {
	srv := boardStub(t, []string{"/srv/board"}, http.StatusOK)
	p := filepath.Join(t.TempDir(), "remotes.json")
	code, out, _ := captureRun(t, func() int {
		return RunRemote([]string{"add", "labcom", srv.URL}, remotesOpts(p))
	})
	if code != 0 {
		t.Fatalf("add exit = %d", code)
	}
	if !strings.Contains(out, "remote 'labcom' added") {
		t.Errorf("add output missing the confirmation line: %q", out)
	}
	got, err := loadRemotesConfig(p)
	if err != nil {
		t.Fatal(err)
	}
	e, ok := got.Remotes["labcom"]
	if !ok {
		t.Fatal("remote was not stored")
	}
	if e.URL != srv.URL || e.WorkspaceRoot != "/srv/board" || len(e.Roots) != 1 || e.LastContact == "" {
		t.Errorf("stored entry mismatch: %+v", e)
	}
}

func TestRunRemote_AddRefuses401WithoutStoring(t *testing.T) {
	srv := boardStub(t, []string{"/srv/board"}, http.StatusUnauthorized)
	p := filepath.Join(t.TempDir(), "remotes.json")
	code, _, stderr := captureRun(t, func() int {
		return RunRemote([]string{"add", "labcom", srv.URL}, remotesOpts(p))
	})
	if code != 1 {
		t.Fatalf("401 board must refuse: exit = %d", code)
	}
	for _, frag := range []string{"401", "SWITCHBOARD_API_TOKEN", "--token-file", "switchboard token clear"} {
		if !strings.Contains(stderr, frag) {
			t.Errorf("401 refusal must name the remedy (%s missing): %q", frag, stderr)
		}
	}
	if _, err := os.Stat(p); err == nil {
		t.Error("a 401 board must never be stored — remotes.json exists")
	}
}

func TestRunRemote_AddRefusesExistingName(t *testing.T) {
	srv := boardStub(t, []string{"/srv/board"}, http.StatusOK)
	p := filepath.Join(t.TempDir(), "remotes.json")
	if err := writeRemotesConfig(p, &RemotesConfig{Remotes: map[string]StoredRemote{"labcom": {URL: "http://old:7777"}}}); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := captureRun(t, func() int {
		return RunRemote([]string{"add", "labcom", srv.URL}, remotesOpts(p))
	})
	if code != 1 || !strings.Contains(stderr, "http://old:7777") || !strings.Contains(stderr, "--force") {
		t.Fatalf("existing-name refusal must name the stored target and the overwrite path: code=%d err=%q", code, stderr)
	}
	got, _ := loadRemotesConfig(p)
	if got.Remotes["labcom"].URL != "http://old:7777" {
		t.Error("a refused add must not rebind the name")
	}
}

func TestRunRemote_AddMultiRootRefusesListing(t *testing.T) {
	srv := boardStub(t, []string{"/a", "/b"}, http.StatusOK)
	p := filepath.Join(t.TempDir(), "remotes.json")
	code, _, stderr := captureRun(t, func() int {
		return RunRemote([]string{"add", "labcom", srv.URL}, remotesOpts(p))
	})
	if code != 1 {
		t.Fatalf("multi-root board without --workspace-root must refuse: exit = %d", code)
	}
	if !strings.Contains(stderr, "/a") || !strings.Contains(stderr, "/b") || !strings.Contains(stderr, "--workspace-root") {
		t.Errorf("multi-root refusal must list roots and name the flag: %q", stderr)
	}
	// With the flag, the add proceeds.
	opts := remotesOpts(p)
	opts.WorkspaceRoot = "/b"
	code, _, _ = captureRun(t, func() int {
		return RunRemote([]string{"add", "labcom", srv.URL}, opts)
	})
	if code != 0 {
		t.Fatalf("add with --workspace-root should succeed: exit = %d", code)
	}
}

func TestDescribeTargetVia(t *testing.T) {
	cases := []struct {
		name string
		opts Options
		ep   Resolved[Endpoint]
		want string
	}{
		{"flag remote", Options{Remote: "labcom"}, Resolved[Endpoint]{}, "flag:--remote labcom"},
		{"env remote", Options{Env: map[string]string{"SWITCHBOARD_REMOTE": "labcom"}}, Resolved[Endpoint]{}, "env:SWITCHBOARD_REMOTE"},
		{"flag server", Options{ServerURL: "http://x:7777"}, Resolved[Endpoint]{}, "flag:--server"},
		{"env server", Options{Env: map[string]string{"SWITCHBOARD_SERVER_URL": "http://x:7777"}}, Resolved[Endpoint]{}, "env:SWITCHBOARD_SERVER_URL"},
		{"config default", Options{}, Resolved[Endpoint]{Value: Endpoint{RemoteName: "labcom"}, Source: SourceConfig}, "config:remotes.labcom"},
	}
	for _, c := range cases {
		if got := DescribeTargetVia(c.opts, c.ep); got != c.want {
			t.Errorf("%s: DescribeTargetVia = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestTargetSourceLine(t *testing.T) {
	opts := Options{}
	ep := Resolved[Endpoint]{Value: Endpoint{BaseURL: "https://labcom.ts.net", RemoteName: "labcom"}, Source: SourceConfig}
	got := TargetSourceLine(opts, ep, "/home/patrick/labcom")
	want := "[switchboard] labcom · https://labcom.ts.net · /home/patrick/labcom · via config:remotes.labcom"
	if got != want {
		t.Errorf("named line = %q, want %q", got, want)
	}
	ep2 := Resolved[Endpoint]{Value: Endpoint{BaseURL: "http://labcom:7777"}, Source: SourceExplicitFlag}
	opts2 := Options{ServerURL: "http://labcom:7777"}
	got2 := TargetSourceLine(opts2, ep2, "/r")
	want2 := "[switchboard] http://labcom:7777 · /r · via flag:--server"
	if got2 != want2 {
		t.Errorf("unnamed line = %q, want %q", got2, want2)
	}
}

func TestWithTargetJSON(t *testing.T) {
	defer func() { activeJSONTarget = nil }()
	activeJSONTarget = &TargetInfo{BaseURL: "http://x:7777", WorkspaceRoot: "/r", Source: "config:remotes.labcom"}
	out := withTargetJSON([]byte("{\n  \"success\": true\n}\n"))
	s := string(out)
	if !strings.Contains(s, `"target"`) {
		t.Fatalf("target key not injected: %q", s)
	}
	if idx := strings.LastIndex(s, "}"); !strings.HasSuffix(strings.TrimSpace(s[:idx]), "}") && strings.LastIndex(s, `"target"`) < strings.LastIndex(s, `"success"`) {
		t.Errorf("target must be the last key: %q", s)
	}
	var parsed map[string]any
	if err := jsonUnmarshal(out, &parsed); err != nil {
		t.Fatalf("injected payload is not valid JSON: %v\n%s", err, s)
	}
	ti, ok := parsed["target"].(map[string]any)
	if !ok || ti["baseUrl"] != "http://x:7777" || ti["workspaceRoot"] != "/r" || ti["source"] != "config:remotes.labcom" {
		t.Errorf("target payload mismatch: %v", parsed["target"])
	}
	// Local invocation: no injection.
	activeJSONTarget = nil
	out2 := withTargetJSON([]byte("{\n  \"success\": true\n}\n"))
	if strings.Contains(string(out2), "target") {
		t.Errorf("a local invocation must gain no target key: %q", out2)
	}
}
