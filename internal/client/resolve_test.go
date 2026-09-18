package client

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseServerURL_Valid(t *testing.T) {
	cases := []struct {
		raw      string
		wantHost string
		wantPort int
		wantBase string
	}{
		{"http://127.0.0.1:7777", "127.0.0.1", 7777, "http://127.0.0.1:7777"},
		{"http://127.0.0.1:7777/", "127.0.0.1", 7777, "http://127.0.0.1:7777"},
		{"https://board.example.com:8443", "board.example.com", 8443, "https://board.example.com:8443"},
		{"http://192.168.1.50:7777", "192.168.1.50", 7777, "http://192.168.1.50:7777"},
	}
	for _, c := range cases {
		ep, err := parseServerURL(c.raw)
		if err != nil {
			t.Errorf("parseServerURL(%q) unexpected error: %v", c.raw, err)
			continue
		}
		if ep.Host != c.wantHost {
			t.Errorf("parseServerURL(%q) host = %q, want %q", c.raw, ep.Host, c.wantHost)
		}
		if ep.Port != c.wantPort {
			t.Errorf("parseServerURL(%q) port = %d, want %d", c.raw, ep.Port, c.wantPort)
		}
		if ep.BaseURL != c.wantBase {
			t.Errorf("parseServerURL(%q) baseURL = %q, want %q", c.raw, ep.BaseURL, c.wantBase)
		}
	}
}

func TestParseServerURL_Invalid(t *testing.T) {
	cases := []string{
		"",                                // empty
		"not-a-url",                       // no scheme
		"ftp://127.0.0.1:7777",            // unsupported scheme
		"http://user:pass@127.0.0.1:7777", // embedded credentials
		"http://127.0.0.1",                // no port
		"http://127.0.0.1:abc",            // non-numeric port
		"://127.0.0.1:7777",               // no scheme
	}
	for _, raw := range cases {
		_, err := parseServerURL(raw)
		if err == nil {
			t.Errorf("parseServerURL(%q) expected error, got nil", raw)
		}
	}
}

func TestResolveEndpoint_ExplicitFlag(t *testing.T) {
	opts := Options{ServerURL: "http://127.0.0.1:9999"}
	ep, err := ResolveEndpoint(opts, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Source != SourceExplicitFlag {
		t.Errorf("source = %s, want %s", ep.Source, SourceExplicitFlag)
	}
	if ep.Value.Port != 9999 {
		t.Errorf("port = %d, want 9999", ep.Value.Port)
	}
}

func TestResolveEndpoint_EnvVar(t *testing.T) {
	opts := Options{
		Env: map[string]string{"SWITCHBOARD_SERVER_URL": "http://192.168.1.50:7777"},
	}
	ep, err := ResolveEndpoint(opts, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Source != SourceEnv {
		t.Errorf("source = %s, want %s", ep.Source, SourceEnv)
	}
	if ep.Value.Port != 7777 {
		t.Errorf("port = %d, want 7777", ep.Value.Port)
	}
}

func TestResolveEndpoint_NoEndpoint(t *testing.T) {
	opts := Options{
		Env: map[string]string{},
		// Pin the remotes.json tier to an absent file — the real
		// ~/.switchboard/remotes.json could carry a defaultRemote and turn
		// this "nothing resolves" case into a config resolution.
		RemotesFile: filepath.Join(t.TempDir(), "absent.json"),
	}
	_, err := ResolveEndpoint(opts, nil)
	if err == nil {
		t.Fatal("expected error when no endpoint is resolvable, got nil")
	}
}

func TestResolveEndpoint_ExplicitOverridesEnv(t *testing.T) {
	opts := Options{
		ServerURL: "http://127.0.0.1:9999",
		Env:       map[string]string{"SWITCHBOARD_SERVER_URL": "http://192.168.1.50:7777"},
	}
	ep, err := ResolveEndpoint(opts, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Source != SourceExplicitFlag {
		t.Errorf("source = %s, want %s (explicit flag must override env)", ep.Source, SourceExplicitFlag)
	}
	if ep.Value.Port != 9999 {
		t.Errorf("port = %d, want 9999 (explicit flag value)", ep.Value.Port)
	}
}

func TestResolveServerRoot_ExplicitFlag(t *testing.T) {
	opts := Options{WorkspaceRoot: "/srv/board"}
	root, err := ResolveServerRoot(opts, Resolved[Endpoint]{Source: SourceEnv}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if root.Value != "/srv/board" {
		t.Errorf("root = %q, want /srv/board", root.Value)
	}
	if root.Source != SourceExplicitFlag {
		t.Errorf("source = %s, want %s", root.Source, SourceExplicitFlag)
	}
}

func TestResolveServerRoot_EnvVar(t *testing.T) {
	opts := Options{
		Env: map[string]string{"SWITCHBOARD_WORKSPACE_ROOT": "/srv/board"},
	}
	root, err := ResolveServerRoot(opts, Resolved[Endpoint]{Source: SourceEnv}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if root.Value != "/srv/board" {
		t.Errorf("root = %q, want /srv/board", root.Value)
	}
	if root.Source != SourceEnv {
		t.Errorf("source = %s, want %s", root.Source, SourceEnv)
	}
}

func TestResolveServerRoot_RemoteWithoutRootFails(t *testing.T) {
	opts := Options{Env: map[string]string{}}
	ep := Resolved[Endpoint]{Source: SourceEnv} // remote endpoint
	_, err := ResolveServerRoot(opts, ep, nil)
	if err == nil {
		t.Fatal("expected error for remote endpoint without server root, got nil")
	}
}

func TestResolveServerRoot_RemoteWithHealthRootsFailsWithRoots(t *testing.T) {
	opts := Options{Env: map[string]string{}}
	ep := Resolved[Endpoint]{Source: SourceEnv}
	health := &HealthJSON{Roots: []string{"/srv/board-a", "/srv/board-b"}}
	_, err := ResolveServerRoot(opts, ep, health)
	if err == nil {
		t.Fatal("expected error for remote endpoint without explicit root, got nil")
	}
	mre, ok := err.(*MissingRootError)
	if !ok {
		t.Fatalf("expected *MissingRootError, got %T", err)
	}
	if len(mre.Roots) != 2 {
		t.Errorf("roots count = %d, want 2", len(mre.Roots))
	}
}

func TestResolveToken_EnvVar(t *testing.T) {
	opts := Options{Env: map[string]string{"SWITCHBOARD_API_TOKEN": "secret123"}}
	token, err := ResolveToken(opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token.Value != "secret123" {
		t.Errorf("token = %q, want secret123", token.Value)
	}
	if token.Source != SourceEnv {
		t.Errorf("source = %s, want %s", token.Source, SourceEnv)
	}
}

func TestResolveToken_TokenFile(t *testing.T) {
	tmp := t.TempDir()
	tf := filepath.Join(tmp, "token.txt")
	if err := os.WriteFile(tf, []byte("filetoken\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	opts := Options{TokenFile: tf, Env: map[string]string{}}
	token, err := ResolveToken(opts)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token.Value != "filetoken" {
		t.Errorf("token = %q, want filetoken", token.Value)
	}
	if token.Source != SourceExplicitFlag {
		t.Errorf("source = %s, want %s", token.Source, SourceExplicitFlag)
	}
}

// An explicitly requested credential source that fails is an error, never a
// demotion to none — the same no-inter-tier-fallback rule as the endpoint
// chain.
func TestResolveToken_BlankFileIsError(t *testing.T) {
	tmp := t.TempDir()
	tf := filepath.Join(tmp, "blank.txt")
	if err := os.WriteFile(tf, []byte("   \n"), 0o644); err != nil {
		t.Fatal(err)
	}
	opts := Options{TokenFile: tf, Env: map[string]string{}}
	_, err := ResolveToken(opts)
	if err == nil {
		t.Fatal("expected an error for an empty explicit --token-file, got nil")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Errorf("error does not name the empty file: %v", err)
	}
}

func TestResolveToken_MissingFileIsError(t *testing.T) {
	opts := Options{TokenFile: "/nonexistent/path/token.txt", Env: map[string]string{}}
	_, err := ResolveToken(opts)
	if err == nil {
		t.Fatal("expected an error for an unreadable explicit --token-file, got nil")
	}
	if !strings.Contains(err.Error(), "--token-file") {
		t.Errorf("error does not name the flag: %v", err)
	}
}

func TestHasScheme(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/kanban/plans", false},
		{"http://foo", true},
		{"https://foo", true},
		{"ftp://foo", true},
		{"/health", false},
		{"//health", false}, // double-slash, no scheme
		{"a:b", true},       // single-letter scheme
		{"-bad", false},     // starts with non-alpha
		{"", false},
	}
	for _, c := range cases {
		got := HasScheme(c.path)
		if got != c.want {
			t.Errorf("HasScheme(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestIsFullUUID(t *testing.T) {
	cases := []struct {
		s    string
		want bool
	}{
		{"ba8f2b52-2701-4c2d-b98c-00b8f292997d", true},
		{"BA8F2B52-2701-4C2D-B98C-00B8F292997D", true},
		{"ba8f2b52-2701-4c2d-b98c", false},                    // too short
		{"ba8f2b52-2701-4c2d-b98c-00b8f292997d-extra", false}, // too long
		{"xb8f2b52-2701-4c2d-b98c-00b8f292997d", false},       // non-hex
		{"", false},
		{"not-a-uuid", false},
	}
	for _, c := range cases {
		got := IsFullUUID(c.s)
		if got != c.want {
			t.Errorf("IsFullUUID(%q) = %v, want %v", c.s, got, c.want)
		}
	}
}

func TestDispatchExitCode(t *testing.T) {
	cases := []struct {
		status int
		want   int
	}{
		{200, 0},
		{401, 4},
		{409, 3},
		{502, 3},
		{400, 5},
		{404, 5},
		{503, 6},
		{500, 1},
		{999, 1}, // unknown
	}
	for _, c := range cases {
		got := DispatchExitCodeExported(c.status)
		if got != c.want {
			t.Errorf("DispatchExitCode(%d) = %d, want %d", c.status, got, c.want)
		}
	}
}

func TestShortPrefix(t *testing.T) {
	cases := []struct {
		planID string
		want   string
	}{
		{"ba8f2b52-2701-4c2d-b98c-00b8f292997d", "ba8f2b52"},
		{"BA8F2B52-2701-4C2D-B98C-00B8F292997D", "ba8f2b52"},
		{"short", "short"},
		{"", ""},
	}
	for _, c := range cases {
		got := ShortPrefixExported(c.planID)
		if got != c.want {
			t.Errorf("ShortPrefix(%q) = %q, want %q", c.planID, got, c.want)
		}
	}
}

func TestExtractRawPlans(t *testing.T) {
	// Bare array
	body := `[{"planId":"a","topic":"A"},{"planId":"b","topic":"B"}]`
	plans := extractRawPlans(body)
	if len(plans) != 2 {
		t.Fatalf("expected 2 plans, got %d", len(plans))
	}
	if rawFieldString(plans[0], "planId") != "a" {
		t.Errorf("first plan id = %q, want 'a'", rawFieldString(plans[0], "planId"))
	}

	// {data: [...]}
	body2 := `{"data":[{"planId":"c","topic":"C"}]}`
	plans2 := extractRawPlans(body2)
	if len(plans2) != 1 {
		t.Fatalf("expected 1 plan from data wrapper, got %d", len(plans2))
	}
	if rawFieldString(plans2[0], "planId") != "c" {
		t.Errorf("plan id = %q, want 'c'", rawFieldString(plans2[0], "planId"))
	}

	// {plans: [...]}
	body3 := `{"plans":[{"planId":"d","topic":"D"}]}`
	plans3 := extractRawPlans(body3)
	if len(plans3) != 1 {
		t.Fatalf("expected 1 plan from plans wrapper, got %d", len(plans3))
	}

	// Empty/invalid
	if extractRawPlans("") != nil {
		t.Error("expected nil for empty body")
	}
	if extractRawPlans("not json") != nil {
		t.Error("expected nil for invalid JSON")
	}
}

func TestIndentJSON(t *testing.T) {
	input := `{"b":1,"a":2}`
	got := indentJSON(input)
	// Key order must be preserved (b before a), not alphabetically sorted.
	want := `{
  "b": 1,
  "a": 2
}`
	if got != want {
		t.Errorf("indentJSON mismatch:\ngot:  %q\nwant: %q", got, want)
	}
}

func TestIndentJSON_Nested(t *testing.T) {
	input := `{"outer":{"z":1,"a":2},"list":[1,2,3]}`
	got := indentJSON(input)
	want := `{
  "outer": {
    "z": 1,
    "a": 2
  },
  "list": [
    1,
    2,
    3
  ]
}`
	if got != want {
		t.Errorf("indentJSON nested mismatch:\ngot:  %q\nwant: %q", got, want)
	}
}

func TestIndentJSON_EmptyContainers(t *testing.T) {
	input := `{"empty":{},"arr":[],"val":1}`
	got := indentJSON(input)
	want := `{
  "empty": {},
  "arr": [],
  "val": 1
}`
	if got != want {
		t.Errorf("indentJSON empty containers mismatch:\ngot:  %q\nwant: %q", got, want)
	}
}

func TestIndentJSON_StringWithStructuralChars(t *testing.T) {
	// Structural characters inside strings must not trigger indentation.
	input := `{"msg":"hello, {world} [arr]: val"}`
	got := indentJSON(input)
	want := `{
  "msg": "hello, {world} [arr]: val"
}`
	if got != want {
		t.Errorf("indentJSON string-with-chars mismatch:\ngot:  %q\nwant: %q", got, want)
	}
}

// ── Remote-endpoint tiers (plan: the-cli-reaches-a-remote-board-over-the-
// tailnet — "A tagged ApiTarget"). Write-only for now: SKIP TESTS directive
// for this run; the cases pin the precedence contract for when the suite
// runs.

func writeRemotes(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "remotes.json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestResolveEndpoint_RemoteFlagURL(t *testing.T) {
	opts := Options{
		Remote:      "http://labcom.example.net:7777",
		Env:         map[string]string{},
		RemotesFile: filepath.Join(t.TempDir(), "absent.json"),
	}
	ep, err := ResolveEndpoint(opts, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Source != SourceExplicitFlag {
		t.Errorf("source = %s, want %s", ep.Source, SourceExplicitFlag)
	}
	if ep.Value.BaseURL != "http://labcom.example.net:7777" {
		t.Errorf("baseURL = %q", ep.Value.BaseURL)
	}
	if ep.Value.RemoteName != "" {
		t.Errorf("remoteName = %q, want empty for a URL spec", ep.Value.RemoteName)
	}
}

func TestResolveEndpoint_RemoteFlagName(t *testing.T) {
	opts := Options{
		Remote: "labcom",
		Env:    map[string]string{},
		RemotesFile: writeRemotes(t, `{
			"remotes": {"labcom": {"url": "http://labcom.example.net:7777", "workspaceRoot": "/srv/board"}}
		}`),
	}
	ep, err := ResolveEndpoint(opts, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Source != SourceExplicitFlag {
		t.Errorf("source = %s, want %s", ep.Source, SourceExplicitFlag)
	}
	if ep.Value.RemoteName != "labcom" {
		t.Errorf("remoteName = %q, want labcom", ep.Value.RemoteName)
	}
	if ep.Value.StoredRoot != "/srv/board" {
		t.Errorf("storedRoot = %q, want /srv/board", ep.Value.StoredRoot)
	}
}

func TestResolveEndpoint_RemoteFlagNameMissing(t *testing.T) {
	opts := Options{
		Remote:      "ghost",
		Env:         map[string]string{},
		RemotesFile: filepath.Join(t.TempDir(), "absent.json"),
	}
	_, err := ResolveEndpoint(opts, nil)
	if err == nil {
		t.Fatal("expected error for an unconfigured remote name, got nil")
	}
	if !strings.Contains(err.Error(), "ghost") {
		t.Errorf("error does not name the remote: %v", err)
	}
}

func TestResolveEndpoint_RemoteAndServerConflict(t *testing.T) {
	opts := Options{
		Remote:    "http://a.example.net:7777",
		ServerURL: "http://b.example.net:7777",
		Env:       map[string]string{},
	}
	_, err := ResolveEndpoint(opts, nil)
	if err == nil {
		t.Fatal("expected a loud conflict, got nil")
	}
	if !strings.Contains(err.Error(), "conflicting endpoints") {
		t.Errorf("error does not name the conflict: %v", err)
	}
}

func TestResolveEndpoint_RemoteAndServerAgree(t *testing.T) {
	opts := Options{
		Remote:    "http://labcom.example.net:7777",
		ServerURL: "http://labcom.example.net:7777/",
		Env:       map[string]string{},
	}
	ep, err := ResolveEndpoint(opts, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Value.BaseURL != "http://labcom.example.net:7777" {
		t.Errorf("baseURL = %q", ep.Value.BaseURL)
	}
}

func TestResolveEndpoint_EnvRemoteBeatsServerFlag(t *testing.T) {
	opts := Options{
		ServerURL: "http://b.example.net:7777",
		Env:       map[string]string{"SWITCHBOARD_REMOTE": "http://a.example.net:7777"},
	}
	ep, err := ResolveEndpoint(opts, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Source != SourceEnv {
		t.Errorf("source = %s, want %s (SWITCHBOARD_REMOTE outranks --server)", ep.Source, SourceEnv)
	}
	if ep.Value.BaseURL != "http://a.example.net:7777" {
		t.Errorf("baseURL = %q", ep.Value.BaseURL)
	}
}

func TestResolveEndpoint_EnvRemoteVsEnvServerConflict(t *testing.T) {
	opts := Options{
		Env: map[string]string{
			"SWITCHBOARD_REMOTE":     "http://a.example.net:7777",
			"SWITCHBOARD_SERVER_URL": "http://b.example.net:7777",
		},
	}
	_, err := ResolveEndpoint(opts, nil)
	if err == nil {
		t.Fatal("expected a loud conflict, got nil")
	}
	if !strings.Contains(err.Error(), "conflicting endpoints") {
		t.Errorf("error does not name the conflict: %v", err)
	}
}

func TestResolveEndpoint_DefaultRemote(t *testing.T) {
	opts := Options{
		Env: map[string]string{},
		RemotesFile: writeRemotes(t, `{
			"defaultRemote": "labcom",
			"remotes": {"labcom": {"url": "http://labcom.example.net:7777"}}
		}`),
	}
	ep, err := ResolveEndpoint(opts, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Source != SourceConfig {
		t.Errorf("source = %s, want %s", ep.Source, SourceConfig)
	}
	if ep.Value.RemoteName != "labcom" {
		t.Errorf("remoteName = %q, want labcom", ep.Value.RemoteName)
	}
}

func TestResolveEndpoint_CorruptRemotesFile(t *testing.T) {
	opts := Options{
		Env:         map[string]string{},
		RemotesFile: writeRemotes(t, `{not json`),
	}
	_, err := ResolveEndpoint(opts, nil)
	if err == nil {
		t.Fatal("expected a corrupt-config error, got nil")
	}
	if !strings.Contains(err.Error(), "corrupt") {
		t.Errorf("error does not name the corrupt file: %v", err)
	}
}

func TestParseServerURL_HttpsDefaultsPort443(t *testing.T) {
	ep, err := parseServerURL("https://labcom.tail-xyz.ts.net")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ep.Port != 443 {
		t.Errorf("port = %d, want 443 for a portless https URL", ep.Port)
	}
	if ep.BaseURL != "https://labcom.tail-xyz.ts.net:443" {
		t.Errorf("baseURL = %q", ep.BaseURL)
	}
}

func TestResolveServerRoot_StoredRemoteRoot(t *testing.T) {
	opts := Options{Env: map[string]string{}}
	ep := Resolved[Endpoint]{Value: Endpoint{StoredRoot: "/srv/board", RemoteName: "labcom"}, Source: SourceConfig}
	root, err := ResolveServerRoot(opts, ep, &HealthJSON{Roots: []string{"/srv/board"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if root.Value != "/srv/board" {
		t.Errorf("root = %q", root.Value)
	}
	if root.Source != SourceConfig {
		t.Errorf("source = %s, want %s", root.Source, SourceConfig)
	}
}

func TestResolveServerRoot_StaleStoredRoot(t *testing.T) {
	opts := Options{Env: map[string]string{}}
	ep := Resolved[Endpoint]{Value: Endpoint{StoredRoot: "/old/root", RemoteName: "labcom"}, Source: SourceConfig}
	health := &HealthJSON{Roots: []string{"/new/root-a", "/new/root-b"}}
	_, err := ResolveServerRoot(opts, ep, health)
	if err == nil {
		t.Fatal("expected a stale-root refusal, got nil")
	}
	sre, ok := err.(*StaleRootError)
	if !ok {
		t.Fatalf("expected *StaleRootError, got %T", err)
	}
	if sre.Root != "/old/root" || len(sre.Roots) != 2 {
		t.Errorf("stale error carries root=%q roots=%v", sre.Root, sre.Roots)
	}
}

func TestResolveServerRoot_SingleRootAutoPick(t *testing.T) {
	opts := Options{Env: map[string]string{}}
	ep := Resolved[Endpoint]{Source: SourceEnv} // remote endpoint, no stored root
	root, err := ResolveServerRoot(opts, ep, &HealthJSON{Roots: []string{"/srv/only-board"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if root.Value != "/srv/only-board" {
		t.Errorf("root = %q", root.Value)
	}
	if root.Source != SourceHealthRoots {
		t.Errorf("source = %s, want %s", root.Source, SourceHealthRoots)
	}
}
