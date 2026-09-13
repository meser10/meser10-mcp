/**
 * Configuration and the safety gate.
 *
 * Two rules drive this file:
 *  1. Credentials come from the environment only. The server never takes a
 *     password, never logs a key, and never echoes one back through a tool
 *     result. CLoginInfo accepts ApiKey, so the password path is simply unused.
 *  2. Nothing that costs money or touches a real recipient is reachable unless
 *     the operator opted in. Default is read-only.
 */

export const MODES = ["read", "write", "send", "destructive"] as const;
export type Mode = (typeof MODES)[number];

/** A mode implies every less dangerous mode below it. */
const MODE_RANK: Record<Mode, number> = {
  read: 0,
  write: 1,
  send: 2,
  destructive: 3,
};

export interface Config {
  apiKey: string;
  /**
   * Optional. 44 of the 61 operations carry an explicit iUserID; the other 17
   * (GetGroupsList and friends) resolve the account from the ApiKey alone.
   * Proven live on 12/09/2026: GetGroupsList returned real lists with no
   * iUserID in the envelope. So a read-only operator must not be blocked at
   * startup for a field their tools never send - the error belongs at the
   * call that actually needs it.
   */
  userId?: number;
  endpoint: string;
  mode: Mode;
  maxRecipients: number;
}

export class ConfigError extends Error {}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || !v.trim()) {
    throw new ConfigError(
      `${name} is not set. Copy .env.example and fill it in, or export the variable before starting the server.`,
    );
  }
  return v.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = req(env, "MESER10_API_KEY");

  const rawUser = env.MESER10_USER_ID?.trim();
  let userId: number | undefined;
  if (rawUser) {
    userId = Number(rawUser);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new ConfigError(`MESER10_USER_ID must be a positive integer, got ${JSON.stringify(rawUser)}.`);
    }
  }

  const mode = (env.MESER10_MODE?.trim() || "read") as Mode;
  if (!MODES.includes(mode)) {
    throw new ConfigError(`MESER10_MODE must be one of ${MODES.join(" | ")}, got ${JSON.stringify(mode)}.`);
  }

  const maxRecipients = Number(env.MESER10_MAX_RECIPIENTS?.trim() || "100");
  if (!Number.isInteger(maxRecipients) || maxRecipients < 1) {
    throw new ConfigError("MESER10_MAX_RECIPIENTS must be a positive integer.");
  }

  return {
    apiKey,
    userId,
    endpoint: env.MESER10_ENDPOINT?.trim() || "https://ns.mesereser.com/Services/Services.asmx",
    mode,
    maxRecipients,
  };
}

export function modeAllows(configured: Mode, required: Mode): boolean {
  return MODE_RANK[configured] >= MODE_RANK[required];
}

/**
 * Redacts anything that looks like a credential before it reaches a log line or
 * a tool result. Cheap insurance: a SOAP fault echoes the request back often
 * enough that this is not theoretical.
 */
export function redact(text: string, cfg: Pick<Config, "apiKey">): string {
  if (!cfg.apiKey) return text;
  return text
    .split(cfg.apiKey)
    .join("***REDACTED***")
    .replace(/<Password>[^<]*<\/Password>/gi, "<Password>***REDACTED***</Password>")
    .replace(/<ApiKey>[^<]*<\/ApiKey>/gi, "<ApiKey>***REDACTED***</ApiKey>");
}
