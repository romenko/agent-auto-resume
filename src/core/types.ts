export type ProviderName = "claude" | "codex" | "antigravity";

export type LimitDetection = {
  matched: boolean;
  provider: ProviderName;
  reason?: string;
  resetAt?: Date;
  retryAfterSeconds?: number;
  raw?: string;
};

export type SessionStatus =
  | "running"
  | "limit_detected"
  | "waiting_limit_reset"
  | "ready_to_resume"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled";

export type ResumeStrategy =
  | "pty-input"
  | "command"
  | "command-with-prompt"
  | "unknown";

export type SessionState = {
  id: string;
  provider: ProviderName;
  cwd: string;
  originalCommand: string[];
  resumeCommand?: string[];
  resumeInput?: string;
  resumeStrategy: ResumeStrategy;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastLimitDetectedAt?: string;
  resetAt?: string;
  attempts: number;
  maxAttempts: number;
  bufferSeconds: number;
  lastOutputSnippet?: string;
  managedByAar: boolean;
  source:
    | "managed-pty"
    | "transcript-watcher"
    | "tmux-watcher"
    | "manual-recover";
  pid?: number;
  resumePid?: number;
  tmuxPaneId?: string;
  transcriptPath?: string;
  providerSessionId?: string;
  codexDesktop?: boolean;
  resumeError?: string;
};

export interface AgentProvider {
  name: ProviderName;
  displayName: string;
  defaultCommand: string[];

  detectLimit(output: string, referenceDate?: Date): LimitDetection;

  getResumeCommand(state: SessionState): Promise<string[]> | string[];

  getResumeInput?(state: SessionState): Promise<string | undefined> | string | undefined;

  getTranscriptDirs?(): string[];

  parseTranscriptEvent?(line: string): {
    text?: string;
    cwd?: string;
    sessionId?: string;
    timestamp?: string;
    desktopSession?: boolean;
    limitEvent?: boolean;
  } | undefined;
}

export type ProviderConfig = {
  enabled: boolean;
  command: string;
  watchTranscripts: boolean;
  transcriptDirs: string[];
  experimental?: boolean;
};

export type AarConfig = {
  version: number;
  bufferSeconds: number;
  maxAttempts: number;
  providers: {
    claude: ProviderConfig;
    codex: ProviderConfig;
    antigravity: ProviderConfig;
  };
  tmux: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  daemon: {
    pollIntervalMs: number;
  };
};
