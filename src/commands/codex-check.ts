import { spawnSync } from "child_process";
import fs from "fs-extra";
import { DEFAULT_CONFIG, getConfigFile, resolveHome } from "../core/session-store.js";
import { readPid } from "../core/daemon-ipc.js";

export async function runCodexCheck() {
  let config = DEFAULT_CONFIG;
  if (await fs.pathExists(getConfigFile())) {
    try {
      const stored = await fs.readJson(getConfigFile());
      config = {
        ...DEFAULT_CONFIG,
        ...stored,
        providers: {
          ...DEFAULT_CONFIG.providers,
          ...stored.providers,
          codex: { ...DEFAULT_CONFIG.providers.codex, ...stored.providers?.codex },
        },
      };
    } catch {
      console.error(`Unable to parse config file: ${getConfigFile()}`);
    }
  }
  const codexConfig = config.providers.codex;
  const transcriptDirs = codexConfig.transcriptDirs.map(resolveHome);
  const command = codexConfig.command.trim().split(/\s+/)[0] || "codex";
  const help = spawnSync(command, ["exec", "resume", "--help"], {
    encoding: "utf8",
    timeout: 10_000,
    env: process.env,
  });
  const daemonPid = await readPid();
  let daemonRunning = false;
  if (daemonPid) {
    try {
      process.kill(daemonPid, 0);
      daemonRunning = true;
    } catch (err: any) {
      daemonRunning = err.code === "EPERM";
    }
  }

  const report = {
    providerEnabled: codexConfig.enabled,
    transcriptWatcherEnabled: codexConfig.watchTranscripts,
    transcriptDirs: await Promise.all(
      transcriptDirs.map(async (directory) => ({
        path: directory,
        exists: await fs.pathExists(directory),
      }))
    ),
    daemonRunning,
    cliCommand: command,
    cliAvailable: !help.error && help.status !== null,
    exactSessionResumeSupported: help.status === 0 && /SESSION_ID/.test(help.stdout || ""),
    diagnosticOnly: true,
  };

  console.log(JSON.stringify(report, null, 2));
  if (help.error) {
    console.error(`Codex CLI diagnostic failed: ${help.error.message}`);
  } else if (help.status !== 0) {
    console.error((help.stderr || help.stdout || "").trim());
  }
}
