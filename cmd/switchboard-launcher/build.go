package main

import (
	"net/http"
	"time"
)

// launcherVersion and buildArch are set by -ldflags at build time. Defaults
// match the dev build so `switchboard-launcher version` always answers.
var (
	launcherVersion = "0.0.0-dev"
	buildArch       = "linux/amd64"
)

// httpClient2s is the standard loopback HTTP client used by the launcher's
// transport construction. Two seconds matches cli.ts getHealthJson default.
func httpClient2s() *http.Client {
	return &http.Client{Timeout: 2 * time.Second}
}
