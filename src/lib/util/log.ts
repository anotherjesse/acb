import process from "node:process";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function resolveLogLevel(raw: string | undefined = process.env.LOG_LEVEL): LogLevel {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return "info";
}

export function shouldLog(level: LogLevel, configured: LogLevel): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[configured];
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const configured = resolveLogLevel();
  if (!shouldLog(level, configured)) {
    return;
  }

  const timestamp = new Date().toISOString();
  if (!meta || Object.keys(meta).length === 0) {
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    return;
  }

  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message} ${safeStringify(meta)}`);
}
