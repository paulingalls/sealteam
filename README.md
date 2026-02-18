# SealTeam

A Bun-based CLI that takes a user goal and dynamically creates a team of Claude AI agents to achieve it. The goal is general-purpose — build software, write documents, plan a trip, or anything else.

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Valkey](https://valkey.io) or Redis running locally (default: `valkey://localhost:6379`)
- An [Anthropic API key](https://console.anthropic.com/)

## Quick Start

```bash
bun install

export ANTHROPIC_API_KEY="sk-ant-..."

# Start Valkey (if not already running)
valkey-server &

# Run SealTeam
bun run sealteam "Build a REST API for a todo app with authentication"
```

## Install as a Standalone Executable

You can compile SealTeam into a self-contained executable and add it to your PATH so it can be run from any directory:

```bash
bun build --compile src/index.ts --outfile sealteam

# Move it somewhere on your PATH
sudo mv sealteam /usr/local/bin/

# Now run from anywhere
sealteam "Build a REST API for a todo app with authentication"
```

The compiled binary bundles Bun and all dependencies into a single file — no runtime installation required on the target machine.

To cross-compile for other platforms:

```bash
bun build --compile src/index.ts --target=bun-linux-x64 --outfile sealteam-linux
bun build --compile src/index.ts --target=bun-darwin-arm64 --outfile sealteam-macos
bun build --compile src/index.ts --target=bun-windows-x64 --outfile sealteam.exe
```

## How It Works

1. **Main process** parses your goal and spawns a team leader agent ("Bob")
2. **Bob** decomposes the goal into requirements, plans the team, and spawns worker agents
3. **Each agent** runs an autonomous life loop: Plan → Execute → Reflect
4. Agents communicate via Valkey message queues and collaborate through a shared git workspace
5. When all work is complete, a summary report is printed and the workspace contains the deliverables

### Agent Life Loop

Every agent (leader and workers) runs the same `life-loop.ts` code with different configuration. Each iteration uses an adaptive strategy:

- **Standard path** (3 API calls) — Plan, Execute with tools, Reflect. Used for complex or ambiguous tasks.
- **Fast path** (2 API calls) — Plan+Execute combined, then Reflect. Triggered when previous iteration was simple (single file write, simple command, etc).

Agents self-recover from errors (up to 3 attempts) before escalating to the team leader.

### Built-in Tools

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands via `Bun.$` |
| `read-file` | Read file contents with `Bun.file()` |
| `write-file` | Write/create files with `Bun.write()` |
| `web-search` | Web search via Claude API server-side tool |
| `web-fetch` | Fetch URLs via Claude API server-side tool |
| `spawn-agent` | (Leader only) Spawn a new agent subprocess |
| `send-message` | Send messages to agents or broadcast to the team |
| `git` | Execute git commands in the agent's working directory |

Agents can also create **dynamic tools** at runtime, which go through a validation pipeline (schema check, security scan, test coverage) before activation.

## Usage

```
bun run sealteam [options] "<goal>"
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--workers <n>` | 6 | Maximum worker agents (max: 12) |
| `--budget <n>` | 100000 | Token budget per agent |
| `--max-iterations <n>` | 50 | Max loop iterations per agent |
| `--workspace <path>` | ./workspace | Output workspace directory |
| `--valkey-url <url>` | valkey://localhost:6379 | Valkey connection URL |
| `--leader-model <model>` | claude-opus-4-6 | Model for team leader |
| `--team-model <model>` | claude-sonnet-4-6 | Model for worker agents |
| `--resume-from <path>` | | Resume from a previous session workspace |

### Environment Variables

All options can also be set via environment variables:

| Variable | Corresponding Option |
|----------|---------------------|
| `ANTHROPIC_API_KEY` | **(required)** Claude API key |
| `VALKEY_URL` | `--valkey-url` |
| `SEALTEAM_WORKSPACE` | `--workspace` |
| `SEALTEAM_MAX_AGENTS` | `--workers` |
| `SEALTEAM_DEFAULT_BUDGET` | `--budget` |
| `SEALTEAM_DEFAULT_MAX_ITERATIONS` | `--max-iterations` |
| `SEALTEAM_LEADER_MODEL` | `--leader-model` |
| `SEALTEAM_TEAM_MODEL` | `--team-model` |

CLI arguments take precedence over environment variables.

## Workspace Output

```
workspace/
  session.json              # Session metadata and agent status
  logs/                     # Per-agent log files
    bob.log
    agent-alice.log
  bob/                      # Leader's git repo (main branch) — contains the deliverables
    state/                  # Iteration state files (plan/execute/reflect per iteration)
    src/                    # Work product
  agent-alice/              # Worker clone (agent/alice branch)
    state/
    src/
  tools/                    # Dynamic tools (if any were created)
```

## Architecture

```
src/
  index.ts              # CLI entry point, main process orchestration
  life-loop.ts          # Core agent loop (plan/execute/reflect)
  claude-client.ts      # Claude API wrapper with retry and token tracking
  message-queue.ts      # Valkey-backed message queues with retry
  tool-registry.ts      # Tool management (built-in + dynamic with validation)
  state-manager.ts      # Agent state persistence and crash recovery
  git-manager.ts        # Git operations (init, clone, branch, commit, merge)
  context-manager.ts    # Context window tracking and compaction
  prompts.ts            # System prompts for plan/execute/reflect steps
  logger.ts             # ANSI color-coded structured logging
  types.ts              # Shared TypeScript interfaces
  tools/                # Built-in tool implementations
    bash.ts, read-file.ts, write-file.ts, web-search.ts,
    web-fetch.ts, spawn-agent.ts, send-message.ts, git.ts
```

## Testing

```bash
bun test
```

195 tests across 17 files covering all modules.

## Crash Recovery

- **Agent crashes** — The main process detects subprocess exits, reads the agent's last completed state, and re-spawns with `RESUME_FROM` to continue from where it left off.
- **Main process crashes** — Restart with `--resume-from <workspace>` to recover the session from `session.json`, re-spawn dead agents, and resume monitoring.
- **Valkey restarts** — Agent state files on disk are the source of truth; agents re-assess from disk rather than relying on queue replay.
