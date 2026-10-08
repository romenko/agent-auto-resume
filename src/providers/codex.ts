import { AgentProvider, LimitDetection, SessionState } from "../core/types.js";
import { parseTimeString } from "../core/time-parser.js";
import { CODEX_SAFE_RESUME_PROMPT } from "../prompts/safe-resume.js";

export const codexProvider: AgentProvider = {
  name: "codex",
  displayName: "OpenAI Codex CLI",
  defaultCommand: ["codex"],

  detectLimit(output: string, referenceDate?: Date): LimitDetection {
    const lines = output.split(/\r?\n/);
    const nonLimitFailure =
      /unauthori[sz]ed|authentication required|invalid (?:api )?key|failed to connect|network error|connection refused|invalid configuration|config(?:uration)? error/i;
    if (nonLimitFailure.test(output)) {
      return { matched: false, provider: "codex" };
    }
    const patterns = [
      /usage limit reached/i,
      /rate limit reached/i,
      /rate_limit_reached/i,
      /try again at/i,
      /resets_at/i,
      /usage_limit_reached/i,
      /usage limit/i,
      /rate limit exceeded/i,
      /exhausted your capacity/i,
      /code 429/i,
      /resource_exhausted/i,
    ];

    for (const line of lines) {
      const matched = patterns.some((p) => p.test(line));
      if (matched) {
        const resetAt = parseTimeString(line, referenceDate);
        return {
          matched: true,
          provider: "codex",
          reason: line.trim(),
          resetAt,
          raw: line,
        };
      }
    }

    return { matched: false, provider: "codex" };
  },

  getResumeCommand(state: SessionState): string[] {
    if (!state.providerSessionId) {
      throw new Error(`Codex session ${state.id} has no confirmed Codex thread ID; refusing to use --last.`);
    }
    return [
      "codex",
      "exec",
      "resume",
      state.providerSessionId,
      CODEX_SAFE_RESUME_PROMPT.trim(),
    ];
  },

  getTranscriptDirs(): string[] {
    return ["~/.codex/sessions"];
  },

  parseTranscriptEvent(line: string) {
    try {
      const data = JSON.parse(line);
      if (data && typeof data === "object") {
        const payload = data.payload || {};
        const isSessionMeta = data.type === "session_meta";
        const eventType = typeof payload.type === "string" ? payload.type : "";
        const errorEvent = data.type === "event_msg" && eventType === "error";
        const rateLimits = payload.info?.rate_limits || payload.rate_limits;
        const structuredLimit = Boolean(rateLimits?.rate_limit_reached_type);
        const text = isSessionMeta
          ? undefined
          : errorEvent || structuredLimit
            ? JSON.stringify(payload)
            : data.text || data.message || data.content || payload.message || payload.error || payload.text || payload.content;
        const cwd = data.cwd || payload.cwd;
        const sessionId = isSessionMeta
          ? payload.id || payload.session_id
          : undefined;
        const timestamp = data.timestamp || payload.timestamp || data.createdAt || payload.createdAt;
        return {
          text: typeof text === "string" ? text : undefined,
          cwd: typeof cwd === "string" ? cwd : undefined,
          sessionId: typeof sessionId === "string" ? sessionId : undefined,
          timestamp: typeof timestamp === "string" ? timestamp : undefined,
          desktopSession: isSessionMeta && payload.originator === "Codex Desktop",
          limitEvent: errorEvent || structuredLimit,
        };
      }
    } catch {
      // ignore
    }
    return undefined;
  },
};
