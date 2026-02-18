# SealTeam Development Plan

## Dependency Graph

```
types.ts                  ← no deps (pure interfaces)
  │
  ├── state-manager.ts    ← types, Bun.file/Bun.write
  ├── message-queue.ts    ← types, Bun.redis
  ├── git-manager.ts      ← types, Bun.$
  ├── claude-client.ts    ← types, @anthropic-ai/sdk
  │
  ├── context-manager.ts  ← types, claude-client, state-manager
  │
  ├── tools/*             ← types, message-queue, git-manager, Bun.$, Bun.file, Bun.write
  ├── tool-registry.ts    ← types, tools/*
  │
  ├── life-loop.ts        ← ALL of the above
  │
  └── src/index.ts        ← life-loop, message-queue, git-manager, state-manager
```

Phases 1 and 2 can be developed in parallel. Phase 3 depends on both. Phase 4 can parallel with Phase 3. Phases 5+ are sequential.

---

## Phase 0: Project Scaffolding and Types

**Goal**: Set up the project structure, install the runtime dependency, and define all shared interfaces.

### Tasks

1. **Install dependency**: `bun add @anthropic-ai/sdk`

2. **Add `sealteam` script** to `package.json`:
   ```json
   { "scripts": { "sealteam": "bun run src/index.ts" } }
   ```

3. **Create `src/types.ts`** — All shared interfaces that every module imports:

   - `QueueMessage` — Inter-agent message format (`id`, `from`, `to`, `type`, `content`, `timestamp`). Types: `"task" | "status" | "review" | "complete" | "error" | "cancel" | "all-complete"`.
   - `AgentConfig` — Passed to subprocesses (`name`, `role`, `purpose`, `tools`, `model`, `tokenBudget`, `maxIterations`, `workspacePath`, `valkeyUrl`).
   - `IterationState` — Persisted per step (`iteration`, `step`, `timestamp`, `input`, `output`, `tokensUsed`, `complexity`).
   - `ReflectDecision` — Output of reflect step (`decision`, `summary`, `nextMessage`, `errorDetails`, `selfRecoveryAttempt`).
   - `IterationSummary` — Compacted iteration representation (`iteration`, `plan`, `outcome`, `filesChanged`, `decisions`).
   - `SessionState` — Crash recovery file (`goal`, `startTime`, `workspace`, `valkeyUrl`, `agents[]`, `status`).
   - `AgentSessionEntry` — Per-agent session tracking (`config`, `pid`, `status`, `startTime`, `endTime`).
   - `ToolDefinition` — Claude API tool schema (`name`, `description`, `input_schema`).
   - `ToolModule` — Tool export shape (`definition`, `handler`).
   - `ToolStatus` — `"pending" | "active" | "disabled"`.
   - `ToolRegistryEntry` — Dynamic tool tracking (`name`, `path`, `status`, `validatedAt`, `error`).
   - `CLIOptions` — Parsed CLI arguments (`goal`, `workers`, `budget`, `maxIterations`, `workspace`, `valkeyUrl`, `leaderModel`, `teamModel`, `resumeFrom`).

### Testing

- `src/types.test.ts` — Import all types, create sample objects conforming to each interface, verify TypeScript is satisfied.
- Run `bun run --bun tsc --noEmit` to type-check.

### Deliverables
- `src/types.ts`
- `src/types.test.ts`
- Updated `package.json`

---

## Phase 1: State Manager and Message Queue

**Goal**: Implement file-based state persistence and Valkey-backed message queuing — the two foundational I/O layers.

### File 1: `src/state-manager.ts`

Key functions:
- `writeIterationState(agentDir, iteration, step, state)` — Writes `{agentDir}/state/iteration-{n}-{step}.json` via `Bun.write()`.
- `readIterationState(agentDir, iteration, step)` — Reads via `Bun.file().text()` + `JSON.parse()`. Returns `null` if missing.
- `getLastCompletedStep(agentDir)` — Scans the `state/` directory to find the highest iteration+step.
- `writeSessionState(workspacePath, session)` — Writes `session.json`.
- `readSessionState(workspacePath)` — Reads `session.json`.
- `ensureDirectories(workspacePath, agentName)` — Creates workspace, agent dir, state dir, logs dir via `mkdir -p`.

Implementation notes:
- File pattern: `{workspace}/{agentName}/state/iteration-{n}-{step}.json`.
- Use `Bun.write(path, JSON.stringify(state, null, 2))` for writes.
- Use `await Bun.file(path).text()` then `JSON.parse()` for reads, wrapped in try/catch.

### File 2: `src/message-queue.ts`

Class `MessageQueue` with:
- `constructor(valkeyUrl: string)` — Creates `Bun.redis` connection.
- `send(message: QueueMessage)` — Routes by `message.to`: `"shared"` calls `sendShared()`, `"main"` pushes to `queue:main`, otherwise pushes to `queue:{message.to}`. Uses `redis.lpush(key, JSON.stringify(message))`.
- `sendShared(message, workspacePath)` — Reads `session.json` for active agent list, pushes copy to each agent's queue (excluding sender).
- `receive(agentName)` — Blocking pop via `redis.brpop("queue:" + agentName, 5)`. Returns parsed `QueueMessage` or `null` on timeout.
- `receiveNonBlocking(agentName)` — `redis.rpop("queue:" + agentName)`.
- `close()` — Closes Redis connection.

### Testing

**`src/state-manager.test.ts`**:
- Write/read round-trip for iteration state.
- `getLastCompletedStep` with multiple state files.
- Session state read/write.
- Missing file returns `null`.
- All tests use temp directories in `/tmp/`.

**`src/message-queue.test.ts`** (requires Valkey on localhost:6379):
- Send/receive round-trip.
- BRPOP timeout returns `null`.
- Non-blocking receive on empty queue returns `null`.
- Fan-out sends to multiple agent queues.
- Use unique key prefixes per test run.

### Deliverables
- `src/state-manager.ts`, `src/state-manager.test.ts`
- `src/message-queue.ts`, `src/message-queue.test.ts`

---

## Phase 2: Git Manager and Claude Client

**Goal**: Implement git operations and the Claude API wrapper. These are independent of each other and of Phase 1.

### File 1: `src/git-manager.ts`

All operations use `Bun.$` and take a `workDir` parameter. Key functions:
- `initRepo(workDir)` — `git init`, initial commit.
- `createGitignore(workDir)` — Writes `.gitignore` excluding `state/` and `logs/`.
- `cloneForAgent(leaderDir, agentDir, agentName)` — `git clone`, then `git checkout -b agent/{agentName}`.
- `checkoutBranch(workDir, branchName)` — `git checkout -b`.
- `commitAll(workDir, message)` — `git add -A && git commit -m`.
- `addRemoteAndFetch(leaderDir, agentName, agentDir)` — `git remote add` (ignoring "already exists"), then `git fetch`.
- `getDiff(leaderDir, agentName)` — `git diff main..agent-{name}/agent/{name}`.
- `mergeAgentBranch(leaderDir, agentName)` — `git merge --no-ff`. Returns `{success, output}`.
- `pullAndRebase(workDir)` — `git pull origin main`.
- `gitExec(workDir, args)` — General-purpose: run any git command, return `{stdout, stderr, exitCode}`.

Implementation notes:
- Use `Bun.$`git -C ${workDir} ...`.nothrow().quiet()` to capture output without throwing.

### File 2: `src/claude-client.ts`

Class `ClaudeClient`:
- `constructor()` — Creates `Anthropic` client (reads `ANTHROPIC_API_KEY` from env automatically).
- `call({ model, systemPrompt, messages, tools?, serverTools?, maxTokens? })` — Calls `client.messages.create()`. Returns `{ response, tokensUsed }`. Accumulates token counts.
- `getTokenUsage()` — Returns `{ input, output, total }`.
- `estimateTokens(text)` — Rough heuristic: `text.length / 4`.

Implementation notes:
- `tools` array contains local tool definitions (for the Claude API `tools` param).
- `serverTools` are special: `web_search` becomes `{type: "web_search_20250305"}`, `web_fetch` becomes `{type: "web_fetch_20250305"}`. These go in the API request alongside local tools.
- Token tracking: `response.usage.input_tokens` and `response.usage.output_tokens`.
- The tool_use response cycle (calling tools, sending results back) is handled by the caller (life-loop), not this module. This module makes single API calls.

### Testing

**`src/git-manager.test.ts`** (uses temp dirs):
- `initRepo` creates `.git`.
- `cloneForAgent` produces a clone on the correct branch.
- `commitAll` creates a commit.
- `mergeAgentBranch` merges and handles conflicts.

**`src/claude-client.test.ts`**:
- Instantiation without error (requires `ANTHROPIC_API_KEY`).
- Simple API call ("Say hello in 3 words") returns valid response with token counts.
- Call with tool definitions returns tool_use content blocks.
- Mark as integration tests (skip if no API key).

### Deliverables
- `src/git-manager.ts`, `src/git-manager.test.ts`
- `src/claude-client.ts`, `src/claude-client.test.ts`

---

## Phase 3: Built-in Tools and Tool Registry

**Goal**: Implement all 8 built-in tools and the registry that loads and manages them.

### Tools (`src/tools/`)

Each tool exports `definition: ToolDefinition` and `handler(input): Promise<string>`.

| File | Input Schema | Implementation |
|------|-------------|----------------|
| `bash.ts` | `{ command: string, cwd?: string }` | `Bun.$`, cap output at 100KB |
| `read-file.ts` | `{ path: string }` | `Bun.file(path).text()` |
| `write-file.ts` | `{ path: string, content: string }` | `Bun.write(path, content)`, create parent dirs |
| `web-search.ts` | N/A (server-side) | Passthrough — handler throws "server-side tool" |
| `web-fetch.ts` | N/A (server-side) | Passthrough — handler throws "server-side tool" |
| `spawn-agent.ts` | `{ name, role, purpose, tools, model?, tokenBudget?, maxIterations? }` | `Bun.spawn()`, updates `session.json`, runs `git clone` |
| `send-message.ts` | `{ to: string, type: string, content: string }` | Builds `QueueMessage`, calls `messageQueue.send()` |
| `git.ts` | `{ command: string }` | Calls `gitManager.gitExec(agentWorkDir, args)` |

Notes on `spawn-agent.ts`:
- Leader-only tool.
- Serializes `AgentConfig` as JSON via `AGENT_CONFIG` env variable.
- Runs `Bun.spawn(["bun", "src/life-loop.ts"], { env: { ...process.env, AGENT_CONFIG: JSON.stringify(config) } })`.
- Clones leader's git repo for the new agent.
- Updates `session.json` with new agent entry.

Notes on `web-search.ts` / `web-fetch.ts`:
- These are not executed locally. When an agent's tool list includes these, the tool registry returns them separately via `getServerTools()`. The Claude client adds them to the API request as server-side tools (`type: "web_search_20250305"`, `type: "web_fetch_20250305"`).

### Tool Registry: `src/tool-registry.ts`

Class `ToolRegistry`:
- `loadBuiltins()` — Statically imports all `src/tools/*.ts` modules.
- `scanDynamic(workspacePath)` — Reads `{workspace}/tools/registry.json`, imports active tools.
- `getToolDefinitions(toolNames)` — Returns definitions filtered by the agent's allowed tool list. Excludes server-side tools.
- `getServerTools(toolNames)` — Returns server-side tool specs for tools like `web-search`, `web-fetch`.
- `executeTool(name, input)` — Calls the handler. Throws for server-side tools.
- `validateDynamicTool(toolPath, workspacePath)` — Schema check + test run + security scan (expanded in Phase 7).

### Testing

- Individual tool tests (`bash.test.ts`, `read-file.test.ts`, `write-file.test.ts`, `git.test.ts`, `send-message.test.ts`, `spawn-agent.test.ts`).
- `tool-registry.test.ts` — Loading builtins, filtering by tool list, separating server-side tools.

### Deliverables
- `src/tools/bash.ts`, `src/tools/read-file.ts`, `src/tools/write-file.ts`
- `src/tools/web-search.ts`, `src/tools/web-fetch.ts`
- `src/tools/spawn-agent.ts`, `src/tools/send-message.ts`, `src/tools/git.ts`
- `src/tool-registry.ts`, `src/tool-registry.test.ts`
- Individual tool test files

---

## Phase 4: Context Manager

**Goal**: Build the context window management and compaction system.

### File: `src/context-manager.ts`

Class `ContextManager`:
- `constructor(model)` — Sets context limit based on model.
- `assembleContext({ systemPrompt, iterationStates, currentMessages, currentIteration })` — Builds the `messages` array:
  1. Compacted summaries of iterations older than 5 (as user messages).
  2. Full detail of last 5 iterations (as user/assistant pairs).
  3. Current queue messages (as final user message).
- `checkCompactionNeeded()` — Returns `"none"`, `"soft"` (70%), or `"hard"` (90%).
- `compactIterations(iterations, currentIteration)` — Applies trimming and summarization.
- `trimToolResults(iteration, currentIteration)` — For iterations older than 3: truncate tool outputs to first/last 200 lines with `[... N lines omitted ...]`.
- `summarizeIteration(iteration)` — Converts to `IterationSummary` (1-2 sentence plan/outcome, filesChanged, decisions).
- `updateTokenUsage(tokensUsed)` — Updates utilization tracking.
- `getUtilization()` — Returns percentage of context window used.

### Testing

`src/context-manager.test.ts` (pure unit tests, no external deps):
- <5 iterations: all returned in full.
- \>5 iterations: old ones summarized.
- Tool result trimming on large outputs.
- Compaction thresholds at correct utilization levels.

### Deliverables
- `src/context-manager.ts`, `src/context-manager.test.ts`

---

## Phase 5: The Life Loop

**Goal**: Implement the core agent loop — the heart of the system.

### File: `src/life-loop.ts`

Both a module and an executable subprocess entry point:

```typescript
if (import.meta.main) {
  const config = JSON.parse(process.env.AGENT_CONFIG!);
  await runLifeLoop(config);
}
```

**Loop structure** (each iteration until `maxIterations` or budget exhaustion):

```
1. CHECK MESSAGES
   - BRPOP 5s from personal queue
   - Cancel message → commit work, send complete (cancelled:true), exit
   - No message after 30 idle cycles → send status to leader

2. DETERMINE PATH
   - First iteration or previous complexity === "complex" → Standard
   - Previous complexity === "simple" → Fast

3a. STANDARD PATH (3 calls)
   Plan  → Claude call with planning instructions → write iteration-{n}-plan.json
   Execute → Claude call with tool defs → tool call loop → write iteration-{n}-execute.json
   Reflect → (shared, see below)

3b. FAST PATH (2 calls)
   Plan+Execute → Single Claude call with both planning + tools → write iteration-{n}-plan-execute.json
   Reflect → (shared, see below)

4. REFLECT (both paths)
   - Claude call with execution results
   - Output: decision (continue/complete/error) + IterationSummary
   - Write iteration-{n}-reflect.json
   - continue → post message to own queue, next iteration
   - complete → send complete to leader, exit
   - error → increment recovery counter, if <3 retry, else escalate to leader
```

**Tool call loop** (within Execute / Plan+Execute):
1. Make Claude API call with tool definitions.
2. If response contains `tool_use` blocks: execute each via `toolRegistry.executeTool()`.
3. Construct `tool_result` content blocks.
4. Make another API call with results appended.
5. Repeat until `stop_reason === "end_turn"`.

Server-side tools (`web_search`, `web_fetch`) return results inline in Claude's response — no local handling needed.

**Crash recovery**: If `--resume-from iteration-step` is set, read the last state file, skip to the next step.

**Logging**: Append to `{workspace}/logs/{agentName}.log` with timestamps.

### File: `src/prompts.ts`

System prompt templates:
- **Plan prompt** — Role, purpose, available tools, recent state, instructions to output structured plan with `complexity` field.
- **Execute prompt** — The plan, tool definitions, instructions to carry out the plan.
- **Plan+Execute prompt** — Combined: state intent then act in same response.
- **Reflect prompt** — Execution results, evaluate, decide (continue/complete/error), produce `IterationSummary`.
- **Leader-specific prompt additions** — Goal decomposition, team planning, PR review, completion monitoring guidance.

### Testing

`src/life-loop.test.ts`:
1. **Unit tests (mocked Claude client)**:
   - Standard path makes 3 API calls.
   - Fast path makes 2 API calls.
   - Tool call loop processes tool_use blocks.
   - "complete" decision exits the loop.
   - "error" triggers self-recovery up to 3 times.
   - Cancel message causes graceful shutdown.
   - State files written at each step.
2. **Integration test** (requires API key + Valkey): Single iteration with trivial task.
3. **Crash recovery test**: Partial state files + `--resume-from`.

### Deliverables
- `src/life-loop.ts`, `src/life-loop.test.ts`
- `src/prompts.ts`

---

## Phase 6: CLI Entry Point (Main Process)

**Goal**: Implement the main process that bootstraps everything.

### File: `src/index.ts`

Replaces the current hello-world `index.ts`.

**Flow**:
1. **Parse CLI args** — Hand-rolled parser (no external deps):
   ```
   bun run sealteam [options] "<goal>"
   Options: --workers <n>, --budget <n>, --max-iterations <n>, --workspace <path>
   ```
   Env var fallbacks: `VALKEY_URL`, `SEALTEAM_WORKSPACE`, `SEALTEAM_MAX_AGENTS`, `SEALTEAM_DEFAULT_BUDGET`, `SEALTEAM_DEFAULT_MAX_ITERATIONS`, `SEALTEAM_LEADER_MODEL`, `SEALTEAM_TEAM_MODEL`.

2. **Validate environment** — Check `ANTHROPIC_API_KEY` is set.

3. **Check for session recovery** — If `session.json` exists, run recovery flow.

4. **Create workspace** — `ensureDirectories()`.

5. **Init Valkey** — `new MessageQueue(valkeyUrl)`.

6. **Init git repo** — `initRepo()` + `createGitignore()` + initial commit in `{workspace}/bob/`.

7. **Write session state** — Initial `session.json`.

8. **Spawn team leader "Bob"** — `Bun.spawn()` with leader config (all 8 tools, opus model, 2x budget).

9. **Send goal** — Push task message to `queue:bob`.

10. **Monitor loop** — Listen on `queue:main` for `all-complete`. Track subprocess handles via `proc.exited`. Re-spawn crashed agents. Update `session.json`.

11. **Print summary** — Token usage by agent, files created, git history.

12. **Cleanup** — Close Valkey connection.

**Session recovery**:
- Read `session.json`, check PIDs, re-spawn dead agents with `--resume-from`.
- Skip agents that already completed.

**Graceful shutdown** (SIGINT/SIGTERM):
- Send cancel to all running agents.
- Wait up to 10s for graceful exit.
- Force kill remaining.
- Write final session state.

### Testing

`src/index.test.ts`:
- CLI argument parsing with various option combinations.
- Missing `ANTHROPIC_API_KEY` produces clear error.
- Workspace directory creation.
- End-to-end integration test with trivial goal.

### Deliverables
- `src/index.ts` (replaces root `index.ts`)
- `src/index.test.ts`
- Updated `package.json`

---

## Phase 7: Dynamic Tool Validation Pipeline

**Goal**: Complete the dynamic tool creation, validation, and lifecycle system.

### Additions to `src/tool-registry.ts`

Expand `validateDynamicTool()` with the full pipeline:

1. **Schema validation** — Import tool, verify exports `definition` (with `name`, `description`, `input_schema`) and `handler` (function).

2. **Test coverage** — Verify `{workspace}/tools/{tool-name}.test.ts` exists. Run via `Bun.$`bun test ${testFile}``. Check exit code 0.

3. **Security scan** — Read source as text, reject:
   - `eval(`, `new Function(`
   - `process.env` access (except `ANTHROPIC_API_KEY`)
   - File paths outside workspace
   - Non-relative imports outside an allowlist

4. **Validation agent** — Spawn a short-lived agent (tiny budget, 3 max iterations) to run tests and try adversarial inputs. Reports pass/fail via message queue.

### Registry persistence

`{workspace}/tools/registry.json`:
```json
{ "tools": [{ "name": "...", "path": "...", "status": "active", "validatedAt": 0 }] }
```

### Testing

`src/tool-registry-dynamic.test.ts`:
- Valid tool passes all steps.
- Tool missing `definition` is rejected.
- Tool missing test file is rejected.
- Tool with `eval()` is rejected.
- Tool with failing tests is rejected.
- `registry.json` updated after validation.
- `scanDynamic` picks up newly active tools.

### Deliverables
- Enhanced `src/tool-registry.ts`
- `src/tool-registry-dynamic.test.ts`

---

## Phase 8: Polish, Error Handling, and End-to-End Testing

**Goal**: Harden the system and verify it works end-to-end.

### Tasks

1. **Console output** — `src/logger.ts`: colored status output for agent spawns, iteration progress (standard vs fast path), completions, errors, and the final summary with token usage table.

2. **Error boundary hardening**:
   - Valkey connection failures: retry with exponential backoff.
   - Claude API errors (rate limits, network): exponential backoff in `claude-client.ts`.
   - Agent subprocess crashes: automatic re-spawn with `--resume-from`.
   - Disk write errors: catch and report.

3. **End-to-end tests** (`tests/e2e/`):

   **`simple-task.test.ts`**: Goal: "Create hello.txt with 'Hello, World!'". Verify file exists with expected content.

   **`multi-agent.test.ts`**: Goal requiring multiple agents. Verify leader spawns workers, files exist, git branches merged.

   **`crash-recovery.test.ts`**: Spawn agent, kill mid-iteration, restart, verify recovery.

### Deliverables
- `src/logger.ts`
- Updated error handling across all modules
- `tests/e2e/simple-task.test.ts`
- `tests/e2e/multi-agent.test.ts`
- `tests/e2e/crash-recovery.test.ts`

---

## Complete File Manifest

```
src/
  index.ts              ← Phase 6: CLI entry point
  types.ts              ← Phase 0: shared interfaces
  life-loop.ts          ← Phase 5: core agent loop
  prompts.ts            ← Phase 5: system prompt templates
  claude-client.ts      ← Phase 2: Claude API wrapper
  message-queue.ts      ← Phase 1: Valkey message queues
  tool-registry.ts      ← Phase 3 + 7: tool loading and validation
  state-manager.ts      ← Phase 1: file-based state persistence
  git-manager.ts        ← Phase 2: git operations
  context-manager.ts    ← Phase 4: context window management
  logger.ts             ← Phase 8: console output formatting
  tools/
    bash.ts             ← Phase 3
    read-file.ts        ← Phase 3
    write-file.ts       ← Phase 3
    web-search.ts       ← Phase 3
    web-fetch.ts        ← Phase 3
    spawn-agent.ts      ← Phase 3
    send-message.ts     ← Phase 3
    git.ts              ← Phase 3
tests/
  e2e/
    simple-task.test.ts    ← Phase 8
    multi-agent.test.ts    ← Phase 8
    crash-recovery.test.ts ← Phase 8
```

## Key Technical Decisions

1. **Agent config transfer**: Serialize `AgentConfig` as JSON in `AGENT_CONFIG` env variable (avoids CLI arg length limits).

2. **BRPOP for queuing**: `Bun.redis` supports `brpop()` natively. Fan-out for shared messages pushes copies to individual queues (no Pub/Sub needed).

3. **Server-side tool passthrough**: `web_search` and `web_fetch` are added to the Claude API request as server-side tools — no local HTTP or search logic.

4. **Tool call loop termination**: Execute step repeats API calls until `stop_reason === "end_turn"` (no more tool requests).

5. **State files as source of truth**: Valkey is ephemeral. Crash recovery reads state files from disk, not queue replay.

6. **No IPC for agent communication**: Despite Bun supporting IPC, Valkey queues decouple agents and enable fan-out cleanly. Process handles are only for lifecycle management.

## Prerequisites

- Bun runtime installed
- Valkey/Redis running on `localhost:6379` (or set `VALKEY_URL`)
- `ANTHROPIC_API_KEY` environment variable set
