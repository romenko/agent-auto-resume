import fs from "fs-extra";
import path from "path";
import os from "os";
import { execSync } from "child_process";

// ホームディレクトリ解決用の補助関数
function resolveHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// aarの絶対パスを取得する
function getAarPath(): string {
  try {
    const whichAar = execSync("which aar", { encoding: "utf8" }).trim();
    if (whichAar) return whichAar;
  } catch {
    // ignore
  }
  // フォールバック（典型的なグローバルインストール先）
  const home = os.homedir();
  const possiblePaths = [
    path.join(home, ".hermes/node/bin/aar"),
    path.join(home, ".npm-global/bin/aar"),
    "/usr/local/bin/aar",
    "/opt/homebrew/bin/aar",
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return "aar"; // 最悪フォールバック
}

interface IntegrationTarget {
  name: string;
  originalPath: string;
  backupPath: string;
  provider: string;
  getWrapperContent: (aarPath: string) => string;
}

const targets: Record<string, IntegrationTarget[]> = {
  codex: [
    {
      name: "Codex Mac App",
      originalPath: "/Applications/Codex.app/Contents/Resources/codex",
      backupPath: "/Applications/Codex.app/Contents/Resources/codex.orig",
      provider: "codex",
      getWrapperContent: (aarPath) => `#!/bin/bash
# original internal binary: /Applications/Codex.app/Contents/Resources/codex.orig

if [ -x "${aarPath}" ]; then
  exec "${aarPath}" managed codex -- /Applications/Codex.app/Contents/Resources/codex.orig "$@"
elif command -v aar >/dev/null 2>&1; then
  exec aar managed codex -- /Applications/Codex.app/Contents/Resources/codex.orig "$@"
else
  exec /Applications/Codex.app/Contents/Resources/codex.orig "$@"
fi
`,
    },
  ],
  antigravity: [
    {
      name: "Antigravity Mac App Server",
      originalPath: "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
      backupPath: "/Applications/Antigravity.app/Contents/Resources/bin/language_server.orig",
      provider: "antigravity",
      getWrapperContent: (aarPath) => `#!/bin/bash
# original internal binary: /Applications/Antigravity.app/Contents/Resources/bin/language_server.orig

if [ -x "${aarPath}" ]; then
  exec "${aarPath}" managed antigravity -- /Applications/Antigravity.app/Contents/Resources/bin/language_server.orig "$@"
elif command -v aar >/dev/null 2>&1; then
  exec aar managed antigravity -- /Applications/Antigravity.app/Contents/Resources/bin/language_server.orig "$@"
else
  exec /Applications/Antigravity.app/Contents/Resources/bin/language_server.orig "$@"
fi
`,
    },
    {
      name: "Antigravity CLI (agy)",
      originalPath: "~/.local/bin/agy",
      backupPath: "~/.local/bin/agy.orig",
      provider: "antigravity",
      getWrapperContent: (aarPath) => `#!/bin/bash
# original system binary: \$HOME/.local/bin/agy.orig

if [ -x "${aarPath}" ]; then
  exec "${aarPath}" managed antigravity -- "\$HOME/.local/bin/agy.orig" "$@"
elif command -v aar >/dev/null 2>&1; then
  exec aar managed antigravity -- "\$HOME/.local/bin/agy.orig" "$@"
else
  exec "\$HOME/.local/bin/agy.orig" "$@"
fi
`,
    },
  ],
};

export async function runIntegrate(appName: string) {
  const aarPath = getAarPath();
  const keys = appName === "all" ? Object.keys(targets) : [appName];

  for (const key of keys) {
    const appTargets = targets[key];
    if (!appTargets) {
      console.error(`Unknown integration app: ${appName}. Supported: codex, antigravity, all`);
      process.exit(1);
    }

    if (key === "codex") {
      console.log("Codex GUI integration uses transcript observation; installed app files will not be modified.");
      continue;
    }

    console.log(`Setting up integration for ${key}...`);
    for (const t of appTargets) {
      const orig = resolveHome(t.originalPath);
      const backup = resolveHome(t.backupPath);

      if (!fs.existsSync(orig) && !fs.existsSync(backup)) {
        console.warn(`  [Skip] ${t.name} not found at ${orig}`);
        continue;
      }

      try {
        // 1. すでに退避済みの場合はスキップ、または退避
        if (!fs.existsSync(backup)) {
          await fs.move(orig, backup);
          console.log(`  [Backuped] ${orig} -> ${backup}`);
        }

        // 2. ラッパースクリプトの書き出し
        const content = t.getWrapperContent(aarPath);
        await fs.writeFile(orig, content, "utf-8");
        await fs.chmod(orig, 0o755);
        console.log(`  [Integrated] Created wrapper at ${orig}`);
      } catch (err: any) {
        console.error(`  [Error] Failed to integrate ${t.name}: ${err?.message}`);
      }
    }
  }
  console.log("Integration setup completed.");
}

export async function runUnintegrate(appName: string) {
  const keys = appName === "all" ? Object.keys(targets) : [appName];

  for (const key of keys) {
    const appTargets = targets[key];
    if (!appTargets) {
      console.error(`Unknown integration app: ${appName}. Supported: codex, antigravity, all`);
      process.exit(1);
    }

    console.log(`Reverting integration for ${key}...`);
    for (const t of appTargets) {
      const orig = resolveHome(t.originalPath);
      const backup = resolveHome(t.backupPath);

      if (!fs.existsSync(backup)) {
        console.warn(`  [Skip] Backup for ${t.name} not found at ${backup}`);
        continue;
      }

      try {
        // 1. ラッパーを削除（あれば）
        if (fs.existsSync(orig)) {
          await fs.remove(orig);
        }
        // 2. バックアップを元の位置に復元
        await fs.move(backup, orig);
        console.log(`  [Restored] Reverted ${backup} -> ${orig}`);
      } catch (err: any) {
        console.error(`  [Error] Failed to unintegrate ${t.name}: ${err?.message}`);
      }
    }
  }
  console.log("Unintegration completed.");
}
