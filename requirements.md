# SealTeam: AI Agent Team CLI

## Overview

A Bun-based command-line application that takes a user goal as input and dynamically creates a team of Claude-based AI agents to achieve it. The goal is general-purpose — it could be building software, writing a document, planning a trip, creating a video script, or anything else.

```
bun run sealteam "Build a REST API for a todo app with authentication"
```

## Architecture

### Main Process (Entry Point)

1. Parse the user goal and options from CLI arguments
2. Initialize a Valkey connection (used for all message queues)
3. Initialize a git repository in the team leader's workspace subdirectory
4. Spawn the team leader agent ("Bob") as a subprocess via `Bun.spawn()`
5. Send the user goal to Bob's personal message queue
6. Wait for an "all-complete" message on the main process queue
7. Print a summary report and references to all created resources, then exit

**CLI Interface:**
```
bun run sealteam [options] "<goal>"

Options:
  --workers <n>         Maximum number of worker agents (default: 6, max: 12)
  --budget <n>          Default token budget per agent (default: 100000)
  --max-iterations <n>  Default max iterations per agent (default: 50)
  --workspace <path>    Output workspace directory (default: ./workspace)
```

### Life Loop (Core Agent Loop)

Every agent — including the team leader — runs the same `life-loop.ts` code, parameterized by configuration passed at spawn time. Each life loop runs as its own `Bun.spawn()` subprocess with full process isolation.

**Agent Configuration (passed via CLI args or env to subprocess):**
- `name` — unique identifier, used for message queue addressing
- `role` — description of what this agent does (e.g., "backend engineer", "technical writer")
- `purpose` — the completion condition; when met, the agent exits its loop
- `tools` — list of tool names this agent is allowed to use
- `model` — Claude model to use (team leader uses `claude-opus-4-20250514`, teammates use `claude-sonnet-4-20250514`)
- `tokenBudget` — maximum tokens this agent may consume before forced termination
- `maxIterations` — maximum loop iterations before forced termination (default: 50)

**Each loop iteration uses an adaptive call strategy:**

#### Standard Path (3 calls)

Used for complex or ambiguous work where planning and reflection benefit from separation.

1. **Plan** — Given the current message and agent context, decide what to do this iteration. The system prompt includes the agent's role, purpose, available tools, and recent state. Output: a structured plan with an `complexity` field (`"simple"` or `"complex"`).

2. **Execute** — Carry out the plan using the available tools (bash, file I/O, web search, etc.). The Claude call is given the plan and tool definitions. Output: execution results including any tool call results.

3. **Reflect** — Evaluate the execution results. Determine one of:
   - **Continue** — Post a message to own queue for the next iteration
   - **Complete** — The purpose has been fulfilled; signal the team leader and exit
   - **Error/Stuck** — Attempt self-recovery. After 3 failed self-recovery attempts, escalate to the team leader via message queue

#### Fast Path (2 calls — plan+execute collapsed)

When the Plan step outputs `complexity: "simple"`, the plan and execute phases are collapsed into a single API call on the *next* iteration. This is triggered by including the following guidance in the Plan system prompt:

> If the next step is straightforward — a single file write, a simple shell command, a short message — set `complexity` to `"simple"`. The system will collapse your plan and execution into a single call next iteration to save time and tokens. Reserve `"complex"` for multi-step operations, ambiguous requirements, or anything that benefits from a separate planning phase.

In fast-path mode, the agent makes one call that produces both the plan and executes it (the system prompt instructs Claude to state its intent, then act on it in the same response using tool calls), followed by the Reflect call. The Reflect step still runs separately to preserve the agent's ability to self-correct.

**When fast path is used:**
- Single file read/write operations
- Simple git commands (commit, push, status)
- Sending a message to another agent
- Running a single, well-defined shell command

**When standard path is required:**
- Multi-file changes or refactors
- Ambiguous or underspecified requirements
- Tasks requiring research or exploration first
- Anything the agent hasn't done before in this session

**State Persistence & Crash Recovery:** Each step writes its output to a JSON file in the agent's working directory: `{workspace}/{agent-name}/state/iteration-{n}-{step}.json` (where step is `plan`, `execute`, `plan-execute`, or `reflect`). This enables crash recovery at two levels:

- **Agent-level recovery:** If an agent subprocess dies (OOM, network error, unexpected crash), the main process detects the exit via the `Bun.spawn()` process handle. It reads the agent's state directory, finds the last completed step, and re-spawns the agent with a `--resume-from <iteration>-<step>` flag. The life loop skips to the next step after the last completed one. If the crash occurred mid-API-call (no state file written for that step), the entire iteration is retried.

- **Main process recovery:** The main process writes a `{workspace}/session.json` file on startup and updates it as agents are spawned and complete. This file records all active agent configurations and their status. If the main process itself crashes and is restarted, it reads `session.json`, checks which agents are still running (via PID checks), and re-spawns any that died. Agents that already completed (state directory contains a final `reflect.json` with `decision: "complete"`) are not re-spawned.

- **Valkey durability:** Message queues are ephemeral — if Valkey restarts, in-flight messages are lost. This is acceptable because agent state files are the source of truth. On recovery, agents re-assess their state from disk rather than relying on queue replay.

### Message Queue System (Valkey-backed)

Use `Bun.redis` (wire-compatible with Valkey) for all inter-agent communication.

**Queue Types:**
- **Personal queue** (`queue:{agent-name}`) — Messages addressed directly to a specific agent. Each agent polls its personal queue at the start of each loop iteration.
- **Shared queue (fan-out)** — Team-wide announcements (e.g., "API schema finalized", "main branch updated"). There is no single shared list. Instead, the `send-message` tool implements fan-out: when a message is sent to `"shared"`, the message queue module reads the active agent list from `{workspace}/session.json` and pushes a copy of the message to every agent's personal queue (excluding the sender). This ensures each agent receives the message via the same BRPOP mechanism it already uses, avoiding the need for Pub/Sub or duplicate consumption issues.
- **Main process queue** (`queue:main`) — The main process listens here for the "all-complete" signal from the team leader.

**Message Format:**
```typescript
interface QueueMessage {
  id: string;           // unique message ID
  from: string;         // sender agent name
  to: string;           // recipient agent name, "shared", or "main"
  type: "task" | "status" | "review" | "complete" | "error" | "cancel" | "all-complete";
  content: string;      // message body
  timestamp: number;
}
```

**Queue Behavior:**
- Agents check their personal queue at the start of each loop iteration (all messages — direct and fan-out shared — arrive here)
- BRPOP is called with a 5-second timeout. If no message is received, the agent runs an idle cycle: check for cancel messages via a non-blocking RPOP, verify state files are consistent, and log a heartbeat. After 30 consecutive idle cycles (2.5 minutes) with no messages and no self-queued work, the agent sends a status message to the leader asking for direction.
- If an inter-agent message arrives (e.g., a review request), the agent handles it within its reflect step, then returns to its own work by pulling the next message from its personal queue
- Messages are acknowledged after processing (Valkey BRPOP / LPUSH pattern)

### Context Management & Compaction

Agents will accumulate tool results and conversation history across iterations, eventually hitting context window limits. The system uses a tiered compaction strategy to manage this.

**Compaction Triggers:**
- **Soft limit (70% of context window):** Trigger background compaction on the next reflect step
- **Hard limit (90% of context window):** Trigger immediate compaction before the next API call

**Compaction Strategy:**

1. **Tool Result Trimming** — Large tool outputs (e.g., long bash stdout, full file contents) are truncated to their first and last 200 lines with a summary line in the middle: `"[... {n} lines omitted ...]"`. This is applied to all tool results older than the last 3 iterations.

2. **Iteration Summarization** — Completed iterations older than the last 5 are replaced with a structured summary:
   ```typescript
   interface IterationSummary {
     iteration: number;
     plan: string;        // 1-2 sentence summary of intent
     outcome: string;     // 1-2 sentence summary of result
     filesChanged: string[]; // list of files created/modified
     decisions: string[]; // key decisions made (for context continuity)
   }
   ```
   The summary is generated by the Reflect step as part of its normal output — each Reflect call produces both a decision (continue/complete/error) and a `summary` field that can be used for compaction later.

3. **Rolling Context Window** — The agent's context for each API call is assembled from:
   - System prompt (role, purpose, tools) — always included in full
   - Compacted summaries of old iterations — compact representation
   - Full detail of the last 5 iterations — preserved verbatim
   - Current queue messages — always included in full

**Token Tracking:** The `claude-client.ts` wrapper tracks cumulative input and output tokens per agent. Token counts from API responses are recorded in each iteration's state file and used to calculate context window utilization.

### Team Leader ("Bob")

The team leader runs the same life loop code but with a specialized role and purpose.

**Role:** Break down the user goal into requirements, identify what kinds of agents are needed, create and manage the team.

**Leader-specific behavior (driven by its system prompt, not different code):**

1. **Goal Decomposition** — Analyze the user goal and break it into discrete requirements
2. **Team Planning** — Determine what agent roles are needed (up to the configured `--workers` limit)
3. **Agent Spawning** — For each teammate, call the `spawn-agent` tool with configuration (name, role, purpose, tools, model, budget)
4. **PR Review** — When agents complete work and submit PRs, the leader reviews them. Merges good PRs or sends feedback messages to the agent requesting changes.
5. **Dynamic Tool Creation** — If existing tools are insufficient, create new tool modules (see Dynamic Tool Creation section)
6. **Completion Monitoring** — As teammates complete, assess overall progress. May create additional agents if gaps are identified (within the `--workers` limit).
7. **Final Report** — Once all work is done, compile a summary report and send "all-complete" to the main process queue

### Workspace & Git Workflow

The workspace directory is organized so that the root contains only operational metadata (logs, agent state), while each agent — including the leader — owns a dedicated subdirectory for work product.

**Directory Layout:**
```
workspace/
  session.json                   # Active agent configs, PIDs, status (used by crash recovery & fan-out)
  logs/                          # Centralized log output
    bob.log                      # Team leader log
    agent-alice.log              # Agent logs
    agent-charlie.log
  bob/                           # Team leader's work directory (git repo root — main branch)
    .gitignore                   # Excludes state/, logs/
    state/                       # Leader's iteration state files
      iteration-1-plan.json
      iteration-1-execute.json
      iteration-1-reflect.json
    src/                         # Work product (the actual deliverable)
    package.json
    ...
  agent-alice/                   # Cloned from bob/ — works on agent/alice branch
    state/
    src/
    ...
  agent-charlie/                 # Cloned from bob/ — works on agent/charlie branch
    state/
    ...
  tools/                         # Dynamic tools directory (shared)
```

**Git Workflow:**

- **Leader initializes the repo** — `bob/` is `git init`'d as part of leader setup. This is the canonical main branch. A `.gitignore` is created in the repo root excluding `state/` and `logs/` directories so that iteration state files and log output don't pollute commits or PR diffs.
- **Agent cloning** — When the leader spawns a new agent, the `spawn-agent` tool runs `git clone bob/ {workspace}/{agent-name}/`, then within the clone creates and checks out the branch `agent/{agent-name}`. The clone automatically has `bob/` as its `origin` remote.
- **Agent work** — Each agent commits to its own branch in its own clone. File paths within the repo are relative to the repo root (e.g., `src/api/routes.ts`), so structure is consistent across all clones.
- **PR flow** — When an agent's purpose is fulfilled, it sends a review message to the leader. The leader then adds the agent's clone as a remote (if not already added) and fetches the branch:
  ```
  git -C bob/ remote add agent-alice ../agent-alice/   # first time only
  git -C bob/ fetch agent-alice agent/alice
  git -C bob/ diff main..agent-alice/agent/alice       # review the diff
  ```
  - **Approve & merge** — Leader merges the branch into main: `git -C bob/ merge agent-alice/agent/alice --no-ff`
  - **Request changes** — Leader sends a message to the agent's personal queue with feedback; the agent continues iterating on its branch
- **Post-merge sync** — After merging, the leader sends a shared message notifying active agents. Each agent pulls the latest main from origin: `git pull origin main` and rebases or merges into their working branch.

### Error Handling & Recovery

**Agent Cancellation:**
The leader can cancel a running agent by sending a `cancel` message to its personal queue. At the start of each loop iteration, the life loop checks for cancel messages before doing any other work. Upon receiving a cancel message, the agent:
1. Writes a final state file recording the cancellation reason
2. Commits any in-progress work to its branch (so it's not lost)
3. Sends a `complete` message with `cancelled: true` to the leader
4. Exits the subprocess

Cancellation is used when the leader determines a task is no longer needed (e.g., requirements shifted, another agent's work made this task redundant, or the leader wants to reassign the work to a differently-configured agent).

**Self-healing (agent-level):**
- The reflect step detects failures (tool errors, bad output, stuck loops)
- Agent attempts to adjust its approach and retry (up to 3 self-recovery attempts per failure)
- State files enable resuming from the last good state

**Escalation (to team leader):**
- After 3 failed self-recovery attempts, the agent sends an error message to the team leader's queue
- The leader can: restart the agent, create a replacement agent, reassign the task, or decide the task is non-critical

**Hard limits:**
- `maxIterations` per agent (default: 50) — prevents infinite loops
- `tokenBudget` per agent — prevents runaway API costs
- Context management: tiered compaction strategy (see Context Management section) keeps agents within context window limits

## Tools

### Built-in Tools (available to all agents)

Each tool is a TypeScript module in `src/tools/` that exports a tool definition compatible with the Claude API tool_use format.

1. **bash** — Execute shell commands via `Bun.$`. Returns stdout/stderr.
2. **read-file** — Read file contents using `Bun.file()`. Supports text and binary.
3. **write-file** — Write/create files using `Bun.write()`.
4. **web-search** — Delegates to the Claude API's built-in `web_search` tool (type `web_search_20250305`). When an agent's tool list includes `web-search`, the tool definition is passed through to the Claude API call as a server-side tool rather than being handled locally. Claude performs the search and returns results inline in its response. No external search API key is required.
5. **web-fetch** — Delegates to the Claude API's built-in `web_fetch` tool, similar to web-search. Fetches a URL and returns the content. Passed through to the Claude API as a server-side tool — no local HTTP fetching or HTML-to-markdown conversion needed.
6. **spawn-agent** — (Leader only) Spawn a new agent subprocess with the given configuration.
7. **send-message** — Send a message to any agent's queue or the shared queue via Valkey.
8. **git** — Execute git commands in the agent's working directory.

### Dynamic Tool Creation

Agents (primarily the leader) can create new tool modules when the built-in tools are insufficient. Dynamic tools follow a validation pipeline before they become available to the team.

**Tool Interface:** Dynamic tools must follow the same interface as built-in tools — export a `definition` (Claude API tool schema) and a `handler` function:
```typescript
// {workspace}/tools/my-tool.ts
export const definition = {
  name: "my-tool",
  description: "What this tool does",
  input_schema: { /* JSON Schema */ }
};

export async function handler(input: Record<string, unknown>): Promise<string> {
  // implementation
  // return result as string
}
```

**Validation Pipeline:**

When an agent creates a new tool, it triggers a validation process before the tool becomes available:

1. **Schema Validation** — The tool registry checks that the exported `definition` conforms to the Claude API tool schema (valid name, description, JSON Schema for input). Malformed tools are rejected immediately.

2. **Test Coverage Requirement** — The creating agent must also write a test file at `{workspace}/tools/{tool-name}.test.ts` that:
   - Tests the tool with at least 3 representative inputs (happy path, edge case, error case)
   - Verifies the handler returns a string
   - Verifies the handler does not throw on valid input
   - Tests are run via `bun test` and must all pass

3. **Security Scan** — Before activation, the tool source is scanned for disallowed patterns:
   - No `eval()`, `new Function()`, or dynamic code execution
   - No network access unless the tool's stated purpose involves network operations (checked against the tool description)
   - No file system access outside the workspace directory
   - No modification of other tools or core system files
   - No access to environment variables beyond `ANTHROPIC_API_KEY`

4. **Validation Agent** — For tools that pass steps 1–3, the leader spawns a short-lived validation agent whose sole purpose is to exercise the tool in a sandboxed context and confirm it behaves as described. This agent:
   - Receives the tool definition and test file
   - Runs the tests independently
   - Attempts adversarial inputs (empty strings, extremely long input, special characters)
   - Reports pass/fail to the leader via message queue
   - Self-terminates after validation

**Tool Lifecycle:**
- **Pending** — Tool has been written but not yet validated
- **Active** — Tool has passed all validation steps and is available in the tool registry
- **Disabled** — Tool failed validation or was disabled by the leader due to runtime issues

**Discovery:** The tool registry re-scans `{workspace}/tools/` at the start of each loop iteration. Only tools with `active` status (tracked in `{workspace}/tools/registry.json`) are made available.

## Project Structure

```
sealteam/
  src/
    index.ts              # CLI entry point, main process (arg parsing, lifecycle)
    life-loop.ts          # Core agent loop (shared by all agents)
    claude-client.ts      # Claude API wrapper (handles model selection, token tracking)
    message-queue.ts      # Valkey-backed message queue abstraction
    tool-registry.ts      # Loads and manages available tools (built-in + dynamic)
    state-manager.ts      # Reads/writes agent state files
    git-manager.ts        # Git operations (clone, branch, commit, push, merge)
    context-manager.ts    # Context window tracking, compaction, and assembly
    types.ts              # Shared TypeScript interfaces
    tools/
      bash.ts
      read-file.ts
      write-file.ts
      web-search.ts
      web-fetch.ts
      spawn-agent.ts
      send-message.ts
      git.ts
  workspace/              # Created at runtime
  package.json
  tsconfig.json
  CLAUDE.md
```

## Output

When the team completes its goal, the user receives:

1. **Summary Report** — A markdown document describing:
   - The original goal
   - How it was decomposed into requirements
   - What agents were created and their roles
   - Key decisions made during execution
   - Token usage breakdown by agent
   - References to all created resources (files, URLs, etc.)
2. **Workspace** — The git repository (in the leader's subdirectory) containing all work product with full commit history showing each agent's contributions via merged branches
3. **Console Output** — Real-time progress updates as agents work, including agent spawns, completions, fast-path vs standard-path decisions, and the final summary

## Configuration

The app supports configuration via CLI arguments (see Main Process section) and environment variables:

- `ANTHROPIC_API_KEY` — Required. Claude API key.
- `VALKEY_URL` — Valkey connection URL (default: `valkey://localhost:6379`)
- `SEALTEAM_WORKSPACE` — Output workspace directory (default: `./workspace`), overridden by `--workspace`
- `SEALTEAM_MAX_AGENTS` — Maximum number of teammate agents (default: 6), overridden by `--workers`
- `SEALTEAM_DEFAULT_BUDGET` — Default token budget per agent (default: 100000), overridden by `--budget`
- `SEALTEAM_DEFAULT_MAX_ITERATIONS` — Default max iterations per agent (default: 50), overridden by `--max-iterations`
- `SEALTEAM_LEADER_MODEL` — Model for team leader (default: `claude-opus-4-20250514`)
- `SEALTEAM_TEAM_MODEL` — Model for teammates (default: `claude-sonnet-4-20250514`)

CLI arguments take precedence over environment variables.

## Constraints

- Use Bun exclusively (no Node.js, no npm — see CLAUDE.md)
- Use `Bun.redis` for Valkey (wire-compatible), `Bun.spawn()` for subprocesses, `Bun.file()`/`Bun.write()` for file I/O
- No external frameworks (no Express, no dotenv)
- All agents run the same `life-loop.ts` code, differentiated only by configuration
- The Claude API is called directly via the Anthropic SDK (`@anthropic-ai/sdk`)
