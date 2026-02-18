import type {
  IterationState,
  SessionState,
  StepType,
} from "./types.ts";

const STEP_ORDER: StepType[] = ["plan", "execute", "plan-execute", "reflect"];

function stepIndex(step: StepType): number {
  return STEP_ORDER.indexOf(step);
}

function stateFilePath(
  agentDir: string,
  iteration: number,
  step: StepType,
): string {
  return `${agentDir}/state/iteration-${iteration}-${step}.json`;
}

export async function ensureDirectories(
  workspacePath: string,
  agentName: string,
): Promise<void> {
  const agentDir = `${workspacePath}/${agentName}`;
  await Bun.$`mkdir -p ${agentDir}/state`.quiet();
  await Bun.$`mkdir -p ${workspacePath}/logs`.quiet();
}

export async function writeIterationState(
  agentDir: string,
  iteration: number,
  step: StepType,
  state: IterationState,
): Promise<void> {
  const path = stateFilePath(agentDir, iteration, step);
  await Bun.$`mkdir -p ${agentDir}/state`.quiet();
  try {
    await Bun.write(path, JSON.stringify(state, null, 2));
  } catch (err) {
    // Retry once after a short delay (handles transient disk errors)
    console.error(`State write failed for ${path}, retrying: ${err instanceof Error ? err.message : String(err)}`);
    await new Promise((r) => setTimeout(r, 100));
    await Bun.write(path, JSON.stringify(state, null, 2));
  }
}

export async function readIterationState(
  agentDir: string,
  iteration: number,
  step: StepType,
): Promise<IterationState | null> {
  const path = stateFilePath(agentDir, iteration, step);
  try {
    const text = await Bun.file(path).text();
    return JSON.parse(text) as IterationState;
  } catch {
    return null;
  }
}

export async function getLastCompletedStep(
  agentDir: string,
): Promise<{ iteration: number; step: StepType } | null> {
  const stateDir = `${agentDir}/state`;
  try {
    const result = await Bun.$`ls ${stateDir}`.quiet().text();
    const files = result.trim().split("\n").filter(Boolean);

    let best: { iteration: number; step: StepType } | null = null;

    for (const file of files) {
      // Match iteration-{n}-{step}.json
      const match = file.match(/^iteration-(\d+)-(.+)\.json$/);
      if (!match) continue;

      const iteration = parseInt(match[1]!, 10);
      const step = match[2] as StepType;
      if (!STEP_ORDER.includes(step)) continue;

      if (
        !best ||
        iteration > best.iteration ||
        (iteration === best.iteration && stepIndex(step) > stepIndex(best.step))
      ) {
        best = { iteration, step };
      }
    }

    return best;
  } catch {
    return null;
  }
}

export async function writeSessionState(
  workspacePath: string,
  session: SessionState,
): Promise<void> {
  const path = `${workspacePath}/session.json`;
  try {
    await Bun.write(path, JSON.stringify(session, null, 2));
  } catch (err) {
    console.error(`Session write failed for ${path}, retrying: ${err instanceof Error ? err.message : String(err)}`);
    await new Promise((r) => setTimeout(r, 100));
    await Bun.write(path, JSON.stringify(session, null, 2));
  }
}

export async function readSessionState(
  workspacePath: string,
): Promise<SessionState | null> {
  const path = `${workspacePath}/session.json`;
  try {
    const text = await Bun.file(path).text();
    return JSON.parse(text) as SessionState;
  } catch {
    return null;
  }
}
