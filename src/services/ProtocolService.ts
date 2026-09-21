import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { KanbanDatabase, ControlPlaneEntry } from "./KanbanDatabase";
import { BUNDLED_PROTOCOLS, BundledProtocol } from "./bundledProtocols";
import { stateFile } from "../utils/stateHome";

/** Which store answered a protocol resolution. Required on every resolution:
 *  an inlined body that came from the shipped bundle must never be
 *  indistinguishable from one the operator edited in the workspace. */
export type ProtocolSource =
    | "workspace-file"          // .agents/protocols/<name>/SKILL.md — the operator's editable copy
    | "control-plane-override"  // a workspace override row
    | "control-plane"           // a seeded registry row
    | "bundled";                // the body shipped in this build

export interface ResolvedProtocol {
    name: string;
    body: string;
    path?: string;
    delivery: "inline" | "materialize";
    /** Which store the body came from. See `ProtocolSource`. */
    source: ProtocolSource;
}

/** The only protocols `ClaudeCodeMirrorService` projects into
 *  `.agents/protocols/`, and therefore the only ones an operator can edit as a
 *  file. The mirror deliberately PRESERVES a modified copy — it writes
 *  `<file>.local.bak` and skips the overwrite (`filesPreserved++`) — so where
 *  that file exists it is the operator's answer and outranks the registry row. */
export const WORKSPACE_PROJECTED_PROTOCOLS: ReadonlySet<string> = new Set([
    "improve-plan",
    "improve-feature",
]);

export class ProtocolService {
    /**
     * Seeds all bundled protocols into the control_plane table of the database.
     */
    public static async seedProtocols(db: KanbanDatabase): Promise<{ seeded: number; updated: number }> {
        const entries: ControlPlaneEntry[] = Object.values(BUNDLED_PROTOCOLS).map(p => ({
            name: p.name,
            kind: "protocol",
            version: p.version,
            contentHash: p.contentHash,
            body: p.body,
            delivery: p.delivery,
            updatedAt: new Date().toISOString()
        }));
        return await db.seedControlPlane(entries);
    }

    /**
     * Resolves a protocol by name or path.
     * Returns the body (for inline) or materialized absolute path (for materialize).
     */
    public static async resolveProtocol(
        rawName: string,
        workspaceRoot?: string,
        kanbanDb?: KanbanDatabase
    ): Promise<ResolvedProtocol | null> {
        if (!rawName || typeof rawName !== "string") {
            return null;
        }

        const name = this.normalizeProtocolName(rawName);
        if (!name) {
            return null;
        }

        // improve-remote-plan was deleted outright per architectural decision
        if (name === "improve-remote-plan") {
            return null;
        }

        let entry: ControlPlaneEntry | null = null;
        if (kanbanDb) {
            try {
                entry = await kanbanDb.getControlPlaneEntry(name, "protocol");
            } catch {}
        }
        if (!entry && workspaceRoot) {
            try {
                const db = KanbanDatabase.forWorkspace(workspaceRoot);
                if (await db.ensureReady()) {
                    entry = await db.getControlPlaneEntry(name, "protocol");
                }
            } catch {}
        }

        const bundled = BUNDLED_PROTOCOLS[name];
        if (!entry && !bundled) {
            return null;
        }

        // `bundled` may be undefined here: line 71 returns early only when BOTH entry
        // and bundled are missing, so a control_plane row with an empty body and no
        // bundled counterpart (a retired protocol still in the table, or an
        // override-only row) reached `bundled.body` and threw a TypeError instead of
        // returning null.
        // A workspace file outranks the registry for the two projected survivors.
        // Until the planner defaults became bare names the prompt literally said
        // `Read .agents/protocols/improve-plan/SKILL.md`, so an operator's edit to
        // that file WAS what the planner read. Resolving the name to the shipped
        // body instead drops that edit with no signal — a default that behaves
        // exactly like a configured value, which this repo bans on config reads.
        // `filesPreserved` in ClaudeCodeMirrorService exists to keep the edited
        // file alive; this is the read side of that guarantee.
        let workspaceBody: string | undefined;
        if (workspaceRoot && WORKSPACE_PROJECTED_PROTOCOLS.has(name)) {
            try {
                const diskBody = fs.readFileSync(
                    path.join(workspaceRoot, ".agents", "protocols", name, "SKILL.md"),
                    "utf8"
                );
                if (diskBody.trim()) {
                    workspaceBody = diskBody;
                }
            } catch {
                // Not projected in this workspace — the registry answers.
            }
        }

        const override = entry?.overrideBody ?? entry?.workspaceOverride;
        let body: string | undefined;
        let source: ProtocolSource;
        if (workspaceBody !== undefined) {
            body = workspaceBody;
            source = "workspace-file";
        } else if (override) {
            body = override;
            source = "control-plane-override";
        } else if (entry?.body) {
            body = entry.body;
            source = "control-plane";
        } else {
            body = bundled?.body;
            source = "bundled";
        }
        if (!body) {
            return null;
        }
        const delivery: "inline" | "materialize" = entry?.delivery || bundled?.delivery || "materialize";
        // The hash keys the materialise cache, so it must describe the body that
        // was actually chosen — a workspace edit cached under the registry's hash
        // would serve the shipped text from a stale cache entry.
        const contentHash = source === "workspace-file"
            ? crypto.createHash("sha256").update(body, "utf8").digest("hex")
            : (entry?.contentHash || bundled?.contentHash || crypto.createHash("sha256").update(body, "utf8").digest("hex"));

        // History of the two-name survivor case (improve-plan / improve-feature):
        // it once returned an on-disk `path` no caller consumed and was deleted,
        // then the planner workflow fields moved from path literals to the bare
        // names, which resolve here and inline the body. What the deletion lost
        // was the *content* precedence, not the path: an operator's edited
        // `.agents/protocols/<name>/SKILL.md` stopped being what the planner read.
        // The `workspaceBody` branch above restores that precedence — body, not
        // path — and `source` records which store answered. A path-shaped config
        // value still goes through renderPlannerWorkflowRef's path branch
        // (literal "Read <path>"), never through resolveProtocol.

        if (delivery === "inline") {
            return {
                name,
                body,
                delivery: "inline",
                source
            };
        }

        // Materialize to cache: ~/.switchboard/cache/protocols/<contentHash>/SKILL.md
        let materializedPath: string | undefined;
        try {
            const cacheDir = stateFile("cache", "protocols", contentHash);
            materializedPath = path.join(cacheDir, "SKILL.md");
            if (!fs.existsSync(materializedPath)) {
                fs.mkdirSync(cacheDir, { recursive: true });
                const tmpFile = path.join(cacheDir, `SKILL.md.tmp.${process.pid}.${Date.now()}`);
                fs.writeFileSync(tmpFile, body, "utf8");
                fs.renameSync(tmpFile, materializedPath);
            }
        } catch {
            // Fallback for sandboxed test environments
            if (workspaceRoot) {
                const fallbackDir = path.join(workspaceRoot, ".switchboard", "cache", "protocols", contentHash);
                materializedPath = path.join(fallbackDir, "SKILL.md");
                if (!fs.existsSync(materializedPath)) {
                    fs.mkdirSync(fallbackDir, { recursive: true });
                    fs.writeFileSync(materializedPath, body, "utf8");
                }
            }
        }

        return {
            name,
            body,
            path: materializedPath,
            delivery: "materialize",
            source
        };
    }

    /**
     * Normalizes a protocol path or identifier to its base name.
     * Rejects path traversal attempts.
     */
    public static normalizeProtocolName(p: string): string | null {
        if (!p || typeof p !== "string") return null;
        const trimmed = p.trim();

        // Traversal guard
        if (trimmed.includes("..") || trimmed.includes("\\")) {
            return null;
        }

        let m = trimmed.match(/(?:\.agents|\.switchboard)\/protocols\/([^/]+)(?:\/SKILL\.md|\.md)?$/);
        if (m) return m[1];

        m = trimmed.match(/^protocols\/([^/]+)(?:\/SKILL\.md|\.md)?$/);
        if (m) return m[1];

        if (!trimmed.includes("/")) {
            return trimmed.replace(/\.md$/, "");
        }

        return null;
    }
}
