package client

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// Version is the Go client version. Set via -ldflags at build time, or the
// default here. The Node package.json version remains the source of truth for
// the host; this is the static client's own version.
var Version = "1.7.13-go-client"

// bannerArtASCII is the safe-floor banner (no escape sequences, no code points
// above 0x7E). Mirrors src/generated/bannerArt.ts BANNER_ART_ASCII so a piped
// `switchboard about` is byte-identical between the two clients.
const bannerArtASCII = `             :::++++++++++++:::
           ::==##############==::
           ::===....oooooo..===::
    ====++++++++++++++++++++++++++++====
::::====================================::::
++++::ooo:::ooo:::::::::::::::ooo:::ooo:++++
    ........ooo...ooo...ooo...ooo.......
        =============oo=============`

// Client holds the resolved routing values and is the receiver for every owned
// verb. One Client per process; routes are resolved once by the front
// controller before any command runs.
type Client struct {
	Routes    Routes
	Transport *Transport
	// NodeEntry is the resolved absolute Node host entry point (cli.js), or
	// empty when no host is installed. Reported by `about` and used by the
	// front controller for non-client-verb handoff.
	NodeEntry string
	NodeSource Source
	// JSONFlag is set per-command by the front controller.
	JSONFlag bool
}

// newClient wires a Transport from the routes.
func NewClient(r Routes, nodeEntry string, nodeSource Source) *Client {
	return &Client{
		Routes:     r,
		Transport:  newTransport(r),
		NodeEntry:  nodeEntry,
		NodeSource: nodeSource,
	}
}

// serverRoot returns the resolved server workspace root.
func (c *Client) serverRoot() string { return c.Routes.ServerRoot.Value }

// ── plans ────────────────────────────────────────────────────────────────

func (c *Client) CmdPlans(args []string) {
	var column, project, search string
	limit := 10
	offset := 0
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
		case a == "--project":
			i++; project = args[i]
		case a == "--search":
			i++; search = args[i]
		case a == "--limit":
			i++; if n, err := strconv.Atoi(args[i]); err == nil { limit = n }
		case a == "--offset":
			i++; if n, err := strconv.Atoi(args[i]); err == nil { offset = n }
		case strings.HasPrefix(a, "-"):
			// unknown flag, skip
		default:
			if column == "" {
				column = a
			}
		}
	}

	res, err := c.Transport.apiGet("/kanban/plans", optQuery("column", column))
	if err != nil {
		c.handleTransportErr(err)
	}
	if res.Status == 401 {
		c.authFailed()
	}
	if res.Status != 200 {
		c.serverError(res)
	}

	// Raw messages preserve the server's field order for byte-identical --json.
	rawPlans := extractRawPlans(res.Body)
	if project != "" {
		filtered := rawPlans[:0]
		for _, r := range rawPlans {
			if rawFieldString(r, "project") == project {
				filtered = append(filtered, r)
			}
		}
		rawPlans = filtered
	}
	if search != "" {
		q := strings.ToLower(search)
		filtered := rawPlans[:0]
		for _, r := range rawPlans {
			m := rawFieldMap(r)
			title := strings.ToLower(planTitle(m))
			planFile := strings.ToLower(asString(m["planFile"]))
			pid := strings.ToLower(asString(m["planId"]))
			if strings.Contains(title, q) || strings.Contains(planFile, q) || strings.Contains(pid, q) {
				filtered = append(filtered, r)
			}
		}
		rawPlans = filtered
	}

	total := len(rawPlans)
	pagedRaw := paginateRaw(rawPlans, offset, limit)

	if c.JSONFlag {
		emitJSON(plansEnvelope{Success: true, Count: total, Plans: ensureRawSlice(pagedRaw)})
		os.Exit(0)
	}
	if total == 0 {
		emitHuman("[switchboard] No cards found.")
		os.Exit(0)
	}
	suffix := ""
	if column != "" {
		suffix += " in " + column
	}
	if project != "" {
		suffix += " [" + project + "]"
	}
	if search != "" {
		suffix += fmt.Sprintf(" matching %q", search)
	}
	emitHuman("[switchboard] %d card%s%s:", total, plural(total), suffix)
	for i, r := range pagedRaw {
		idx := i + offset
		emitHuman("  %s", formatPlanLine(rawFieldMap(r), &idx))
	}
	if offset+limit < total {
		emitHuman("  ... %d more (use --offset %d to see them)", total-offset-limit, offset+limit)
	}
	os.Exit(0)
}

// plansEnvelope is the ordered --json envelope for plans/ready: {success, count, plans}.
type plansEnvelope struct {
	Success bool              `json:"success"`
	Count   int               `json:"count"`
	Plans   []json.RawMessage `json:"plans"`
}

// ensureRawSlice returns a non-nil slice so empty results emit `[]` not `null`.
func ensureRawSlice(s []json.RawMessage) []json.RawMessage {
	if s == nil {
		return []json.RawMessage{}
	}
	return s
}

func paginateRaw(plans []json.RawMessage, offset, limit int) []json.RawMessage {
	if offset >= len(plans) {
		return nil
	}
	end := offset + limit
	if end > len(plans) {
		end = len(plans)
	}
	return plans[offset:end]
}

// ── ready ────────────────────────────────────────────────────────────────

func (c *Client) CmdReady(args []string) {
	var project string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--json" {
			continue
		}
		if a == "--project" {
			i++; project = args[i]
			continue
		}
	}

	var readyRaw []json.RawMessage
	for _, col := range readyColumns {
		res, err := c.Transport.apiGet("/kanban/plans", optQuery("column", col))
		if err != nil {
			c.handleTransportErr(err)
		}
		if res.Status == 401 {
			c.authFailed()
		}
		if res.Status == 200 {
			readyRaw = append(readyRaw, extractRawPlans(res.Body)...)
		}
	}

	// Filter subtasks (featureId === "") and project.
	filtered := readyRaw[:0]
	for _, r := range readyRaw {
		if rawFieldString(r, "featureId") != "" {
			continue
		}
		if project != "" && rawFieldString(r, "project") != project {
			continue
		}
		filtered = append(filtered, r)
	}

	if len(filtered) == 0 {
		if c.JSONFlag {
			emitJSON(plansEnvelope{Success: true, Count: 0, Plans: []json.RawMessage{}})
		} else {
			emitHuman("[switchboard] Nothing ready to dispatch.")
		}
		os.Exit(2)
	}

	if c.JSONFlag {
		emitJSON(plansEnvelope{Success: true, Count: len(filtered), Plans: filtered})
		os.Exit(0)
	}

	emitHuman("[switchboard] %d card%s ready to dispatch:", len(filtered), plural(len(filtered)))
	for i, r := range filtered {
		emitHuman("  %s", formatPlanLine(rawFieldMap(r), &i))
	}
	// Non-interactive: print and exit 0 (never block on a hidden prompt).
	// Interactive picker is a Node-host feature; the Go client is a
	// one-request surface and does not present an interactive menu.
	os.Exit(0)
}

// ── dispatch ──────────────────────────────────────────────────────────────

func (c *Client) CmdDispatch(args []string) {
	var ref, column, project, seat string
	column = "auto"
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
		case a == "--project":
			i++; project = args[i]
		case a == "--seat":
			i++; seat = args[i]
		case strings.HasPrefix(a, "-"):
			// skip
		default:
			if ref == "" {
				ref = a
			} else if column == "auto" {
				column = a
			}
		}
	}

	if ref == "" {
		c.badInput("Usage: npx switchboard dispatch <planId|prefix> [column] [--project <name>] [--seat <terminal>] [--json]")
	}

	resolved, err := c.resolvePrefix(ref)
	if err != nil {
		c.badInputErr(err)
	}
	if project != "" {
		// Verify the plan's project matches.
		res, e := c.Transport.apiGet("/kanban/plans", nil)
		if e == nil && res.Status == 200 {
			for _, p := range extractPlans(res.JSON()) {
				if asString(p["planId"]) == resolved {
					if asString(p["project"]) != project {
						c.badInput(fmt.Sprintf("[switchboard] Plan %s is in project '%s', not '%s'.", shortPrefix(resolved), asString(p["project"]), project))
					}
					break
				}
			}
		}
	}

	body := map[string]any{"plan": resolved, "targetColumn": column}
	if seat != "" {
		body["seat"] = seat
	}
	res, err := c.Transport.apiPost("/kanban/dispatch", body, deliveryBlockingTimeoutMs)
	if err != nil {
		c.handleTransportErr(err)
	}
	code := dispatchExitCode(res.Status)
	data := res.JSON()
	if c.JSONFlag {
		emitJSON(dispatchEnvelope{Success: code == 0, Status: res.Status, ExitCode: code, Result: rawOrNil(res.Body)})
		os.Exit(code)
	}
	if code == 0 {
		m, _ := data.(map[string]any)
		emitHuman("[switchboard] Dispatched: %s → %s", asString(m["dispatchedAgent"]), asString(m["column"]))
		if asString(m["role"]) != "" {
			emitHuman("  Role: %s", asString(m["role"]))
		}
	} else {
		emitErr("[switchboard] %s", errMsg(data, res.Body))
	}
	os.Exit(code)
}

// resolvePrefix resolves a short prefix to a full planId. Returns the full id,
// or an error describing no-match/ambiguous. A full UUID is returned directly.
func (c *Client) resolvePrefix(prefix string) (string, error) {
	if isFullUUID(prefix) {
		return strings.ToLower(prefix), nil
	}
	clean := strings.ToLower(strings.ReplaceAll(prefix, "-", ""))
	if len(clean) < 3 {
		return "", fmt.Errorf("No plan matches prefix '%s'", prefix)
	}
	res, err := c.Transport.apiGet("/kanban/plans", nil)
	if err != nil || res.Status != 200 {
		return "", fmt.Errorf("No plan matches prefix '%s'", prefix)
	}
	var matches []string
	for _, p := range extractPlans(res.JSON()) {
		pid := asString(p["planId"])
		if strings.HasPrefix(strings.ToLower(strings.ReplaceAll(pid, "-", "")), clean) {
			matches = append(matches, pid)
		}
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("No plan matches prefix '%s'", prefix)
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	return "", &ambiguousPrefix{prefix: prefix, matches: matches}
}

type ambiguousPrefix struct {
	prefix  string
	matches []string
}

func (e *ambiguousPrefix) Error() string {
	return fmt.Sprintf("Ambiguous prefix '%s' — matches %d cards", e.prefix, len(e.matches))
}

// ── done ──────────────────────────────────────────────────────────────────

func (c *Client) CmdDone(args []string) {
	var from, planID, outcome string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
		case a == "--from":
			i++; from = args[i]
		case strings.HasPrefix(a, "--from="):
			from = a[len("--from="):]
		case a == "--plan":
			i++; planID = args[i]
		case strings.HasPrefix(a, "--plan="):
			planID = a[len("--plan="):]
		case a == "--outcome":
			i++; outcome = args[i]
		case strings.HasPrefix(a, "--outcome="):
			outcome = a[len("--outcome="):]
		}
	}
	if from == "" {
		c.badInput("Usage: npx switchboard done --from <seat> [--plan <planId>] [--outcome failed] [--json]")
	}

	out := "finished"
	if strings.ToLower(outcome) == "failed" {
		out = "failed"
	}
	body := map[string]any{"from": from, "outcome": out}
	if planID != "" {
		body["planId"] = planID
	}
	res, err := c.Transport.apiPost("/kanban/queue/done", body, deliveryBlockingTimeoutMs)
	if err != nil {
		if c.JSONFlag {
			emitJSON(map[string]any{"success": false, "error": fmt.Sprintf("Switchboard did not answer: %v", err)})
		} else {
			emitErr("[switchboard] Switchboard did not answer: %v", err)
		}
		os.Exit(1)
	}
	code := dispatchExitCode(res.Status)
	data := res.JSON()
	if c.JSONFlag {
		emitJSON(dispatchEnvelope{Success: code == 0, Status: res.Status, ExitCode: code, Result: rawOrNil(res.Body)})
		os.Exit(code)
	}
	if code == 0 {
		m, _ := data.(map[string]any)
		emitHuman("[switchboard] Done signal recorded for seat '%s'.", from)
		if d, ok := m["dispatched"].(map[string]any); ok {
			label := asString(d["title"])
			if label == "" {
				label = asString(d["planId"])
			}
			if label == "" {
				label = "dispatched"
			}
			emitHuman("  Next card popped: %s", label)
		} else if asString(m["reason"]) == "queue empty" {
			emitHuman("  Queue empty — the run is over.")
		}
	} else {
		emitErr("[switchboard] %s", errMsg(data, res.Body))
	}
	os.Exit(code)
}

// ── next ──────────────────────────────────────────────────────────────────

func (c *Client) CmdNext(args []string) {
	var from string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
		case a == "--from":
			i++; from = args[i]
		case strings.HasPrefix(a, "--from="):
			from = a[len("--from="):]
		}
	}
	if from == "" {
		c.badInput("Usage: npx switchboard next --from <seat> [--json]")
	}

	body := map[string]any{"from": from}
	res, err := c.Transport.apiPost("/kanban/queue/next", body, deliveryBlockingTimeoutMs)
	if err != nil {
		if c.JSONFlag {
			emitJSON(map[string]any{"success": false, "error": fmt.Sprintf("Switchboard did not answer: %v", err)})
		} else {
			emitErr("[switchboard] Switchboard did not answer: %v", err)
		}
		os.Exit(1)
	}
	code := dispatchExitCode(res.Status)
	data := res.JSON()
	if c.JSONFlag {
		emitJSON(dispatchEnvelope{Success: code == 0, Status: res.Status, ExitCode: code, Result: rawOrNil(res.Body)})
		os.Exit(code)
	}
	if code == 0 {
		m, _ := data.(map[string]any)
		if d, ok := m["dispatched"].(map[string]any); ok {
			label := asString(d["title"])
			if label == "" {
				label = asString(d["planId"])
			}
			emitHuman("[switchboard] Next card for '%s': %s", from, label)
		} else {
			emitHuman("[switchboard] Queue empty for seat '%s' — the run is over.", from)
		}
	} else {
		emitErr("[switchboard] %s", errMsg(data, res.Body))
	}
	os.Exit(code)
}

// ── clear ─────────────────────────────────────────────────────────────────

func (c *Client) CmdClear(args []string) {
	clearAll := contains(args, "--all")
	var positional []string
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			positional = append(positional, a)
		}
	}
	target := ""
	if clearAll {
		target = "--all"
	} else if len(positional) > 0 {
		target = positional[0]
	}
	if target == "" {
		c.badInput("Usage: npx switchboard clear <terminal|--all> [--json]")
	}

	var targets []string
	if clearAll {
		h, err := c.Transport.GetHealth(2000)
		if err == nil {
			targets = append(targets, h.Terminals...)
		}
		if len(targets) == 0 {
			if c.JSONFlag {
				emitJSON(map[string]any{"success": true, "cleared": []any{}})
			} else {
				emitHuman("[switchboard] No active terminals to clear.")
			}
			os.Exit(0)
		}
	} else {
		targets = []string{target}
	}

	type result struct {
		Name  string `json:"name"`
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
	}
	results := make([]result, 0, len(targets))
	allOK := true
	for _, name := range targets {
		res, err := c.Transport.apiPost("/terminals/verb/ptyClearTerminal", map[string]any{"name": name}, defaultTimeoutMs)
		ok := err == nil && res.Status == 200
		errText := ""
		if !ok {
			if err != nil {
				errText = err.Error()
			} else {
				errText = errMsg(res.JSON(), res.Body)
			}
			allOK = false
		}
		results = append(results, result{Name: name, OK: ok, Error: errText})
		if !c.JSONFlag {
			if ok {
				emitHuman("Cleared %s (OK)", name)
			} else {
				emitErr("Failed to clear %s: %s", name, errText)
			}
		}
	}
	if c.JSONFlag {
		cleared := make([]any, 0, len(results))
		for _, r := range results {
			m := map[string]any{"name": r.Name, "ok": r.OK}
			if r.Error != "" {
				m["error"] = r.Error
			}
			cleared = append(cleared, m)
		}
		emitJSON(map[string]any{"success": allOK, "cleared": cleared})
		os.Exit(0)
	}
	if allOK {
		os.Exit(0)
	}
	os.Exit(1)
}

// ── fleet ─────────────────────────────────────────────────────────────────

func (c *Client) CmdFleet(args []string) {
	health, err := c.Transport.GetHealth(2000)
	if err != nil {
		if c.JSONFlag {
			emitJSON(map[string]any{"success": false, "error": "Could not reach server"})
		} else {
			emitErr("[switchboard] No running Switchboard instance for this workspace.")
		}
		os.Exit(1)
	}

	// Raw terminal objects preserve the server's field order for --json.
	var terminalsRaw []json.RawMessage
	res, e := c.Transport.apiPost("/terminals/verb/ptyListTerminals", map[string]any{}, defaultTimeoutMs)
	if e == nil && res.Status == 200 {
		terminalsRaw = extractRawTerminals(res.Body)
	}

	if c.JSONFlag {
		emitJSON(fleetEnvelope{
			Success:       true,
			Port:          c.Routes.Endpoint.Value.Port,
			PID:           health.PID,
			TerminalCount: health.TerminalCount,
			Terminals:     ensureRawSlice(terminalsRaw),
		})
		os.Exit(0)
	}

	if len(terminalsRaw) == 0 {
		emitHuman("[switchboard] No active terminals.")
		os.Exit(0)
	}

	// Compact table mirroring cli.ts cmdFleet.
	header := []string{"SEAT", "ROLE", "STATUS", "CURRENT PLAN / TASK"}
	rows := [][]string{header}
	for _, r := range terminalsRaw {
		t := rawFieldMap(r)
		name := firstNonEmpty(asString(t["friendlyName"]), asString(t["name"]), asString(t["terminalName"]), "?")
		role := asString(t["role"])
		if role == "" {
			role = "-"
		}
		status := asString(t["status"])
		if status == "" {
			if t["alive"] == true || t["active"] == true {
				status = "active"
			} else {
				status = "idle"
			}
		}
		planLabel := firstNonEmpty(asString(t["currentPlanTitle"]), asString(t["planTitle"]), asString(t["topic"]))
		if planLabel == "" && asString(t["planId"]) != "" {
			planLabel = shortPrefix(asString(t["planId"]))
		}
		if planLabel == "" {
			planLabel = "-"
		}
		rows = append(rows, []string{name, role, status, planLabel})
	}
	widths := make([]int, len(header))
	for _, r := range rows {
		for i, cell := range r {
			if len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}
	for _, r := range rows {
		var b strings.Builder
		for i, cell := range r {
			b.WriteString(cell)
			b.WriteString(strings.Repeat(" ", widths[i]-len(cell)+2))
		}
		emitHuman("  %s", strings.TrimRight(b.String(), " "))
	}
	os.Exit(0)
}

// fleetEnvelope is the ordered --json envelope for fleet:
// {success, port, pid, terminalCount, terminals}.
type fleetEnvelope struct {
	Success       bool              `json:"success"`
	Port          int               `json:"port"`
	PID           int               `json:"pid"`
	TerminalCount int               `json:"terminalCount"`
	Terminals     []json.RawMessage `json:"terminals"`
}

// extractRawTerminals pulls the terminals array as raw JSON messages from a
// ptyListTerminals response, preserving server field order.
func extractRawTerminals(body string) []json.RawMessage {
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &top); err != nil {
		var arr []json.RawMessage
		if err := json.Unmarshal([]byte(body), &arr); err == nil {
			return arr
		}
		return nil
	}
	for _, key := range []string{"terminals", "result"} {
		if raw, ok := top[key]; ok {
			var arr []json.RawMessage
			if err := json.Unmarshal(raw, &arr); err == nil {
				return arr
			}
		}
	}
	return nil
}

// ── verb ──────────────────────────────────────────────────────────────────

var verbNotHere = strings.NewReplacer() // placeholder; use regexp below

func (c *Client) CmdVerb(args []string) {
	var positional []string
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			positional = append(positional, a)
		}
	}
	verbName := ""
	var payloadArg string
	if len(positional) > 0 {
		verbName = positional[0]
	}
	if len(positional) > 1 {
		payloadArg = positional[1]
	}
	if verbName == "" {
		c.badInput("Usage: npx switchboard verb <verbName> [jsonPayload] [--json]")
	}

	payload := map[string]any{}
	if payloadArg != "" {
		if err := json.Unmarshal([]byte(payloadArg), &payload); err != nil {
			c.badInput(fmt.Sprintf("[switchboard] Invalid JSON payload: %s", payloadArg))
		}
	}

	// Try /terminals/verb/<name> first, then /kanban/verb/<name>. Retry only on
	// 404 or a non-executing "not implemented/unknown verb" refusal — never on
	// a generic 502, which could be a side-effecting terminal verb.
	res, err := c.Transport.apiPost("/terminals/verb/"+url.PathEscape(verbName), payload, deliveryBlockingTimeoutMs)
	if err != nil {
		c.handleTransportErr(err)
	}
	if shouldRetryVerb(res) {
		res, err = c.Transport.apiPost("/kanban/verb/"+url.PathEscape(verbName), payload, deliveryBlockingTimeoutMs)
		if err != nil {
			c.handleTransportErr(err)
		}
	}

	ok := res.Status >= 200 && res.Status < 300
	if c.JSONFlag {
		// result = res.json() (null on parse failure) — preserve server field
		// order via raw passthrough.
		emitJSON(apiResultEnvelope{Success: ok, Status: res.Status, Result: rawOrNil(res.Body)})
		if ok {
			os.Exit(0)
		}
		os.Exit(1)
	}
	if ok {
		if isJSON(res.Body) {
			emitHuman("%s", prettyJSON(res.Body))
		} else if res.Body != "" {
			emitHuman("%s", res.Body)
		} else {
			emitHuman("OK")
		}
		os.Exit(0)
	}
	emitErr("[switchboard] verb '%s' returned %d: %s", verbName, res.Status, res.Body)
	os.Exit(1)
}

func shouldRetryVerb(res *APIResponse) bool {
	if res.Status == 404 {
		return true
	}
	if res.Status >= 400 {
		if m, ok := res.JSON().(map[string]any); ok {
			errStr := strings.ToLower(asString(m["error"]))
			if strings.Contains(errStr, "not implemented") ||
				strings.Contains(errStr, "unknown terminal verb") ||
				strings.Contains(errStr, "unknown pty verb") ||
				strings.Contains(errStr, "missing verb") {
				return true
			}
		}
	}
	return false
}

// ── api ───────────────────────────────────────────────────────────────────

func (c *Client) CmdApi(args []string) {
	var dataArg, timeoutArg string
	var positional []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
		case a == "--data":
			i++; dataArg = args[i]
		case strings.HasPrefix(a, "--data="):
			dataArg = a[len("--data="):]
		case a == "--timeout":
			i++; timeoutArg = args[i]
		case strings.HasPrefix(a, "--timeout="):
			timeoutArg = a[len("--timeout="):]
		case strings.HasPrefix(a, "-"):
			// skip unknown flags
		default:
			positional = append(positional, a)
		}
	}

	timeoutMs := defaultTimeoutMs
	if timeoutArg != "" {
		n, err := strconv.Atoi(timeoutArg)
		if err != nil || n <= 0 {
			c.badInput(fmt.Sprintf("[switchboard] Invalid --timeout '%s': expected a positive number of milliseconds.", timeoutArg))
		}
		timeoutMs = n
	}

	if len(positional) < 2 {
		c.badInput("Usage: npx switchboard api <METHOD> <path> [jsonBody] [--json] [--data @<file>]")
	}
	rawMethod := positional[0]
	rawPath := positional[1]
	var positionalBody string
	if len(positional) > 2 {
		positionalBody = positional[2]
	}

	upper := strings.ToUpper(rawMethod)
	allowed := map[string]bool{"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true}
	if !allowed[upper] {
		c.badInput(fmt.Sprintf("[switchboard] Invalid HTTP method '%s'. Allowed: GET, POST, PUT, PATCH, DELETE", rawMethod))
	}
	if !strings.HasPrefix(rawPath, "/") || strings.HasPrefix(rawPath, "//") || hasScheme(rawPath) {
		c.badInput(fmt.Sprintf("[switchboard] Invalid path '%s': must start with '/' and not contain scheme or authority", rawPath))
	}
	if upper == "GET" && (positionalBody != "" || dataArg != "") {
		c.badInput("[switchboard] GET requests cannot carry a body.")
	}
	if positionalBody != "" && dataArg != "" {
		c.badInput("[switchboard] Cannot specify both positional JSON body and --data file.")
	}

	var parsedBody any
	switch {
	case dataArg != "":
		fp := dataArg
		if strings.HasPrefix(fp, "@") {
			fp = fp[1:]
		}
		resolved := fp
		if !filepath.IsAbs(fp) {
			resolved = filepath.Join(c.Routes.ServerRoot.Value, fp)
		}
		b, err := os.ReadFile(resolved)
		if err != nil {
			c.badInput(fmt.Sprintf("[switchboard] Cannot read data file '%s': %v", fp, err))
		}
		if err := json.Unmarshal(b, &parsedBody); err != nil {
			c.badInput(fmt.Sprintf("[switchboard] Invalid JSON in data file: %s", fp))
		}
	case positionalBody != "":
		if err := json.Unmarshal([]byte(positionalBody), &parsedBody); err != nil {
			c.badInput(fmt.Sprintf("[switchboard] Invalid JSON payload: %s", positionalBody))
		}
	}

	res, err := c.Transport.apiRequest(upper, rawPath, parsedBody, nil, timeoutMs)
	if err != nil {
		if c.JSONFlag {
			emitJSON(map[string]any{"success": false, "error": err.Error()})
		} else {
			emitErr("[switchboard] Request failed: %v", err)
		}
		os.Exit(1)
	}
	if res.Status == 401 {
		if c.JSONFlag {
			// result = parsed !== null ? parsed : (res.body || 'Authentication failed')
			var result json.RawMessage
			if isJSON(res.Body) {
				result = json.RawMessage(res.Body)
			} else if res.Body != "" {
				b, _ := json.Marshal(res.Body)
				result = b
			} else {
				result = json.RawMessage(`"Authentication failed"`)
			}
			emitJSON(apiResultEnvelope{Success: false, Status: 401, Result: result})
		} else {
			emitErr("[switchboard] Authentication failed (401). The server requires a token.")
		}
		os.Exit(4)
	}
	if c.JSONFlag {
		ok := res.Status >= 200 && res.Status < 300
		emitJSON(apiResultEnvelope{Success: ok, Status: res.Status, Result: rawOrString(res.Body)})
		if ok {
			os.Exit(0)
		}
		os.Exit(1)
	}
	if res.Status >= 200 && res.Status < 300 {
		if isJSON(res.Body) {
			// Re-emit pretty-printed, preserving field order via a re-indent pass.
			emitHuman("%s", prettyJSON(res.Body))
		} else if res.Body != "" {
			emitHuman("%s", res.Body)
		} else {
			emitHuman("OK")
		}
		os.Exit(0)
	}
	emitErr("[switchboard] api %s %s returned %d: %s", upper, rawPath, res.Status, res.Body)
	os.Exit(1)
}

// apiResultEnvelope is the ordered --json envelope for api/verb:
// {success, status, result}.
type apiResultEnvelope struct {
	Success bool            `json:"success"`
	Status  int             `json:"status"`
	Result  json.RawMessage `json:"result"`
}

// dispatchEnvelope is the ordered --json envelope for dispatch/done/next:
// {success, status, exitCode, result}.
type dispatchEnvelope struct {
	Success  bool            `json:"success"`
	Status   int             `json:"status"`
	ExitCode int             `json:"exitCode"`
	Result   json.RawMessage `json:"result"`
}

// prettyJSON re-indents a compact JSON document with 2-space indentation,
// preserving key order. Go's encoding/json sorts map keys, which would break
// byte parity with Node's JSON.stringify(data, null, 2); this walker only
// adjusts whitespace around structural characters and never reorders tokens.
func prettyJSON(body string) string {
	if body == "" {
		return ""
	}
	// Validate first; fall back to the raw body if it isn't JSON.
	var v any
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return body
	}
	return indentJSON(body)
}

// indentJSON walks a compact JSON byte string and emits 2-space-indented JSON
// with the same key order. Strings are passed through verbatim (including
// escaped quotes and structural characters inside strings), so the only bytes
// examined for structural decisions are those outside string literals.
func indentJSON(s string) string {
	var b strings.Builder
	indent := 0
	inStr := false
	escape := false
	emitNewline := func() {
		b.WriteByte('\n')
		if indent > 0 {
			b.WriteString(strings.Repeat("  ", indent))
		}
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inStr {
			b.WriteByte(c)
			if escape {
				escape = false
				continue
			}
			if c == '\\' {
				escape = true
				continue
			}
			if c == '"' {
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
			b.WriteByte(c)
		case '{', '[':
			b.WriteByte(c)
			// Peek: if the next non-space char closes the container, it's
			// empty ({} or []) — no indent bump, no newline.
			if next := nextSignificant(s, i+1); next == '}' || next == ']' {
				continue
			}
			indent++
			emitNewline()
		case '}', ']':
			// If the last byte written was the matching opening bracket,
			// this is an empty container — no dedent, no newline.
			last := lastByte(b.String())
			if last == '{' || last == '[' {
				b.WriteByte(c)
			} else {
				if indent > 0 {
					indent--
				}
				emitNewline()
				b.WriteByte(c)
			}
		case ',':
			b.WriteByte(c)
			emitNewline()
		case ':':
			b.WriteByte(c)
			b.WriteByte(' ')
		case ' ', '\t', '\n', '\r':
			// Skip whitespace in the compact input.
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func nextSignificant(s string, i int) byte {
	for ; i < len(s); i++ {
		switch s[i] {
		case ' ', '\t', '\n', '\r':
			continue
		default:
			return s[i]
		}
	}
	return 0
}

// lastByte returns the last byte of s, or 0 if empty.
func lastByte(s string) byte {
	if len(s) == 0 {
		return 0
	}
	return s[len(s)-1]
}

// ── status ────────────────────────────────────────────────────────────────

func (c *Client) CmdStatus(args []string) {
	health, err := c.Transport.GetHealth(2000)
	if err != nil {
		if c.JSONFlag {
			emitJSON(map[string]any{"running": false})
		} else {
			emitErr("[switchboard] No running Switchboard instance for this workspace.")
		}
		os.Exit(1)
	}
	wsRoot := c.serverRoot()
	if health.SelectedWorkspaceRoot != nil && *health.SelectedWorkspaceRoot != "" {
		wsRoot = *health.SelectedWorkspaceRoot
	}
	// Ordered struct so --json is byte-identical to Node (insertion order:
	// running, pid, port, url, workspaceRoot, roots, terminalCount, terminals).
	type statusPayload struct {
		Running        bool     `json:"running"`
		PID            int      `json:"pid"`
		Port           int      `json:"port"`
		URL            string   `json:"url"`
		WorkspaceRoot  string   `json:"workspaceRoot"`
		Roots          []string `json:"roots"`
		TerminalCount  int      `json:"terminalCount"`
		Terminals      []string `json:"terminals"`
	}
	payload := statusPayload{
		Running:       true,
		PID:           health.PID,
		Port:          c.Routes.Endpoint.Value.Port,
		URL:           c.Routes.Endpoint.Value.BaseURL,
		WorkspaceRoot: wsRoot,
		Roots:         health.Roots,
		TerminalCount: health.TerminalCount,
		Terminals:     health.Terminals,
	}
	if c.JSONFlag {
		emitJSON(payload)
		os.Exit(0)
	}
	emitHuman("[switchboard] Running (PID %d, port %d)", health.PID, c.Routes.Endpoint.Value.Port)
	emitHuman("  URL:       %s", payload.URL)
	emitHuman("  Workspace: %s", wsRoot)
	emitHuman("  Terminals: %d", health.TerminalCount)
	os.Exit(0)
}

// ── logs ──────────────────────────────────────────────────────────────────
//
// The Node `logs` reads and polls a local file. The plan adds an authenticated
// host-log endpoint; until that endpoint exists, the Go client reads the local
// file when the board is local (matching Node) and reports an explicit
// unsupported capability for a remote board with no local log file.

func (c *Client) CmdLogs(args []string) {
	follow := false
	for _, a := range args {
		if a == "-f" || a == "--follow" {
			follow = true
		}
	}
	logFile := filepath.Join(c.Routes.ServerRoot.Value, ".switchboard", "logs", "server.log")
	b, err := os.ReadFile(logFile)
	if err != nil {
		emitErr("[switchboard] No log file found at %s.", logFile)
		emitErr("[switchboard] The server may not have been started, or may be running in an older version without file logging.")
		os.Exit(1)
	}
	os.Stdout.Write(b)
	if !follow {
		os.Exit(0)
	}
	// Follow: poll for new content. Polling handles rotation transparently.
	followLogs(logFile, int64(len(b)))
}

// ── about ─────────────────────────────────────────────────────────────────

func (c *Client) CmdAbout(args []string) {
	if c.JSONFlag {
		// Ordered struct for deterministic field order. The Go client's
		// `about --json` is its own identification surface — it is not a
		// byte-parity match with Node's `about --json`, which has a
		// different shape (Host: Standalone, etc.).
		type aboutJSON struct {
			Version        string   `json:"version"`
			Service        string   `json:"service"`
			Host           string   `json:"host"`
			Platform       string   `json:"platform"`
			Arch           string   `json:"arch"`
			WorkspaceRoot  string   `json:"workspaceRoot"`
			ServerURL      string   `json:"serverUrl,omitempty"`
			Running        bool     `json:"running"`
			PID            int      `json:"pid,omitempty"`
			TerminalCount  int      `json:"terminalCount,omitempty"`
			Terminals      []string `json:"terminals,omitempty"`
			NodeHostEntry  *string  `json:"nodeHostEntry"`
			NodeHostSource string   `json:"nodeHostSource"`
		}
		p := aboutJSON{
			Version:       Version,
			Service:       "switchboard",
			Host:          "go-client",
			Platform:      runtime.GOOS,
			Arch:          runtime.GOARCH,
			WorkspaceRoot: c.serverRoot(),
			Running:       false,
		}
		if h, err := c.Transport.GetHealth(1000); err == nil {
			p.ServerURL = c.Routes.Endpoint.Value.BaseURL
			p.Running = true
			p.PID = h.PID
			p.TerminalCount = h.TerminalCount
			p.Terminals = h.Terminals
		}
		if c.NodeEntry != "" {
			entry := c.NodeEntry
			p.NodeHostEntry = &entry
			p.NodeHostSource = string(c.NodeSource)
		} else {
			p.NodeHostEntry = nil
			p.NodeHostSource = string(SourceNone)
		}
		emitJSON(p)
		os.Exit(0)
	}
	emitHuman(bannerArtASCII)
	emitHuman("")
	emitHuman("SWITCHBOARD v%s", Version)
	emitHuman("Agent Fleet Command")
	emitHuman("")
	emitHuman("https://github.com/TentacleOpera/switchboard")
	emitHuman("Host: Go Client (" + runtime.GOOS + " " + runtime.GOARCH + ")")
	if c.NodeEntry != "" {
		emitHuman("Node host: %s (%s)", c.NodeEntry, c.NodeSource)
	} else {
		emitHuman("Node host: (not installed)")
	}
	emitHuman("")
	if h, err := c.Transport.GetHealth(1000); err == nil {
		emitHuman("Active Server:    %s (%s)", c.Routes.Endpoint.Value.BaseURL, c.Routes.Endpoint.Source)
		ws := c.serverRoot()
		if h.SelectedWorkspaceRoot != nil && *h.SelectedWorkspaceRoot != "" {
			ws = *h.SelectedWorkspaceRoot
		}
		emitHuman("Workspace:        %s", ws)
		seats := h.Terminals
		emitHuman("Active Fleet:     %d seat%s%s", len(seats), plural(len(seats)), seatList(seats))
	} else {
		emitHuman("Active Server:    (not running)")
		emitHuman("Workspace:        %s", c.serverRoot())
	}
	os.Exit(0)
}

// ── help ──────────────────────────────────────────────────────────────────

func (c *Client) CmdHelp(args []string) {
	fmt.Print(usageText)
	os.Exit(0)
}

// ── probe ─────────────────────────────────────────────────────────────────
//
// `probe` reads resident memory, inotify, and FDs of the running host. The
// Node implementation reads /proc/<pid>/status and uses native inotify/FD
// counters. The Go client reports the /health memory fields and, on Linux,
// reads /proc/<pid>/status for VmRSS when the host reports zero. Native
// inotify/FD counters are host-side concerns; the Go client reports what
// /health exposes and notes when deeper probes require the host.

func (c *Client) CmdProbe(args []string) {
	var csvFile string
	samples := 1
	intervalMs := 1000
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
		case a == "--csv":
			i++; csvFile = args[i]
		case a == "--samples" || a == "-n":
			i++; if n, err := strconv.Atoi(args[i]); err == nil { samples = n }
		case a == "--interval" || a == "-i":
			i++; if n, err := strconv.Atoi(args[i]); err == nil { intervalMs = n }
		}
	}

	csvHeader := "timestamp,pid,rss,heapUsed,heapTotal,external,arrayBuffers,inotifyDescriptors,openFds"
	if !c.JSONFlag && csvFile == "" {
		emitHuman(csvHeader)
	}

	results := make([]probeSample, 0, samples)
	for s := 0; s < samples; s++ {
		if s > 0 && intervalMs > 0 {
			sleep(intervalMs)
		}
		h, err := c.Transport.GetHealth(2000)
		if err != nil {
			if c.JSONFlag {
				emitJSON(map[string]any{"success": false, "error": "Failed to contact running server"})
			} else {
				emitErr("[switchboard] Failed to contact running server: %v", err)
			}
			os.Exit(1)
		}
		var mem struct {
			RSS          int64 `json:"rss"`
			HeapUsed     int64 `json:"heapUsed"`
			HeapTotal    int64 `json:"heapTotal"`
			External     int64 `json:"external"`
			ArrayBuffers int64 `json:"arrayBuffers"`
		}
		if len(h.Memory) > 0 {
			_ = json.Unmarshal(h.Memory, &mem)
		}
		rss := mem.RSS
		if rss == 0 && runtime.GOOS == "linux" {
			if v := readProcRss(h.PID); v > 0 {
				rss = v
			}
		}
		inotify := readInotifyWatchCount(h.PID)
		openFds := readOpenFdCount(h.PID)
		rec := probeSample{
			Timestamp: nowISO(), PID: h.PID, RSS: rss,
			HeapUsed: mem.HeapUsed, HeapTotal: mem.HeapTotal,
			External: mem.External, ArrayBuffers: mem.ArrayBuffers,
			Inotify: inotify, OpenFds: openFds,
		}
		results = append(results, rec)
		if !c.JSONFlag && csvFile == "" {
			emitHuman("%s,%d,%d,%d,%d,%d,%d,%d,%d", rec.Timestamp, rec.PID, rec.RSS, rec.HeapUsed, rec.HeapTotal, rec.External, rec.ArrayBuffers, rec.Inotify, rec.OpenFds)
		}
	}
	if csvFile != "" {
		anyRows := make([]any, 0, len(results))
		for _, r := range results {
			anyRows = append(anyRows, r)
		}
		writeCsv(csvFile, csvHeader, anyRows)
		if !c.JSONFlag {
			emitHuman("[switchboard] Recorded %d probe sample(s) to %s", len(results), csvFile)
		}
	}
	if c.JSONFlag {
		emitJSON(probeEnvelope{Success: true, Samples: results})
	}
	os.Exit(0)
}

// probeSample is a single probe record. Field order matches Node's output.
type probeSample struct {
	Timestamp    string `json:"timestamp"`
	PID          int    `json:"pid"`
	RSS          int64  `json:"rss"`
	HeapUsed     int64  `json:"heapUsed"`
	HeapTotal    int64  `json:"heapTotal"`
	External     int64  `json:"external"`
	ArrayBuffers int64  `json:"arrayBuffers"`
	Inotify      int    `json:"inotifyDescriptors"`
	OpenFds      int    `json:"openFds"`
}

// probeEnvelope is the ordered --json envelope for probe: {success, samples}.
type probeEnvelope struct {
	Success bool           `json:"success"`
	Samples []probeSample `json:"samples"`
}

// ── shared helpers ─────────────────────────────────────────────────────────

func (c *Client) authFailed() {
	if c.JSONFlag {
		emitJSON(map[string]any{"success": false, "error": "Authentication failed"})
	} else {
		emitErr("[switchboard] Authentication failed (401). The server requires a token.")
	}
	os.Exit(4)
}

func (c *Client) serverError(res *APIResponse) {
	if c.JSONFlag {
		emitJSON(map[string]any{"success": false, "error": fmt.Sprintf("Server returned %d", res.Status), "body": res.Body})
	} else {
		emitErr("[switchboard] Server returned %d: %s", res.Status, res.Body)
	}
	os.Exit(1)
}

func (c *Client) handleTransportErr(err error) {
	if c.JSONFlag {
		emitJSON(map[string]any{"success": false, "error": fmt.Sprintf("Switchboard did not answer: %v", err)})
	} else {
		emitErr("[switchboard] Switchboard did not answer: %v", err)
	}
	os.Exit(1)
}

func (c *Client) badInput(msg string) {
	if c.JSONFlag {
		emitJSON(map[string]any{"success": false, "error": strings.TrimPrefix(msg, "[switchboard] ")})
	} else {
		emitErr("%s", msg)
	}
	os.Exit(5)
}

func (c *Client) badInputErr(err error) {
	if c.JSONFlag {
		if ap, ok := err.(*ambiguousPrefix); ok {
			emitJSON(map[string]any{"success": false, "error": "Ambiguous prefix", "matches": ap.matches})
		} else {
			emitJSON(map[string]any{"success": false, "error": err.Error()})
		}
	} else {
		if ap, ok := err.(*ambiguousPrefix); ok {
			emitErr("[switchboard] Ambiguous prefix '%s' — matches %d cards:", ap.prefix, len(ap.matches))
			for _, pid := range ap.matches {
				emitErr("  %s  %s", shortPrefix(pid), pid)
			}
		} else {
			emitErr("[switchboard] %s", err.Error())
		}
	}
	os.Exit(5)
}

// errMsg returns the error message from a response payload, falling back to
// the body or a default.
func errMsg(data any, body string) string {
	if m, ok := data.(map[string]any); ok {
		if e := asString(m["error"]); e != "" {
			return e
		}
	}
	if body != "" {
		return body
	}
	return "request failed"
}

// optQuery returns a query map with one key set when value is non-empty.
func optQuery(key, value string) map[string]string {
	if value == "" {
		return nil
	}
	return map[string]string{key: value}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func seatList(seats []string) string {
	if len(seats) == 0 {
		return ""
	}
	return " (" + strings.Join(seats, ", ") + ")"
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func paginate(plans []map[string]any, offset, limit int) []map[string]any {
	if offset >= len(plans) {
		return nil
	}
	end := offset + limit
	if end > len(plans) {
		end = len(plans)
	}
	return plans[offset:end]
}

func isFullUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	// 8-4-4-4-12 hex
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return false
			}
		}
	}
	return true
}

func hasScheme(p string) bool {
	// Reject anything matching ^[a-zA-Z][a-zA-Z0-9+.-]*:
	// (a scheme/authority prefix), matching cli.ts cmdApi validation.
	if p == "" {
		return false
	}
	c := p[0]
	if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
		return false
	}
	for i := 1; i < len(p); i++ {
		ch := p[i]
		if ch == ':' {
			return true
		}
		if !((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '+' || ch == '-' || ch == '.') {
			return false
		}
	}
	return false
}

// nowISO returns the current UTC time in RFC3339 with milliseconds, matching
// Node's new Date().toISOString() format.
func nowISO() string {
	return timeNowUTC()
}

// sleep is a small wrapper for testability.
var sleep = func(ms int) { timeSleep(ms) }

// sortStrings is a helper to keep imports minimal in callers.
func sortStrings(list []string) []string {
	sort.Strings(list)
	return list
}
