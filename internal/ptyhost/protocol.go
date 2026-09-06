package ptyhost

import "encoding/json"

// ProtocolVersion is part of the ready handshake and every error response. A
// client must reject a host with an unsupported version instead of guessing.
const ProtocolVersion = 1

var SupportedVerbs = map[string]struct{}{
	"ptyCreateTerminal": {}, "ptyCreateBatch": {}, "ptyCloseTerminal": {},
	"ptyListTerminals": {}, "ptyRenameTerminal": {}, "ptyClearTerminal": {},
	"ptySendModel": {}, "ptyClearAllTerminals": {}, "ptyWrite": {},
	"ptyPasteImage": {}, "ptySendPrompt": {}, "ptySetControllerSeat": {},
	"ptyRollLogSession": {},
}

type Ready struct {
	T       string `json:"t"`
	Version int    `json:"version"`
	Port    int    `json:"port"`
	Token   string `json:"token"`
}

type Request struct {
	Verb    string          `json:"verb"`
	Payload json.RawMessage `json:"payload"`
}

type ErrorResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error"`
	Code    string `json:"code,omitempty"`
}

type TerminalProjection struct {
	FriendlyName  string `json:"friendlyName"`
	Role          string `json:"role,omitempty"`
	Status        string `json:"status,omitempty"`
	PID           int    `json:"pid,omitempty"`
	StartTime     string `json:"startTime,omitempty"`
	WorktreePath  string `json:"worktreePath,omitempty"`
	AgentInstance string `json:"agentInstanceId,omitempty"`
	Parent        string `json:"parentInstanceId,omitempty"`
}

func IsSupportedVerb(verb string) bool {
	_, ok := SupportedVerbs[verb]
	return ok
}
