# agent-auto-resume (aar)

Daemon-based auto-resume CLI tool for Claude Code, OpenAI Codex CLI, and Google Antigravity CLI.

---

## What it does

`agent-auto-resume` (command: `aar`) acts as a wrapper and watcher daemon for popular AI agent command-line interfaces. 
When an agent stops due to a provider-declared usage limit, rate limit, or quota exhaustion, `aar` detects the limit pattern, extracts the reset/retry time, waits until that time in a daemon background worker, and automatically resumes the session safely.

## What it does not do

**This tool does not bypass, evade, or spoof usage limits.**
It does not rotate API keys, switch accounts, or trick provider servers. It simply respects the provider-declared reset time by waiting locally, and then automatically resumes the existing session on your machine once the limit resets.

---

## Why daemon mode?

Running AI agents can take hours to complete complex tasks. If they hit a limit while you are away (or asleep), you lose valuable time. 
With `agent-auto-resume` running in the background, you don't need to manually check the terminal or click "resume" when the quota resets; it will automatically trigger the resume command when the time comes.

---

## Installation

```bash
npm install -g agent-auto-resume
```

---

## Quick start

1. Run the interactive setup:
   ```bash
   aar setup
   ```
2. Start the background daemon:
   ```bash
   aar daemon start
   ```
3. Run your AI agents as usual:
   ```bash
   claude
   codex
   agy
   ```

---

## Architecture & Modes

`agent-auto-resume` operates in three cooperative modes:

### 1. Managed Command Mode (`aar managed`)
When you launch an agent, it is wrapped inside a Pseudoterminal (PTY) runner. 
- It captures all stdout/stderr, pipe it to your terminal, and scans it in real-time for limit patterns.
- When a limit occurs, it captures the reset time, saves the session state, and safely kills the PTY process.

### 2. Shell Shim Mode
Installed via `aar setup`. It adds shell functions (in `~/.zshrc`, `~/.bashrc`, or `~/.config/fish/config.fish`) so that calling `claude`, `codex`, or `agy` automatically runs them under `aar managed`.
> [!NOTE]
> `agent-auto-resume` works best after `aar setup`, which installs shell functions so future `claude`, `codex`, and `agy` sessions are launched in managed mode.

### 3. Watcher Daemon Mode (`aar daemon`)
A background process that:
- Periodically scans `~/.agent-auto-resume/sessions/` for sessions in `waiting_limit_reset`.
- Calculates the wait time (reset time + `bufferSeconds`).
- Triggers the resume command via a background PTY when the wait expires.
- (Optional) Watches local transcript directories and `tmux` panes.

---

## Provider Support Matrix

| Provider | Command | Managed mode | Daemon resume | Transcript watcher | tmux watcher | Headless resume |
|---|---|---:|---:|---:|---:|---:|
| Claude Code | `claude` | Yes | Yes | Experimental | Experimental | Partial |
| Codex CLI | `codex` | Yes | Yes | Experimental | Experimental | Yes |
| Google Antigravity CLI | `agy` | Yes | Yes | No | Experimental | Experimental |

---

## Details on Provider Support

### Claude Code (`claude`)
- **Detection**: Matches patterns like `5-hour limit reached`, `usage limit reached`, or `Your limit will reset at YYYY-MM-DD...`
- **Resume Strategy**: Resumes via PTY input (`continue\n`) if running, or executes `claude --continue`.
- **Transcript Watcher**: Watches `~/.claude/projects` for session events.

### Codex CLI and Codex Desktop (`codex`)
- **Detection**: Uses Codex error events from the session transcript and extracts a reset time when present.
- **Resume Strategy**: Resumes a transcript-observed session by its exact Codex thread ID using `codex exec resume <SESSION_ID> "<CODEX_SAFE_RESUME_PROMPT>"`; it never selects a GUI session with `--last`.
- **Transcript Watcher**: Watches `~/.codex/sessions` and reads the thread ID and working directory from `session_meta`.
- **Codex Desktop**: AAR observes local Codex Desktop transcripts and runs continuation through the Codex CLI in the background. It does not modify `ChatGPT.app`, and the GUI may not reflect background progress while open.

### Google Antigravity CLI (`agy`)
- **Detection**: Matches common Antigravity quota messages.
- **Resume Strategy**: Queries `agy --help` dynamically to find available subcommands (`agy resume --last`, `agy continue`, `agy c`, `agy conversation --last`) and falls back to `agy` with an interactive safe resume prompt.
- **Status**: **Experimental**.
> [!WARNING]
> Antigravity CLI support is experimental because its resume behavior may change across versions. If Antigravity requires workspace trust, tool permissions, or review confirmations, `agent-auto-resume` does not automatically bypass them. The user may still need to approve them manually.

---

## Watcher Extras (Experimental)

### tmux watcher
By enabling the `tmux` watcher (via `--tmux` flag or config), the daemon scans open tmux panes. 
It captures the screen content, parses it for limit text, and sends keypresses to resume when the time comes.
- Enable via config: `"tmux": { "enabled": true }`
- Run daemon: `aar daemon start --tmux`

### transcript watcher
The daemon can watch logs written to `~/.claude/projects` or `~/.codex/sessions` and record limit-reached events in the background, even if the session was not started inside `aar managed`.
- **Note**: It cannot reliably read arbitrary terminal output from sessions that were started before setup unless tmux watcher or transcript watcher can detect them.

---

## Commands Reference

### setup
```bash
aar setup
```
Initializes `~/.agent-auto-resume/`, generates default `config.json`, and guides shell configuration.
- `--shell <zsh|bash|fish>`: Specific shell configuration.
- `--no-shell-modify`: Setup directories but do not edit rc files.
- `--print-shell-snippet`: Only output the snippet to add.

### daemon
```bash
aar daemon start   # Start background daemon
aar daemon stop    # Stop background daemon
aar daemon restart # Restart daemon
aar daemon status  # View daemon PID status
aar daemon logs    # Print daemon log output
```

### status
```bash
aar status
aar status --json
```
Prints the daemon status and a list of currently waiting sessions, including time remaining.

### sessions
```bash
aar sessions
aar sessions --json
aar gui-sessions
aar codex-check
aar cancel-session <session-id>
```
`aar gui-sessions` lists Codex Desktop sessions where AAR detected a limit. `aar codex-check` checks local monitoring configuration and Codex CLI resume help without making an API request. `aar cancel-session` disables automatic continuation for a waiting or failed session.

### recover
```bash
aar recover
aar recover --last
aar recover --id <session-id>
```
Manually triggers recovery for a failed or waiting session in the background.
For a Codex transcript session, use the ID printed by `aar gui-sessions`; AAR passes that exact thread ID to Codex CLI.

### retry-now
```bash
aar retry-now --id <session-id>
aar retry-now --last
aar retry-now --force
```
Immediately resumes a session, bypassing the waiting time. If the reset time hasn't passed, it will warn you unless `--force` is provided (not recommended).

### integrate
```bash
aar integrate <codex|antigravity|all>
```
Integrates supported application binaries. Codex Desktop is observed through its transcript files instead; `aar integrate codex` intentionally does not modify any installed Codex or ChatGPT application files.

### unintegrate
```bash
aar unintegrate <codex|antigravity|all>
```
Restores the original desktop application binaries to their default state.

---

## Safety & Security Design

1. **No Evading Limits**: Does not evade limits or abuse providers. Respects declared wait times.
2. **Safe Resume Prompts**: When resuming, `aar` passes instruction prompts to inspect repository states (`git status`, `git diff`) and resume only the remaining, incomplete parts.
3. **No Automatic Tool/Trust Approval**: Does not bypass "Workspace Trust" or "Tool Confirmations" (like file writes). These must still be approved by the user when required.
4. **Environment Warning**: Since `aar` runs commands in background PTYs, make sure your environment is secure. Do not leave sensitive files uncommitted.

---

## License

MIT License. See [LICENSE](file:///Volumes/MOVESPEED/Documents/GitHub/agent-auto-resume/LICENSE) for details.
