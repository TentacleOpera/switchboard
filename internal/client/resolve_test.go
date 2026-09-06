package client

import (
	"os"
	"path/filepath"
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
		"",                  // empty
		"not-a-url",         // no scheme
		"ftp://127.0.0.1:7777", // unsupported scheme
		"http://user:pass@127.0.0.1:7777", // embedded credentials
		"http://127.0.0.1",  // no port
		"http://127.0.0.1:abc", // non-numeric port
		"://127.0.0.1:7777", // no scheme
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
	opts := Options{Env: map[string]string{}}
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
	token := ResolveToken(opts)
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
	token := ResolveToken(opts)
	if token.Value != "filetoken" {
		t.Errorf("token = %q, want filetoken", token.Value)
	}
	if token.Source != SourceExplicitFlag {
		t.Errorf("source = %s, want %s", token.Source, SourceExplicitFlag)
	}
}

func TestResolveToken_BlankFileIsNone(t *testing.T) {
	tmp := t.TempDir()
	tf := filepath.Join(tmp, "blank.txt")
	if err := os.WriteFile(tf, []byte("   \n"), 0o644); err != nil {
		t.Fatal(err)
	}
	opts := Options{TokenFile: tf, Env: map[string]string{}}
	token := ResolveToken(opts)
	if token.Value != "" {
		t.Errorf("token = %q, want empty for blank file", token.Value)
	}
	if token.Source != SourceNone {
		t.Errorf("source = %s, want %s", token.Source, SourceNone)
	}
}

func TestResolveToken_MissingFileIsNone(t *testing.T) {
	opts := Options{TokenFile: "/nonexistent/path/token.txt", Env: map[string]string{}}
	token := ResolveToken(opts)
	if token.Value != "" {
		t.Errorf("token = %q, want empty for missing file", token.Value)
	}
	if token.Source != SourceNone {
		t.Errorf("source = %s, want %s", token.Source, SourceNone)
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
		{"ba8f2b52-2701-4c2d-b98c", false},        // too short
		{"ba8f2b52-2701-4c2d-b98c-00b8f292997d-extra", false}, // too long
		{"xb8f2b52-2701-4c2d-b98c-00b8f292997d", false}, // non-hex
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
