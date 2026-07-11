// "Set up Cowork" — exports the self-contained switchboard-cowork skill as a .zip
// the user uploads into Claude Cowork (Settings > Capabilities).
//
// The skill source lives OUTSIDE the scanned .agents/skills/ tree
// (src/cowork-skill/switchboard-cowork/SKILL.md) so it never clutters local/cloud
// slash menus. The zip is generated from that single source at button-press time so
// it can't drift. The zip has the switchboard-cowork/ skill directory at its root,
// matching the Agent Skills spec (upload a .zip with the skill dir at the zip root,
// then enable it in Settings > Capabilities).
//
// The skill bundles the switchboard-mcp transport wiring (the local stdio MCP server
// Cowork runs to reach LocalApiServer). No MCP server change — this is a docs +
// packaging layer on top of the existing transport.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import AdmZip from 'adm-zip';

/** Directory inside the extension bundle holding the skill (relative to __dirname).
 *  Webpack's CopyPlugin copies src/cowork-skill/switchboard-cowork → dist/cowork-skill/switchboard-cowork. */
const COWORK_SKILL_SOURCE_DIR = path.join(__dirname, 'cowork-skill', 'switchboard-cowork');

export interface CoworkExportResult {
    ok: boolean;
    zipPath?: string;
    message: string;
}

/**
 * Generate the switchboard-cowork skill .zip from the in-repo source and prompt the
 * user for a save location. The zip root contains the switchboard-cowork/ directory
 * (with SKILL.md inside), matching the Agent Skills upload contract.
 */
export async function exportCoworkSkill(): Promise<CoworkExportResult> {
    const sourceDir = COWORK_SKILL_SOURCE_DIR;
    const skillMdPath = path.join(sourceDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
        return {
            ok: false,
            message: `switchboard-cowork skill source not found at ${sourceDir}. The extension install may be incomplete.`
        };
    }

    // Validate frontmatter constraints before zipping.
    const raw = fs.readFileSync(skillMdPath, 'utf8');
    const validation = validateSkillFrontmatter(raw, 'switchboard-cowork');
    if (!validation.ok) {
        return { ok: false, message: validation.error! };
    }

    // Prompt the user for a save location.
    const defaultName = 'switchboard-cowork.zip';
    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
        filters: { 'Zip archive': ['zip'] },
        title: 'Save Switchboard Cowork skill bundle'
    });
    if (!uri) {
        return { ok: false, message: 'Export cancelled.' };
    }
    const zipPath = uri.fsPath;

    try {
        const zip = new AdmZip();
        // Add the skill directory at the zip root: switchboard-cowork/SKILL.md
        // addLocalFolder adds the folder's contents under the folder name at the root.
        zip.addLocalFolder(sourceDir, 'switchboard-cowork');
        zip.writeZip(zipPath);

        const message = `Switchboard Cowork skill bundle saved to ${zipPath}. Upload it in Cowork's Settings > Capabilities to enable.`;
        vscode.window.showInformationMessage(message, 'Reveal File').then(action => {
            if (action === 'Reveal File') {
                vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(zipPath));
            }
        });
        return { ok: true, zipPath, message };
    } catch (e: any) {
        const msg = `Failed to write Cowork skill bundle: ${e.message || e}`;
        vscode.window.showErrorMessage(msg);
        return { ok: false, message: msg };
    }
}

/** Validate the Agent Skills spec frontmatter constraints (name + description ≤200). */
function validateSkillFrontmatter(content: string, expectedDirName: string): { ok: boolean; error?: string } {
    const normalized = content.replace(/^\ufeff/, '');
    if (!normalized.startsWith('---')) {
        return { ok: false, error: 'switchboard-cowork SKILL.md is missing frontmatter.' };
    }
    const end = normalized.indexOf('\n---', 3);
    if (end === -1) {
        return { ok: false, error: 'switchboard-cowork SKILL.md has unterminated frontmatter.' };
    }
    const fmBlock = normalized.substring(3, end);
    let name: string | undefined;
    let description: string | undefined;
    for (const rawLine of fmBlock.split('\n')) {
        const line = rawLine.trim();
        const nameMatch = line.match(/^name:\s*(.+)$/);
        const descMatch = line.match(/^description:\s*(.+)$/);
        if (nameMatch) name = stripQuotes(nameMatch[1].trim());
        if (descMatch) description = stripQuotes(descMatch[1].trim());
    }
    if (!name) {
        return { ok: false, error: 'switchboard-cowork SKILL.md frontmatter is missing `name`.' };
    }
    if (name !== expectedDirName) {
        return { ok: false, error: `switchboard-cowork SKILL.md name "${name}" must match the directory name "${expectedDirName}".` };
    }
    if (!description) {
        return { ok: false, error: 'switchboard-cowork SKILL.md frontmatter is missing `description`.' };
    }
    // Claude.ai/Cowork cap description at 200 chars (the spec allows 1024).
    if (description.length > 200) {
        return { ok: false, error: `switchboard-cowork description is ${description.length} chars; Cowork caps it at 200.` };
    }
    return { ok: true };
}

function stripQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.substring(1, value.length - 1);
    }
    return value;
}
