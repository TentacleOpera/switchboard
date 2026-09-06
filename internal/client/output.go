package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// emitJSON writes a JSON payload to stdout with 2-space indentation and a
// trailing newline, matching cli.ts emitJson (JSON.stringify(payload, null, 2)).
// It writes directly to stdout so it is unaffected by any stderr routing.
// HTML escaping is disabled so `&` stays as `&` (not `\u0026`), matching
// Node's JSON.stringify default.
func emitJSON(payload any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(payload); err != nil {
		fmt.Fprintln(os.Stderr, "[switchboard] internal error: could not encode JSON payload")
		os.Exit(1)
	}
	// json.Encoder.Encode already adds a trailing newline.
	os.Stdout.Write(buf.Bytes())
}

// emitHuman prints a line to stdout (the human path).
func emitHuman(format string, args ...any) {
	fmt.Printf(format+"\n", args...)
}

// emitErr prints a line to stderr.
func emitErr(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// offlineHints mirrors cli.ts OFFLINE_HINTS.
var offlineHints = []string{
	"switchboard local",
	"switchboard tailnet",
	"switchboard setup",
	"switchboard help",
}

// emitOfflineGuidance mirrors cli.ts emitOfflineGuidance. Always exits 1.
func emitOfflineGuidance(jsonFlag bool) {
	if jsonFlag {
		emitJSON(map[string]any{
			"success": false,
			"error":   "No running Switchboard instance",
			"hints":   offlineHints,
		})
	} else {
		emitErr("[switchboard] No running Switchboard instance found for this workspace.")
		emitErr("")
		emitErr("How to resolve:")
		emitErr("  • Local use:    Run `switchboard local` to serve the board on this machine.")
		emitErr("  • Remote use:   Run `switchboard tailnet` to serve across your Tailscale network.")
		emitErr("  • First run:    Run `switchboard setup` to initialize this repository.")
		emitErr("  • Help & info:  Run `switchboard help` to see all commands and options.")
	}
	os.Exit(1)
}

// shortPrefix returns the first 8 hex chars of a planId (dashes removed),
// matching cli.ts shortPrefix.
func shortPrefix(planID string) string {
	s := strings.ToLower(strings.ReplaceAll(planID, "-", ""))
	if len(s) > 8 {
		s = s[:8]
	}
	return s
}

// planTitle returns the human title for a plan row. The server field is
// `topic`, NOT `title`; `title` is a leading fallback only.
func planTitle(p map[string]any) string {
	if v, ok := p["topic"].(string); ok && v != "" {
		return v
	}
	if v, ok := p["title"].(string); ok && v != "" {
		return v
	}
	if v, ok := p["planFile"].(string); ok && v != "" {
		return v
	}
	return "(untitled)"
}

// formatPlanLine formats a single plan row for human-readable listing.
//   `${num}${prefix}  ${col.padEnd(16)} ${title}${proj}`
func formatPlanLine(p map[string]any, index *int) string {
	prefix := shortPrefix(asString(p["planId"]))
	col := asString(p["kanbanColumn"])
	if col == "" {
		col = "?"
	}
	title := planTitle(p)
	proj := ""
	if v := asString(p["project"]); v != "" {
		proj = " [" + v + "]"
	}
	num := ""
	if index != nil {
		num = fmt.Sprintf("%d. ", *index+1)
	}
	return fmt.Sprintf("%s%s  %-16s %s%s", num, prefix, col, title, proj)
}

// extractPlans pulls the plan array from a /kanban/plans response, handling
// {data:[...]}, raw arrays, and {plans:[...]}.
func extractPlans(raw any) []map[string]any {
	switch v := raw.(type) {
	case []any:
		return coercePlanList(v)
	case map[string]any:
		if d, ok := v["data"].([]any); ok {
			return coercePlanList(d)
		}
		if p, ok := v["plans"].([]any); ok {
			return coercePlanList(p)
		}
	}
	return nil
}

func coercePlanList(items []any) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// extractRawPlans pulls the plan array as raw JSON messages from a response
// body, preserving the server's field order for byte-identical --json output.
// Handles {data:[...]}, raw arrays, and {plans:[...]}.
func extractRawPlans(body string) []json.RawMessage {
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &top); err != nil {
		// Maybe a bare array.
		var arr []json.RawMessage
		if err := json.Unmarshal([]byte(body), &arr); err == nil {
			return arr
		}
		return nil
	}
	for _, key := range []string{"data", "plans"} {
		if raw, ok := top[key]; ok {
			var arr []json.RawMessage
			if err := json.Unmarshal(raw, &arr); err == nil {
				return arr
			}
		}
	}
	return nil
}

// rawFieldString reads a single string field from a raw JSON object without
// re-encoding the whole object (used for filtering while preserving order).
func rawFieldString(raw json.RawMessage, key string) string {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	return asString(m[key])
}

// rawFieldMap reads a raw JSON object as a map (for formatters that need
// several fields).
func rawFieldMap(raw json.RawMessage) map[string]any {
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return m
}

// rawOrNil returns the body as raw JSON if it parses, else the JSON literal
// `null`. Mirrors Node's `res.json()` which returns null on parse failure.
func rawOrNil(body string) json.RawMessage {
	if isJSON(body) {
		return json.RawMessage(body)
	}
	return json.RawMessage("null")
}

// rawOrString returns the body as raw JSON if it parses, else the body encoded
// as a JSON string. Mirrors Node's `parsed !== null ? parsed : res.body` from
// cmdApi.
func rawOrString(body string) json.RawMessage {
	if isJSON(body) {
		return json.RawMessage(body)
	}
	// Encode without HTML escaping to match Node.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(body)
	// Trim the trailing newline added by Encode.
	s := buf.String()
	if strings.HasSuffix(s, "\n") {
		s = s[:len(s)-1]
	}
	return json.RawMessage(s)
}

// isJSON reports whether s parses as a JSON value (object, array, string,
// number, bool, null).
func isJSON(s string) bool {
	var v any
	return json.Unmarshal([]byte(s), &v) == nil
}

// asString returns v as a string, "" for nil/non-string.
func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// asInt returns v as an int, 0 for nil/non-numeric.
func asInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return 0
}

// dispatchExitCode maps an HTTP status from /kanban/dispatch (and the queue
// endpoints) to the CLI exit code. Mirrors cli.ts dispatchExitCode exactly.
func dispatchExitCode(status int) int {
	switch status {
	case 200:
		return 0
	case 401:
		return 4
	case 409:
		return 3
	case 502:
		return 3
	case 400:
		return 5
	case 404:
		return 5
	case 503:
		return 6
	case 500:
		return 1
	default:
		return 1
	}
}

// readyColumns are the two dispatchable lanes. Mirrors cli.ts READY_COLUMNS.
var readyColumns = []string{"PLAN REVIEWED", "CREATED"}

// filterPlans filters subtasks (featureId === "") and optionally by project.
func filterPlans(plans []map[string]any, project string) []map[string]any {
	out := make([]map[string]any, 0, len(plans))
	for _, p := range plans {
		if asString(p["featureId"]) != "" {
			continue // subtasks excluded
		}
		if project != "" && asString(p["project"]) != project {
			continue
		}
		out = append(out, p)
	}
	return out
}
