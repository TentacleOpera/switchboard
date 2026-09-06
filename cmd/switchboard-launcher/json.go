package main

import (
	"encoding/json"
	"io"
)

// newJSONEncoder returns a JSON encoder matching Node's JSON.stringify
// defaults: HTML escaping disabled, 2-space indent.
func newJSONEncoder(w io.Writer) *json.Encoder {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc
}
