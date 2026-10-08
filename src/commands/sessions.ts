import { listSessions } from "../core/session-store.js";
import chalk from "chalk";

export async function runSessions(options: { json?: boolean }) {
  const sessions = await listSessions();

  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  console.log(chalk.bold(`--- agent-auto-resume sessions (${sessions.length}) ---`));
  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  for (const s of sessions) {
    const statusColor =
      s.status === "completed"
        ? chalk.green
        : s.status === "waiting_limit_reset"
        ? chalk.yellow
        : s.status === "failed"
        ? chalk.red
        : s.status === "running"
        ? chalk.blue
        : chalk.gray;

    console.log(`\nSession ID: ${chalk.cyan(s.id)} [${s.provider}]`);
    console.log(`  Status: ${statusColor(s.status)}`);
    console.log(`  CWD: ${s.cwd}`);
    console.log(`  Created: ${new Date(s.createdAt).toLocaleString()}`);
    console.log(`  Command: ${s.originalCommand.join(" ")}`);
    if (s.resetAt) {
      console.log(`  Reset time: ${new Date(s.resetAt).toLocaleString()}`);
    }
  }
}

export async function runGuiSessions(options: { json?: boolean }) {
  const sessions = (await listSessions()).filter(
    (session) => session.provider === "codex" && session.codexDesktop
  );
  if (options.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  console.log(chalk.bold(`--- Codex GUI sessions (${sessions.length}) ---`));
  if (!sessions.length) {
    console.log("No Codex GUI sessions with detected limits.");
    return;
  }
  for (const session of sessions) {
    console.log(`\nThread ID: ${chalk.cyan(session.providerSessionId || session.id)}`);
    console.log(`  AAR status: ${session.status}`);
    console.log(`  CWD: ${session.cwd}`);
    if (session.resetAt) {
      console.log(`  Next attempt: ${new Date(new Date(session.resetAt).getTime() + session.bufferSeconds * 1000).toLocaleString()}`);
    }
    if (session.resumeError) {
      console.log(`  Resume reason: ${session.resumeError}`);
    }
  }
}
