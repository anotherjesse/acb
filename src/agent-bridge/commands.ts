export type BridgeCommand =
  | { type: "help" }
  | { type: "new" }
  | { type: "status" }
  | { type: "stop" }
  | { type: "run"; prompt: string }
  | { type: "unknown"; raw: string };

export function parseBridgeCommand(input: string): BridgeCommand {
  const text = input.trim();
  const lowered = text.toLowerCase();

  if (lowered === "/start" || lowered === "/help") {
    return { type: "help" };
  }

  if (lowered === "/new") {
    return { type: "new" };
  }

  if (lowered === "/status") {
    return { type: "status" };
  }

  if (lowered === "/stop") {
    return { type: "stop" };
  }

  if (/^\/run(?:\s|$)/i.test(text)) {
    const prompt = text.replace(/^\/run(?:\s+|$)/i, "").trim();
    return { type: "run", prompt };
  }

  if (text.startsWith("/")) {
    return { type: "unknown", raw: text };
  }

  return { type: "run", prompt: text };
}

export function isStaleResumeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("state db missing rollout path for thread") ||
    normalized.includes("missing rollout path for thread")
  );
}
