package client

import (
	"encoding/json"
	"os"
	"os/signal"
	"syscall"
)

// jsonMarshal/jsonUnmarshal are thin wrappers so helpers.go can avoid importing
// encoding/json directly (keeps the import graph tidy and testable).
func jsonMarshal(v any) ([]byte, error)        { return json.Marshal(v) }
func jsonUnmarshal(b []byte, v any) error      { return json.Unmarshal(b, v) }

// signalNotify registers a channel for SIGINT/SIGTERM. Wrapped so tests can
// substitute a no-op notifier.
var signalNotify = func(ch chan os.Signal) {
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
}

// usageText mirrors the relevant subset of cli.ts usage() for the Go client's
// `help`. Owned verbs are documented; non-client verbs are noted as Node-host
// delegation targets.
const usageText = `Usage: switchboard                        (interactive front-door menu — Node host)
       switchboard plans [column] [--project <name>] [--search <query>] [--limit N] [--offset N] [--json]
       switchboard ready [--project <name>] [--json]
       switchboard dispatch <planId|prefix> [column] [--project <name>] [--seat <terminal>] [--json]
       switchboard done --from <seat> [--plan <planId>] [--outcome failed] [--json]
       switchboard next --from <seat> [--json]
       switchboard clear <terminal|--all> [--json]
       switchboard fleet [--json]
       switchboard verb <verbName> [jsonPayload] [--json]
       switchboard api <METHOD> <path> [jsonBody] [--json] [--data @<file>] [--timeout <ms>]
       switchboard status [--json]
       switchboard logs [-f|--follow]
       switchboard probe [--csv <file>] [--samples N] [--interval N] [--json]
       switchboard help [command]
       switchboard about | version

Board commands (drive the board from a terminal — served by this Go client):
  plans               List cards with optional column/project/search filtering.
  ready               List cards ready to dispatch (PLAN REVIEWED + CREATED,
                      subtasks excluded). Lists and exits 0 on non-interactive stdin.
  dispatch            Dispatch a card by planId or unique prefix. Column defaults
                      to auto (complexity routing). Exit codes:
                        0 dispatched  1 offline  2 nothing ready  3 refused
                        4 auth failed  5 bad input  6 unavailable
  done                Signal task completion for a seat (pops next card if queued).
  next                Pull the next card from the queue for a seat.
  clear               Clear a terminal seat (or --all seats).
  fleet               Show live terminal seats, roles, and assigned plans.
  verb                Call any protocol verb directly: switchboard verb <name> <json>
  api                 Call any API endpoint directly: switchboard api <METHOD> <path> [json] [--data @file]
  status              Show running server identity and resolved endpoint.
  logs                Read the host log file (local board) or follow with -f.
  probe               Probe host resident memory and (on Linux) /proc VmRSS.
  help                Show this help.
  about               Show Go client version and system info.

Connection options (resolve a remote board without Node):
  --server <http[s]://host:port>   Explicit board endpoint (--endpoint alias).
  --workspace-root <server-path>   Server-side workspace root, required for
                                   remote (--server-root alias).
  --token-file <path>              Credential file (or SWITCHBOARD_API_TOKEN env).
  SWITCHBOARD_SERVER_URL           Endpoint from environment.
  SWITCHBOARD_WORKSPACE_ROOT       Server workspace root from environment.
  SWITCHBOARD_API_TOKEN            Credential from environment.
  SWITCHBOARD_NODE_ENTRYPOINT      Override the Node host entry point for non-client verbs.

Non-client verbs (local, tailnet, setup, secrets, token, import/export, stop,
interactive menu) are delegated to the Node host entry point when one is
installed. A client-only installation reports "this machine has no board host
installed" for those verbs.
`
