# Switchboard Webview Artifacts

This folder stores runtime workflow artifacts rendered or referenced by the Switchboard sidebar (for example review outputs, handoff logs, and audit notes).

## Notes

- Core workflow definitions are maintained in `src/mcp-server/workflows.js`.
- Runtime protocol state lives in workspace `.switchboard/` files.
- The sidebar provider implementation is `src/services/TaskViewerProvider.ts`.
