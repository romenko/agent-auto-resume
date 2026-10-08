import pty from "node-pty";
import { spawn, ChildProcess } from "child_process";
import { SessionState, ProviderName } from "./types.js";
import { detectLimit } from "./detector.js";
import { createSession, updateSession, loadConfig, getSession } from "./session-store.js";
import { logger, setMuteConsole } from "./logger.js";
import { getProvider } from "../providers/index.js";


export interface PtyRunnerOptions {
  providerName: ProviderName;
  command: string;
  args: string[];
  cwd?: string;
  sessionId?: string;
}

export async function runInPty(options: PtyRunnerOptions): Promise<void> {
  const { providerName, command, args, cwd = process.cwd(), sessionId } = options;

  const isInteractive = !!process.stdout.isTTY;
  const isServerMode = args.some((arg) =>
    arg.includes("app-server") ||
    arg.includes("--listen") ||
    arg.includes("stdio") ||
    arg.includes("mcp")
  );

  if (isServerMode || !isInteractive) {
    setMuteConsole(true);
  }

  const config = await loadConfig();
  const provider = getProvider(providerName);

  let session: SessionState;
  if (sessionId) {
    const existing = await getSession(sessionId);
    if (existing) {
      session = existing;
    } else {
      throw new Error(`Session ${sessionId} not found`);
    }
  } else {
    session = await createSession({
      provider: providerName,
      cwd,
      originalCommand: [command, ...args],
      resumeStrategy: providerName === "claude" ? "pty-input" : "command",
      status: "running",
      attempts: 0,
      maxAttempts: config.maxAttempts,
      bufferSeconds: config.bufferSeconds,
      managedByAar: true,
      source: "managed-pty",
    });
  }

  logger.info(`Managed session started: ${session.id}`, "aar");

  if (isServerMode || !isInteractive) {
    await runInPipe(session, command, args, cwd);
    return;
  }

  let ptyProcess: ReturnType<typeof pty.spawn>;
  try {
    ptyProcess = pty.spawn(command, args, {
      name: "xterm-color",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd,
      env: {
        ...process.env,
        AAR_SESSION_ID: session.id,
      },
    });
  } catch (err: any) {
    await updateSession(session.id, {
      status: "failed",
      resumeError: `Failed to start ${command}: ${err.message}`,
      pid: undefined,
    });
    logger.error(`Failed to start managed process for session ${session.id}: ${err.message}`, "aar");
    throw err;
  }

  await updateSession(session.id, { pid: ptyProcess.pid, status: "running" });


  let limitDetected = false;
  let accumulatedOutput = "";

  const resizeHandler = () => {
    try {
      ptyProcess.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    } catch {
      // ignore
    }
  };
  process.stdout.on("resize", resizeHandler);

  const stdinHandler = (data: Buffer) => {
    ptyProcess.write(data.toString());
  };
  
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", stdinHandler);

  ptyProcess.onData(async (data: string) => {
    process.stdout.write(data);
    
    accumulatedOutput += data;
    if (accumulatedOutput.length > 8192) {
      accumulatedOutput = accumulatedOutput.slice(-4096);
    }

    if (!limitDetected) {
      const detection = detectLimit(accumulatedOutput, providerName);
      if (detection.matched) {
        limitDetected = true;
        
        const resetAtStr = detection.resetAt ? detection.resetAt.toISOString() : undefined;
        
        logger.warn(`Usage limit detected for ${provider.displayName}!`, "aar");
        if (resetAtStr) {
          logger.warn(`Resets at: ${detection.resetAt?.toLocaleString()}`, "aar");
        } else {
          logger.warn("Reset time not specified. Auto-resume will fail without manual intervention or retry-now.", "aar");
        }

        await updateSession(session.id, {
          status: "waiting_limit_reset",
          lastLimitDetectedAt: new Date().toISOString(),
          resetAt: resetAtStr,
          lastOutputSnippet: accumulatedOutput.slice(-1000),
        });

        console.log(`\n\n\x1b[33m[aar] Usage limit detected. Setting session to waiting state...\x1b[0m`);
        console.log(`\x1b[33m[aar] Session ID: ${session.id}\x1b[0m`);
        if (resetAtStr) {
          console.log(`\x1b[33m[aar] Scheduled to resume after reset time + buffer seconds.\x1b[0m`);
        } else {
          console.log(`\x1b[31m[aar] Warning: Reset time unknown. Run 'aar retry-now --id ${session.id}' manually if needed.\x1b[0m`);
        }

        try {
          ptyProcess.kill();
        } catch {
          // ignore
        }
      }
    }
  });

  ptyProcess.onExit(async (res) => {
    process.stdout.off("resize", resizeHandler);
    process.stdin.off("data", stdinHandler);
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch {
      // ignore
    }

    const currentSession = await getSession(session.id);
    if (currentSession) {
      if (currentSession.status === "running") {
        await updateSession(session.id, {
          status: res.exitCode === 0 ? "completed" : "failed",
          pid: undefined,
        });
      } else if (currentSession.status === "waiting_limit_reset") {
        await updateSession(session.id, {
          pid: undefined,
        });
      }
    }

    process.exit(res.exitCode);
  });
}

async function runInPipe(
  session: SessionState,
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  setMuteConsole(true);
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        AAR_SESSION_ID: session.id,
      },
    });
  } catch (err: any) {
    await updateSession(session.id, {
      status: "failed",
      resumeError: `Failed to start ${command}: ${err.message}`,
      pid: undefined,
    });
    logger.error(`Failed to start managed process for session ${session.id}: ${err.message}`, "aar");
    throw err;
  }

  // Do not yield before installing the error listener for an unsuccessful spawn.
  const started = updateSession(session.id, { pid: child.pid, status: "running" });


  let limitDetected = false;
  let accumulatedOutput = "";

  if (child.stdin) {
    process.stdin.pipe(child.stdin);
  }

  if (child.stdout) {
    child.stdout.on("data", (data: Buffer) => {
      process.stdout.write(data);

      const str = data.toString("utf-8");
      accumulatedOutput += str;
      if (accumulatedOutput.length > 8192) {
        accumulatedOutput = accumulatedOutput.slice(-4096);
      }

      checkLimit(str);
    });
  }

  if (child.stderr) {
    child.stderr.on("data", (data: Buffer) => {
      process.stderr.write(data);

      const str = data.toString("utf-8");
      accumulatedOutput += str;
      if (accumulatedOutput.length > 8192) {
        accumulatedOutput = accumulatedOutput.slice(-4096);
      }

      checkLimit(str);
    });
  }

  async function checkLimit(str: string) {
    await started;
    if (!limitDetected) {
      const detection = detectLimit(accumulatedOutput, session.provider);
      if (detection.matched) {
        limitDetected = true;
        
        const resetAtStr = detection.resetAt ? detection.resetAt.toISOString() : undefined;
        
        logger.warn(`Usage limit detected for ${session.provider}!`, "aar");

        await updateSession(session.id, {
          status: "waiting_limit_reset",
          lastLimitDetectedAt: new Date().toISOString(),
          resetAt: resetAtStr,
          lastOutputSnippet: accumulatedOutput.slice(-1000),
        });

        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    }
  }

  return new Promise<void>((resolve) => {
    child.on("error", async (err) => {
      await started;
      logger.error(`Managed child failed to start for session ${session.id}: ${err.message}`, "aar");
      const currentSession = await getSession(session.id);
      if (currentSession?.status === "running") {
        await updateSession(session.id, {
          status: "failed",
          pid: undefined,
          resumeError: `Failed to start ${command}: ${err.message}`,
        });
      }
      process.exitCode = 1;
      resolve();
    });

    child.on("exit", async (code) => {
      await started;
      const currentSession = await getSession(session.id);
      if (currentSession) {
        if (currentSession.status === "running") {
          await updateSession(session.id, {
            status: code === 0 ? "completed" : "failed",
            pid: undefined,
          });
        } else if (currentSession.status === "waiting_limit_reset") {
          await updateSession(session.id, {
            pid: undefined,
          });
        }
      }
      process.exit(code || 0);
    });
  });
}
