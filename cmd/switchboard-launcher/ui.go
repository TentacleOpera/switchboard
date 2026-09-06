package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
)

// serveLauncherUI starts the embedded loopback launcher UI. The UI is served
// on a loopback port (default: ephemeral) and opened in the default browser.
// It is presentation only — every action routes back through the headless
// commands. Tray behaviour is disabled until validated (plan: tray disabled).
//
// The UI binds to 127.0.0.1 only. The host validation in LocalApiServer's
// _handleRequest already rejects non-loopback peers for static browser
// content; the launcher's own UI server applies the same boundary at the
// listener. A non-loopback bind would expose the launcher UI to the network,
// which is out of scope for the static launcher.
func serveLauncherUI(workspaceRoot string, preferredPort int) {
	listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(preferredPort))
	if err != nil {
		fmt.Fprintf(os.Stderr, "[launcher] could not bind loopback UI listener: %v\n", err)
		os.Exit(1)
	}
	port := listener.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Loopback-only: the listener already bounds to 127.0.0.1, but defend
		// in depth — a request that arrived via a forwarded/proxied path must
		// not render the UI.
		host := r.RemoteAddr
		if !isLoopbackRemoteAddr(host) {
			http.Error(w, "forbidden: launcher UI is loopback-only", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		_, _ = w.Write([]byte(launcherUIHTML(workspaceRoot, port)))
	})
	mux.HandleFunc("/state.json", func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRemoteAddr(r.RemoteAddr) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		state := resolveState(workspaceRoot)
		// Wrap so the UI sees availableActions and workspaceRoot alongside the
		// raw state. Go's json.Marshal only serializes fields, not methods, so
		// the action list is projected here.
		emitJSONTo(w, map[string]any{
			"state":            state.State,
			"availableActions": state.AvailableActions(),
			"workspaceRoot":    workspaceRoot,
			"runningHost":      state.RunningHost,
			"runningPort":      state.RunningPort,
			"runningSource":    state.RunningSource,
			"shutdownCapability": state.ShutdownCap,
			"hostInstalled":    state.HostInstalled,
			"hostEntry":        state.HostEntry,
			"hostSource":       state.HostSource,
			"workspaces":       state.Workspaces,
			"dependencies":     state.Dependencies,
			"selectedWorkspaceRoot": state.SelectedRoot,
			"servedRoots":      state.ServedRoots,
		})
	})

	url := fmt.Sprintf("http://127.0.0.1:%d/", port)
	fmt.Printf("[launcher] UI listening on %s (loopback only)\n", url)
	fmt.Println("[launcher] Open the URL in a browser. Press Ctrl+C to exit.")
	// Tray disabled until validated (plan: tray disabled). The UI is a
	// foreground loopback server; the operator closes it with Ctrl+C.
	if err := http.Serve(listener, mux); err != nil {
		fmt.Fprintf(os.Stderr, "[launcher] UI server error: %v\n", err)
		os.Exit(1)
	}
}

// isLoopbackRemoteAddr returns true when the remote address is a loopback
// TCP peer. The listener is already bound to 127.0.0.1, so this is defense in
// depth against forwarded/proxied requests.
func isLoopbackRemoteAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// emitJSONTo writes a JSON payload to an http.ResponseWriter with 2-space
// indentation and HTML escaping disabled (matching Node's JSON.stringify).
func emitJSONTo(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	enc := newJSONEncoder(w)
	_ = enc.Encode(payload)
}

// launcherUIHTML returns the embedded launcher UI HTML. The UI is a single
// page that fetches /state.json and renders the available actions. It
// contains NO board logic, NO schema, NO prompt text, NO column logic — it is
// presentation only. Every action is a link/button that re-invokes the
// launcher's headless commands (the operator runs them in a terminal; the UI
// does not spawn processes itself, which would require a privileged
// server-side exec endpoint).
func launcherUIHTML(workspaceRoot string, port int) string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Switchboard Launcher</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; }
  .state { font-family: monospace; background: #f4f4f4; padding: 0.5rem 1rem; border-radius: 4px; display: inline-block; }
  .actions { margin: 1rem 0; }
  .actions a { display: inline-block; margin-right: 0.5rem; padding: 0.4rem 0.8rem; background: #1a73e8; color: #fff; text-decoration: none; border-radius: 4px; font-size: 0.9rem; }
  .actions a.disabled { background: #ccc; color: #666; pointer-events: none; }
  .meta { font-size: 0.85rem; color: #666; margin-top: 1rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  .unavailable { color: #b00; }
  .note { background: #fff8e1; padding: 0.5rem 1rem; border-radius: 4px; margin-top: 1rem; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Switchboard Launcher</h1>
<p>Workspace root: <code>` + escapeHTML(workspaceRoot) + `</code></p>
<p>State: <span class="state" id="state">loading…</span></p>
<div class="actions" id="actions"></div>
<div id="details"></div>
<p class="meta">Launcher UI is presentation only. Actions run in a terminal via the launcher's headless commands. Tray is disabled until validated.</p>
<script>
fetch('/state.json').then(r => r.json()).then(s => {
  document.getElementById('state').textContent = s.state;
  const actions = document.getElementById('actions');
  (s.availableActions || []).forEach(a => {
    const link = document.createElement('a');
    link.textContent = a;
    link.href = '#';
    link.onclick = (e) => { e.preventDefault(); alert('Run in a terminal:\\n  switchboard-launcher ' + a + ' --workspace-root ' + JSON.stringify(s.workspaceRoot || '') ); };
    actions.appendChild(link);
  });
  const details = document.getElementById('details');
  if (s.runningHost) {
    details.innerHTML += '<p>Running host: <code>' + s.runningHost.kind + '</code> instance <code>' + s.runningHost.instanceId + '</code> port ' + s.runningPort + '</p>';
  }
  if (s.workspaces && s.workspaces.unavailable) {
    details.innerHTML += '<p class="unavailable">Workspaces unavailable: ' + escapeHtml(s.workspaces.reason) + ' (source: ' + escapeHtml(s.workspaces.source) + ')</p>';
  } else if (s.workspaces && s.workspaces.value) {
    let rows = s.workspaces.value.map(w => '<tr><td>' + escapeHtml(w.root) + '</td><td>' + escapeHtml(w.label || '(unlabeled)') + '</td><td>' + (w.enabled ? 'enabled' : 'disabled') + '</td></tr>').join('');
    details.innerHTML += '<table><thead><tr><th>Root</th><th>Label</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  if (s.dependencies) {
    let rows = s.dependencies.map(d => '<tr><td>' + escapeHtml(d.name) + '</td><td>' + (d.present ? 'ok' : 'missing') + '</td><td>' + escapeHtml(d.version || '') + '</td><td>' + escapeHtml(d.source) + '</td></tr>').join('');
    details.innerHTML += '<table><thead><tr><th>Dependency</th><th>Status</th><th>Version</th><th>Source</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
}).catch(err => {
  document.getElementById('state').textContent = 'error: ' + err;
});
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
</script>
</body>
</html>`
}

func escapeHTML(s string) string {
	out := make([]byte, 0, len(s))
	for _, c := range []byte(s) {
		switch c {
		case '&':
			out = append(out, []byte("&amp;")...)
		case '<':
			out = append(out, []byte("&lt;")...)
		case '>':
			out = append(out, []byte("&gt;")...)
		case '"':
			out = append(out, []byte("&quot;")...)
		case '\'':
			out = append(out, []byte("&#39;")...)
		default:
			out = append(out, c)
		}
	}
	return string(out)
}
