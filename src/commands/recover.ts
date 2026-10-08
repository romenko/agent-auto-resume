import { getSession, getLastSession, getRecoverableSessions, updateSession } from "../core/session-store.js";
import { resumeSessionInBackground } from "../core/process-manager.js";
import chalk from "chalk";

export async function runRecover(options: { last?: boolean; id?: string }) {
  let session;

  if (options.id) {
    session = await getSession(options.id);
    if (!session) {
      console.error(chalk.red(`Error: Session with ID ${options.id} not found.`));
      process.exit(1);
    }
  } else if (options.last) {
    session = await getLastSession();
    if (!session) {
      console.error(chalk.red("Error: No sessions found."));
      process.exit(1);
    }
  } else {
    const recoverable = await getRecoverableSessions();
    if (recoverable.length === 0) {
      console.log("No recoverable sessions found.");
      return;
    }
    console.log(chalk.bold("Recoverable sessions:"));
    for (const r of recoverable) {
      console.log(`  - ID: ${chalk.cyan(r.id)} [${r.provider}] Status: ${r.status} (${r.originalCommand.join(" ")})`);
    }
    console.log("\nUse 'aar recover --id <session-id>' or 'aar recover --last' to recover.");
    return;
  }

  const recoverableStatuses = ["waiting_limit_reset", "ready_to_resume", "failed", "resuming", "cancelled"];
  if (!recoverableStatuses.includes(session.status)) {
    console.warn(chalk.yellow(`Warning: Session ${session.id} status is '${session.status}', which might not need recovery.`));
  }

  console.log(`Attempting to recover session ${chalk.cyan(session.id)}...`);
  await updateSession(session.id, {
    source: "manual-recover",
  });

  const success = await resumeSessionInBackground(session);
  if (success) {
    console.log(chalk.green(`✓ Session ${session.id} recovered and completed successfully.`));
  } else {
    const updated = await getSession(session.id);
    console.log(chalk.red(`✗ Recovery failed or session hit limit again. ${updated?.resumeError || "Status is currently saved."}`));
  }
}
