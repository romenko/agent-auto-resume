import { spawn, ChildProcess } from "child_process";
import os from "os";
import fs from "fs-extra";
import path from "path";
import { SessionState } from "./types.js";
import { updateSession, getSession } from "./session-store.js";
import { detectLimit } from "./detector.js";
import { getProvider } from "../providers/index.js";
import { logger } from "./logger.js";

const activeResumes = new Set<string>();

function resolveCommandPath(cmd: string, customPath: string): string {
  if (cmd.includes("/") || cmd.includes("\\")) {
    return cmd;
  }
  const paths = customPath.split(path.delimiter);
  for (const p of paths) {
    const fullPath = path.join(p, cmd);
    try {
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          return fullPath;
        }
      }
    } catch {
      // ignore
    }
  }
  return cmd;
}

/**
 * セッションをバックグラウンド（PTY）で再開し、結果を監視する。
 * @param state セッション情報
 * @returns 再開および実行が成功した場合は true、失敗した、または再度リミットに達した場合は false
 */
export async function resumeSessionInBackground(state: SessionState): Promise<boolean> {
  if (activeResumes.has(state.id)) {
    logger.warn(`Resume already active for session ${state.id}; skipping duplicate launch.`, "aar");
    return false;
  }
  const savedState = await getSession(state.id);
  if (savedState?.status === "resuming") {
    logger.warn(`Session ${state.id} is already marked resuming; refusing a second launch.`, "aar");
    return false;
  }
  activeResumes.add(state.id);
  let childStarted = false;
  try {
  const provider = getProvider(state.provider);
  if (!(await fs.pathExists(state.cwd))) {
    throw new Error(`Working directory no longer exists: ${state.cwd}`);
  }

  const resumeCommand = await provider.getResumeCommand(state);
  const resumeInput = provider.getResumeInput ? await provider.getResumeInput(state) : undefined;

  logger.info(`Resuming session ${state.id} with command: ${resumeCommand.join(" ")}`, "aar");

  await updateSession(state.id, {
    status: "resuming",
    resumeCommand,
    resumeInput,
    attempts: state.attempts + 1,
    resumeError: undefined,
    resumePid: undefined,
  });

  const cmd = resumeCommand[0];
  const args = resumeCommand.slice(1);

  let child: ChildProcess;
  try {
    const pathEnv = process.env.PATH || "";
    const home = os.homedir();
    const extraPaths = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      `${home}/.npm-global/bin`,
      `${home}/.hermes/node/bin`,
      `${home}/.local/bin`,
      `${home}/.volta/bin`,
    ];
    const newPath = [
      ...extraPaths.filter((p) => !pathEnv.includes(p)),
      pathEnv,
    ].join(":");

    const resolvedCmd = resolveCommandPath(cmd, newPath);

    let spawnCmd = resolvedCmd;
    let spawnArgs = args;

    if (state.resumeStrategy === "pty-input") {
      spawnCmd = "script";
      spawnArgs = ["-q", "/dev/null", resolvedCmd, ...args];
      logger.info(`Using script command for TTY allocation: script -q /dev/null ${resolvedCmd} ${args.join(" ")}`, "aar");
    } else {
      logger.info(`Spawning child process: ${resolvedCmd} with args: ${JSON.stringify(args)} (original: ${cmd})`, "aar");
    }

    child = spawn(spawnCmd, spawnArgs, {
      cwd: state.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: newPath,
        AAR_SESSION_ID: state.id,
      },
    });
    childStarted = true;
  } catch (err: any) {
    logger.error(`Failed to spawn resume command: ${err.message}`, "aar");
    await updateSession(state.id, {
      status: "failed",
      resumeError: err.message,
      resumePid: undefined,
    });
    return false;
  }

  // Attach child listeners before yielding; ENOENT can arrive on the next tick.
  const started = child.pid
    ? updateSession(state.id, { resumePid: child.pid })
    : Promise.resolve();

  return await new Promise<boolean>((resolve) => {
    let resolved = false;
    const safeResolve = (val: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    };

    let limitDetected = false;
    let limitUpdate: Promise<unknown> = Promise.resolve();
    let accumulatedOutput = "";

    // 自動プロンプト入力がある場合、プロセス起動を少し待ってから送信する
    if (resumeInput && child.stdin) {
      setTimeout(() => {
        try {
          child.stdin?.write(resumeInput);
          logger.info(`Sent resume input to session ${state.id}: ${JSON.stringify(resumeInput)}`, "aar");
        } catch (err: any) {
          logger.error(`Failed to write resume input to child stdin: ${err.message}`, "aar");
        }
      }, 2000);
    }

    const handleData = (data: Buffer) => {
      const str = data.toString("utf-8");
      accumulatedOutput += str;
      if (accumulatedOutput.length > 8192) {
        accumulatedOutput = accumulatedOutput.slice(-4096);
      }

      logger.debug(`[Child Output ${state.id}] ${str.trim()}`, "aar");

      if (!limitDetected) {
        const detection = detectLimit(accumulatedOutput, state.provider);
        if (detection.matched) {
          limitDetected = true;
          logger.warn(`Limit re-detected during resume for session ${state.id}`, "aar");

          const resetAtStr = detection.resetAt ? detection.resetAt.toISOString() : new Date().toISOString();
          limitUpdate = started.then(() => updateSession(state.id, {
            status: "waiting_limit_reset",
            lastLimitDetectedAt: new Date().toISOString(),
            resetAt: resetAtStr,
            lastOutputSnippet: accumulatedOutput.slice(-1000),
          })).finally(() => {
            child.kill();
          });
        }
      }
    };

    if (child.stdout) {
      child.stdout.on("data", handleData);
    }
    if (child.stderr) {
      child.stderr.on("data", handleData);
    }

    child.on("error", async (err) => {
      await started;
      logger.error(`Child process error for session ${state.id}: ${err.message}`, "aar");
      const current = await getSession(state.id);
      if (current && current.status === "resuming") {
        await updateSession(state.id, {
          status: "failed",
          resumeError: err.message,
          resumePid: undefined,
        });
      }
      safeResolve(false);
    });

    child.on("close", async (code) => {
      await started;
      await limitUpdate;
      const current = await getSession(state.id);
      if (!current) {
        return safeResolve(false);
      }

      if (current.status === "resuming") {
        if (code === 0) {
          logger.info(`Session ${state.id} completed successfully.`, "aar");
          await updateSession(state.id, { status: "completed", resumePid: undefined });
          safeResolve(true);
        } else {
          logger.info(`Session ${state.id} exited with code ${code}.`, "aar");
          await updateSession(state.id, {
            status: "failed",
            resumeError: `Resume process exited with code ${code}`,
            resumePid: undefined,
          });
          safeResolve(false);
        }
      } else if (current.status === "waiting_limit_reset") {
        await updateSession(state.id, { resumePid: undefined });
        safeResolve(false);
      } else {
        safeResolve(false);
      }
    });

  });
  } catch (err: any) {
    const current = await getSession(state.id);
    if (current && (!childStarted || (current.status !== "waiting_limit_reset" && current.status !== "completed"))) {
      await updateSession(state.id, {
        status: "failed",
        resumeError: err.message,
        resumePid: undefined,
      });
    }
    logger.error(`Unable to resume session ${state.id}: ${err.message}`, "aar");
    return false;
  } finally {
    activeResumes.delete(state.id);
  }
}
