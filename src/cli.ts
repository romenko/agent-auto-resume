#!/usr/bin/env node

import { Command } from "commander";
import { runSetup } from "./commands/setup.js";
import { handleDaemon } from "./commands/daemon.js";
import { runManaged } from "./commands/managed.js";
import { runGeneric } from "./commands/run.js";
import { runStatus } from "./commands/status.js";
import { runSessions, runGuiSessions } from "./commands/sessions.js";
import { runRecover } from "./commands/recover.js";
import { runRetryNow } from "./commands/retry-now.js";
import { runIntegrate, runUnintegrate } from "./commands/integrate.js";
import { runCodexCheck } from "./commands/codex-check.js";

const program = new Command();

program
  .name("aar")
  .description("Daemon-based auto-resume CLI tool for Claude Code, Codex, and Antigravity")
  .version("0.1.0");

program
  .command("setup")
  .description("Setup state directories, configuration, and shell integration")
  .option("--shell <type>", "Specify shell type (zsh, bash, fish)")
  .option("--no-shell-modify", "Do not modify shell configuration files automatically")
  .option("--print-shell-snippet", "Only print the shell snippet to stdout")
  .action(runSetup);

program
  .command("daemon <action>")
  .description("Manage the agent-auto-resume daemon (actions: start, stop, restart, status, logs, run)")
  .option("--tmux", "Enable experimental tmux watcher")
  .action((action, options) => handleDaemon(action, options));

program
  .command("managed <provider>")
  .description("Run a CLI tool in managed mode under PTY")
  .argument("[command...]", "Command to execute (e.g. claude, codex, agy)")
  .action((provider, args) => runManaged(provider, args));

program
  .command("run")
  .description("Generic run command to wrap any agent CLI under a provider")
  .option("--provider <provider>", "Specify provider (claude, codex, antigravity)")
  .argument("[command...]", "Command to execute")
  .action((args, options) => {
    // '--' の後の引数は args として渡される
    runGeneric(options, args);
  });

program
  .command("status")
  .description("Show daemon status, waiting sessions, and next resume schedules")
  .option("--json", "Format output as JSON")
  .action(runStatus);

program
  .command("sessions")
  .description("List all saved sessions and their statuses")
  .option("--json", "Format output as JSON")
  .action(runSessions);

program
  .command("gui-sessions")
  .description("List Codex Desktop sessions with detected limits")
  .option("--json", "Format output as JSON")
  .action(runGuiSessions);

program
  .command("codex-check")
  .description("Run local, non-billable Codex GUI monitoring diagnostics")
  .action(runCodexCheck);

program
  .command("cancel-session <session-id>")
  .description("Cancel automatic continuation for an AAR session")
  .action(async (sessionId) => {
    const { getSession, updateSession } = await import("./core/session-store.js");
    const session = await getSession(sessionId);
    if (!session) {
      console.error(`Session ${sessionId} not found.`);
      process.exitCode = 1;
      return;
    }
    if (!["waiting_limit_reset", "ready_to_resume", "failed"].includes(session.status)) {
      console.error(`Session ${sessionId} cannot be cancelled while status is '${session.status}'.`);
      process.exitCode = 1;
      return;
    }
    await updateSession(sessionId, { status: "cancelled" });
    console.log(`Automatic continuation cancelled for session ${sessionId}.`);
  });

program
  .command("recover")
  .description("Manually recover waiting, failed, or cancelled sessions")
  .option("--last", "Recover the most recent session")
  .option("--id <session-id>", "Recover session by ID")
  .action(runRecover);

program
  .command("retry-now")
  .description("Retry waiting sessions immediately")
  .option("--id <session-id>", "Session ID to retry")
  .option("--last", "Retry the most recent waiting session")
  .option("--force", "Force retry even if reset time has not passed")
  .action(runRetryNow);

program
  .command("integrate <app>")
  .description("Integrate supported application binaries (app: codex, antigravity, all)")
  .action(runIntegrate);

program
  .command("unintegrate <app>")
  .description("Restore original application binary and remove wrapper (app: codex, antigravity, all)")
  .action(runUnintegrate);


// One-shot wrapper commands
// これらはサブコマンド以下のすべてのオプションや引数をラップして managed mode に渡します。
program
  .command("claude")
  .description("One-shot wrapper to run Claude Code in managed mode")
  .allowUnknownOption()
  .action(() => {
    const idx = process.argv.indexOf("claude");
    const forwardedArgs = process.argv.slice(idx + 1);
    runManaged("claude", ["claude", ...forwardedArgs]);
  });

program
  .command("codex")
  .description("One-shot wrapper to run Codex CLI in managed mode")
  .allowUnknownOption()
  .action(() => {
    const idx = process.argv.indexOf("codex");
    const forwardedArgs = process.argv.slice(idx + 1);
    runManaged("codex", ["codex", ...forwardedArgs]);
  });

program
  .command("antigravity")
  .description("One-shot wrapper to run Antigravity CLI in managed mode")
  .allowUnknownOption()
  .action(() => {
    const idx = process.argv.indexOf("antigravity");
    const forwardedArgs = process.argv.slice(idx + 1);
    runManaged("antigravity", ["agy", ...forwardedArgs]);
  });

program
  .command("agy")
  .description("Alias for antigravity command")
  .allowUnknownOption()
  .action(() => {
    const idx = process.argv.indexOf("agy");
    const forwardedArgs = process.argv.slice(idx + 1);
    runManaged("antigravity", ["agy", ...forwardedArgs]);
  });

program.parse(process.argv);
