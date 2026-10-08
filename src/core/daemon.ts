import { loadConfig, getWaitingSessions, listSessions, updateSession, ensureDirs } from "./session-store.js";
import { logger } from "./logger.js";
import { writePid, clearPid, isDaemonRunning } from "./daemon-ipc.js";
import { startTranscriptWatcher } from "./transcript-watcher.js";
import { startTmuxWatcher, sendKeysToTmux } from "./tmux-watcher.js";
import { getWaitMs } from "./scheduler.js";
import { resumeSessionInBackground } from "./process-manager.js";
import { getProvider } from "../providers/index.js";

export interface DaemonOptions {
  tmux?: boolean;
}

export class AarDaemon {
  private abortController: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  async start(options: DaemonOptions = {}) {
    if (await isDaemonRunning()) {
      logger.error("Daemon is already running.", "aar");
      process.exit(1);
    }

    await ensureDirs();
    await this.recoverInterruptedResumes();
    await writePid(process.pid);
    logger.info(`Daemon started with PID ${process.pid}`, "aar");

    this.abortController = new AbortController();
    const config = await loadConfig();

    if (options.tmux !== undefined) {
      config.tmux.enabled = options.tmux;
    }

    await startTranscriptWatcher(this.abortController.signal);
    if (config.tmux.enabled) {
      await startTmuxWatcher(this.abortController.signal);
    }

    const shutdown = async () => {
      logger.info("Daemon shutting down...", "aar");
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.abortController?.abort();
      await clearPid();
      logger.info("Daemon stopped.", "aar");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const loop = async () => {
      if (this.abortController?.signal.aborted) {
        return;
      }
      if (!this.isProcessing) {
        this.isProcessing = true;
        try {
          await this.processWaitingSessions();
        } catch (err: any) {
          logger.error(`Error in daemon loop: ${err.message}`, "aar");
        } finally {
          this.isProcessing = false;
        }
      }
      this.timer = setTimeout(loop, config.daemon.pollIntervalMs || 5000);
    };

    loop();
  }

  private async processWaitingSessions() {
    await this.reconcileInterruptedSessions();
    const waiting = await getWaitingSessions();

    for (const session of waiting) {
      if (!session.resetAt) {
        const fallbackResetAt = new Date().toISOString();
        logger.info(`Session ${session.id} reset time is unknown. Falling back to default wait (using buffer duration).`, "aar");
        await updateSession(session.id, {
          resetAt: fallbackResetAt,
        });
        session.resetAt = fallbackResetAt;
      }

      const waitMsLeft = getWaitMs(session);
      if (waitMsLeft <= 0) {
        logger.info(`Session ${session.id} is ready to resume (Wait completed).`, "aar");
        
        await updateSession(session.id, {
          status: "ready_to_resume",
        });

        if (session.attempts >= session.maxAttempts) {
          logger.warn(`Session ${session.id} exceeded max resume attempts (${session.maxAttempts}). Mark as failed.`, "aar");
          await updateSession(session.id, {
            status: "failed",
          });
          continue;
        }

        if (session.source === "tmux-watcher" && session.tmuxPaneId) {
          const provider = getProvider(session.provider);
          const resumeInput = provider.getResumeInput ? await provider.getResumeInput(session) : undefined;
          
          if (resumeInput) {
            logger.info(`Resuming tmux session ${session.id} in pane ${session.tmuxPaneId}`, "aar");
            await updateSession(session.id, {
              status: "resuming",
              attempts: session.attempts + 1,
            });

            const sent = sendKeysToTmux(session.tmuxPaneId, resumeInput);
            if (sent) {
              await updateSession(session.id, {
                status: "running",
              });
              logger.info(`Sent resume input to tmux pane successfully.`, "aar");
            } else {
              await updateSession(session.id, {
                status: "failed",
              });
            }
          } else {
            await updateSession(session.id, {
              status: "failed",
            });
          }
        } else {
          void resumeSessionInBackground(session).then((success) => {
            if (success) {
              logger.info(`Session ${session.id} resumed and completed successfully.`, "aar");
            } else {
              logger.warn(`Session ${session.id} resume failed or hit limit again.`, "aar");
            }
          }).catch(async (err: any) => {
            logger.error(`Failed to resume session ${session.id}: ${err.message}`, "aar");
            await updateSession(session.id, {
              status: "failed",
              resumeError: err.message,
            });
          });
        }
      } else {
        const secondsLeft = Math.ceil(waitMsLeft / 1000);
        logger.debug(`Session ${session.id} waiting... ${secondsLeft}s left`, "aar");
      }
    }
  }

  private async recoverInterruptedResumes() {
    await this.reconcileInterruptedSessions();
  }

  private async reconcileInterruptedSessions() {
    const sessions = await listSessions();
    for (const session of sessions.filter((item) =>
      item.status === "resuming" || (item.status === "running" && item.source === "managed-pty")
    )) {
      if (Date.now() - new Date(session.updatedAt).getTime() < 60_000) {
        continue;
      }
      let processAlive = false;
      const pid = session.status === "resuming" ? session.resumePid : session.pid;
      if (pid) {
        try {
          process.kill(pid, 0);
          processAlive = true;
        } catch (err: any) {
          processAlive = err.code === "EPERM";
        }
      }
      if (!processAlive) {
        await updateSession(session.id, {
          status: "failed",
          pid: undefined,
          resumePid: undefined,
          resumeError: "The recorded process stopped or its state is unknown; inspect the workspace before retrying.",
        });
        logger.warn(`Marked interrupted session ${session.id} as failed for manual inspection.`, "aar");
      }
    }
  }
}
