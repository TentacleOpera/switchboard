# Running Switchboard Standalone inside WSL

Switchboard's tmux bridge (dispatching prompts into tmux panes the server does
not own) is a Linux feature — tmux does not exist on native Windows, and a
Windows-host Node process cannot reach a tmux server inside WSL across the
socket boundary. The clean path is to run Switchboard itself inside WSL: it is
Linux talking to Linux, the bridge works as designed, and WSL2's automatic
localhost forwarding lets a Windows browser reach the board with no extra
configuration.

This guide covers that path end-to-end.

## 1. Prerequisites

### WSL2

Install WSL2 from a Windows PowerShell (run as Administrator):

```powershell
wsl --install
```

This installs WSL2 and a default Ubuntu distribution. Reboot when prompted.
Confirm the version from inside the WSL shell:

```bash
cat /proc/version
# A WSL2 string contains "microsoft-standard", e.g.:
# Linux version 5.15.153.1-microsoft-standard-WSL2 ...
```

If the string contains `Microsoft` but not `microsoft-standard`, you are on
WSL1. WSL1 works for tmux (a user-space program) but may need a node-pty
rebuild; WSL2 is recommended. Convert with `wsl --set-version <distro> 2` from
PowerShell.

### Node.js (inside WSL)

Install Node inside WSL — do not use the Windows Node from `/mnt/c/`. The
easiest path is nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart shell, then:
nvm install --lts
```

Or install the system package:

```bash
sudo apt update && sudo apt install -y nodejs npm
```

### tmux (inside WSL)

```bash
sudo apt install -y tmux
```

### Build tools (for native modules)

If a native module needs to rebuild (e.g. node-pty on WSL1), install
`build-essential`:

```bash
sudo apt install -y build-essential
```

## 2. Workspace setup

Two options, in order of preference:

### Clone inside WSL (recommended)

```bash
mkdir -p ~/projects && cd ~/projects
git clone <your-switchboard-repo-url> switchboard
cd switchboard
```

The WSL2 filesystem (`~/...`, `/home/...`) is an ext4 disk and gives full I/O
performance.

### Access the Windows filesystem via /mnt/c

```bash
cd /mnt/c/Users/<you>/projects/switchboard
```

This works, but the 9p bridge that serves `/mnt/c` is much slower for heavy
file I/O (node_modules installs, git operations over many files). Prefer
cloning inside WSL.

## 3. Starting Switchboard

From inside WSL, in the workspace root:

```bash
npx switchboard local
```

Switchboard binds `127.0.0.1` and prints a URL such as
`http://switchboard.localhost:<port>`. WSL2's automatic localhost forwarding
maps Windows `localhost:<port>` to WSL's `127.0.0.1:<port>`, so a Windows
browser reaches the board by opening `http://localhost:<port>` (or the printed
`switchboard.localhost` name, which the browser resolves locally).

If `cmd.exe` interop is enabled (the default), Switchboard opens the Windows
browser automatically. If interop is disabled and `wslview` is not installed,
the URL is printed in the log — open it manually.

## 4. Enabling tmux

Switchboard's tmux dispatch is off by default. Enable it in
`.switchboard/config.json`:

```json
{
  "terminal": {
    "tmux": {
      "enabled": true
    }
  }
}
```

Or use the Setup panel in the board UI.

## 5. Adopting panes

Start tmux inside WSL, split panes, and launch your agent CLIs in them:

```bash
tmux new -s agents
# Ctrl+B % to split, Ctrl+B " to split horizontally
# in each pane: npx switchboard ... (or your agent CLI)
```

Adopt panes via the board UI, or from the CLI:

```bash
npx switchboard verb tmuxAdoptPane --session agents --pane <index> --seat <terminal-name>
```

Once adopted, `npx switchboard dispatch <planId>` lands the prompt in the
adopted pane.

## 6. VS Code integration (optional)

The VS Code WSL extension runs the extension host inside WSL, so the extension
host can also reach the tmux bridge. This guide's scope is standalone; the
extension path is the same once WSL is the active remote.

## 7. Troubleshooting

### `cmd.exe: command not found` (browser does not open)

WSL interop is disabled. Check `/etc/wsl.conf`:

```ini
[interop]
enabled = false
```

Either re-enable interop (`enabled = true`, then `wsl.exe --shutdown` from
PowerShell and restart), or install `wslview` (from the `wslu` package) and
Switchboard will fall back to it automatically:

```bash
sudo apt install -y wslu
```

With neither available, Switchboard prints the URL in the log — open it
manually in your Windows browser.

### Port not forwarding (Windows browser cannot reach the board)

WSL2's localhost forwarding occasionally stalls. From PowerShell:

```powershell
wsl.exe --shutdown
```

Then restart WSL and re-run `npx switchboard local`. If the issue persists,
check that no firewall is blocking the port and that the WSL2 virtual switch is
healthy (`wsl --status`).

### node-pty build failures (WSL1)

WSL1 uses a translation layer, not a real Linux kernel, so prebuilt binaries
may not match. Install `build-essential` (above) so the build can compile from
source. WSL2 does not have this issue.

### `tmux: command not found`

tmux is not installed inside WSL:

```bash
sudo apt install -y tmux
```

### Board loads but dispatch fails

Confirm tmux is running (`tmux ls`) and that the target pane was adopted
(check the board UI or `npx switchboard verb tmuxListPanes`). The pane must be
in the same tmux server Switchboard is talking to — inside WSL, that is the
WSL tmux, not any Windows-side terminal.
