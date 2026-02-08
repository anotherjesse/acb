import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { Codex, Thread, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

import { MatrixClient } from "../lib/matrix/client.js";
import { MatrixSyncEvent } from "../lib/matrix/types.js";
import { formatError, log } from "../lib/util/log.js";
import { readBoolean, truncate } from "../lib/util/strings.js";
import { normalizeHomeserverUrl } from "../lib/util/matrixUrl.js";
import { isStaleResumeError, parseBridgeCommand } from "./commands.js";

type BridgeConfig = {
  homeserverUrl: string;
  accessToken: string;
  botUserId: string;
  roomId: string;
  projectKey?: string;
  sparkProject?: string;
  sparkName?: string;
  initialPrompt?: string;
  syncTimeoutMs: number;
  sessionFile: string;
};

type SavedSession = {
  threadId?: string;
};

type ActiveRun = {
  abortController: AbortController;
  done: Promise<void>;
};

type BridgeState = {
  thread: Thread;
  activeRun?: ActiveRun;
};

const codex = new Codex();
const config = readConfig();
const matrix = new MatrixClient({
  homeserverUrl: config.homeserverUrl,
  accessToken: config.accessToken,
  botUserId: config.botUserId,
});

const savedSessions = loadSavedSessions(config.sessionFile);
const sessionKey = `${config.roomId}::${config.projectKey ?? "project"}::${config.sparkName ?? "spark"}`;
const state: BridgeState = {
  thread: resolveInitialThread(),
};

let isRunning = true;
let sinceToken: string | undefined;

void main().catch((error) => {
  log("error", "AgentBridge fatal startup failure.", { error: formatError(error) });
  process.exitCode = 1;
});

process.once("SIGINT", () => {
  isRunning = false;
});

process.once("SIGTERM", () => {
  isRunning = false;
});

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled promise rejection.", { reason: formatError(reason) });
});

process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception.", { error: formatError(error) });
});

async function main(): Promise<void> {
  await matrix.verifyConnection();
  await matrix.ensureJoinedRoom(config.roomId);

  await sendStatus("active", [
    "AgentBridge online.",
    `room_id: ${config.roomId}`,
    `project_key: ${config.projectKey ?? "(unknown)"}`,
    `spark: ${config.sparkProject ?? "(unknown)"}:${config.sparkName ?? "(unknown)"}`,
    `started_at: ${new Date().toISOString()}`,
  ]);

  sinceToken = (await matrix.sync(undefined, 0, [config.roomId])).next_batch;

  if (config.initialPrompt && config.initialPrompt.trim()) {
    const initial = config.initialPrompt.trim();
    await matrix.sendNotice(config.roomId, `Running initial prompt (${truncate(initial, 220)}).`);
    await startOrReplaceRun(initial);
  }

  while (isRunning) {
    try {
      const sync = await matrix.sync(sinceToken, config.syncTimeoutMs, [config.roomId]);
      await handleSync(sync.rooms?.join?.[config.roomId]?.timeline?.events ?? []);
      sinceToken = sync.next_batch;
    } catch (error) {
      log("error", "AgentBridge sync loop failed.", {
        roomId: config.roomId,
        error: formatError(error),
      });
      await sleep(1500);
    }
  }

  await matrix.sendNotice(config.roomId, "AgentBridge shutting down.");
}

async function handleSync(events: MatrixSyncEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (error) {
      await sendStatus("error", [`Event handling failed: ${truncate(formatError(error), 800)}`]);
      log("error", "Failed to handle Matrix event.", {
        roomId: config.roomId,
        eventId: event.event_id,
        error: formatError(error),
      });
    }
  }
}

async function handleEvent(event: MatrixSyncEvent): Promise<void> {
  if (event.type !== "m.room.message") {
    return;
  }

  if (!event.sender || event.sender === config.botUserId) {
    return;
  }

  const body = event.content?.body?.trim();
  if (!body) {
    return;
  }

  log("info", "Incoming task-room message.", {
    roomId: config.roomId,
    sender: event.sender,
    body: truncate(body, 220),
  });

  await handleIncomingText(body);
}

async function handleIncomingText(text: string): Promise<void> {
  const command = parseBridgeCommand(text);

  if (command.type === "help") {
    await matrix.sendNotice(
      config.roomId,
      [
        "Commands:",
        "/run <prompt> - run a Codex turn",
        "/new - reset to a fresh Codex session",
        "/stop - interrupt the active run",
        "/status - show bridge/session details",
        "plain text - treated as /run",
      ].join("\n"),
    );
    return;
  }

  if (command.type === "new") {
    state.thread = codex.startThread(threadOptionsFromEnv());
    savedSessions[sessionKey] = {};
    saveSessions(config.sessionFile, savedSessions);
    await matrix.sendNotice(config.roomId, "Started a new Codex session for this task room.");
    return;
  }

  if (command.type === "status") {
    await matrix.sendNotice(
      config.roomId,
      [
        `status: ${state.activeRun ? "active" : "needs_input"}`,
        `room_id: ${config.roomId}`,
        `project_key: ${config.projectKey ?? "(unknown)"}`,
        `spark: ${config.sparkProject ?? "(unknown)"}:${config.sparkName ?? "(unknown)"}`,
        state.thread.id ? `codex_thread: ${state.thread.id}` : "codex_thread: (none yet)",
      ].join("\n"),
    );
    return;
  }

  if (command.type === "stop") {
    if (!state.activeRun) {
      await matrix.sendNotice(config.roomId, "No active run to stop.");
      return;
    }

    state.activeRun.abortController.abort();
    await sendStatus("needs_input", ["Stopping active run..."]);
    return;
  }

  if (command.type === "run") {
    if (!command.prompt) {
      await matrix.sendNotice(config.roomId, "Usage: /run <prompt>");
      return;
    }

    await startOrReplaceRun(command.prompt);
    return;
  }

  if (command.type === "unknown") {
    await matrix.sendNotice(config.roomId, "Unknown command. Use /help.");
    return;
  }
}

async function startOrReplaceRun(prompt: string): Promise<void> {
  if (state.activeRun) {
    state.activeRun.abortController.abort();
    try {
      await state.activeRun.done;
    } catch {
      // ignore cancellation errors.
    }
    await matrix.sendNotice(config.roomId, "Previous run interrupted. Starting latest prompt.");
  }

  const abortController = new AbortController();
  const done = runPrompt(prompt, abortController);
  state.activeRun = { abortController, done };

  try {
    await done;
  } finally {
    if (state.activeRun?.done === done) {
      state.activeRun = undefined;
    }
  }
}

async function runPrompt(prompt: string, abortController: AbortController): Promise<void> {
  await sendStatus("active", ["Starting Codex..."]);

  const typingInterval = setInterval(() => {
    void matrix.sendTyping(config.roomId, 5000).catch(() => {
      // ignore typing failures
    });
  }, 4000);

  const emitStatus = createStatusEmitter();
  const maxAttempts = 2;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let streamError: string | null = null;
      let finalResponse = "";

      try {
        const { events } = await state.thread.runStreamed(prompt, {
          signal: abortController.signal,
        });

        for await (const event of events) {
          const statusLine = eventToStatus(event);
          if (statusLine) {
            await emitStatus(statusLine);
          }

          if (event.type === "thread.started") {
            savedSessions[sessionKey] = { threadId: event.thread_id };
            saveSessions(config.sessionFile, savedSessions);
          }

          if (event.type === "item.completed" && event.item.type === "agent_message") {
            finalResponse = event.item.text;
          }

          if (event.type === "turn.failed") {
            streamError = event.error.message;
          }

          if (event.type === "error") {
            streamError = event.message;
          }
        }

        if (streamError) {
          if (attempt < maxAttempts && isStaleResumeError(streamError)) {
            resetThread();
            await matrix.sendNotice(
              config.roomId,
              "Previous session is unavailable. Starting a fresh session and retrying once.",
            );
            continue;
          }

          await sendStatus("error", [`Run failed: ${truncate(streamError, 1600)}`]);
          return;
        }

        if (finalResponse) {
          await matrix.sendMessage(config.roomId, truncate(finalResponse, 30_000), "m.text");
        } else {
          await matrix.sendNotice(config.roomId, "Done.");
        }

        await sendStatus("completed", ["Turn complete. Ready for next prompt."]);
        return;
      } catch (error) {
        const message = formatError(error);

        if (abortController.signal.aborted) {
          await sendStatus("needs_input", ["Run interrupted."]);
          return;
        }

        if (attempt < maxAttempts && isStaleResumeError(message)) {
          resetThread();
          await matrix.sendNotice(
            config.roomId,
            "Previous session is unavailable. Starting a fresh session and retrying once.",
          );
          continue;
        }

        await sendStatus("error", [`Error: ${truncate(message, 1600)}`]);
        return;
      }
    }
  } finally {
    clearInterval(typingInterval);
  }
}

function createStatusEmitter(): (text: string) => Promise<void> {
  let lastText = "";
  let lastSentAt = 0;

  return async (text: string): Promise<void> => {
    const next = truncate(text, 800);
    if (!next || next === lastText) {
      return;
    }

    const now = Date.now();
    if (now - lastSentAt < 2200) {
      return;
    }

    lastText = next;
    lastSentAt = now;
    await matrix.sendNotice(config.roomId, next);
  };
}

async function sendStatus(status: "active" | "needs_input" | "completed" | "error", lines: string[]): Promise<void> {
  const text = [`status: ${status}`, ...lines].join("\n");
  await matrix.sendNotice(config.roomId, text);
}

function eventToStatus(event: ThreadEvent): string | null {
  switch (event.type) {
    case "thread.started":
      return "Session started.";
    case "turn.started":
      return "Codex is working...";
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = event.item;
      if (item.type === "command_execution") {
        const prefix = item.status === "in_progress" ? "Running" : "Command";
        return `${prefix}: ${truncate(item.command, 200)}`;
      }

      if (item.type === "web_search") {
        return `Searching: ${truncate(item.query, 220)}`;
      }

      if (item.type === "reasoning") {
        return `Thinking: ${truncate(item.text, 220)}`;
      }

      if (item.type === "error") {
        return `Error: ${truncate(item.message, 220)}`;
      }

      return null;
    }
    case "turn.completed":
      return `Turn complete (tokens in/out: ${event.usage.input_tokens}/${event.usage.output_tokens}).`;
    case "turn.failed":
      return `Turn failed: ${truncate(event.error.message, 220)}`;
    case "error":
      return `Stream error: ${truncate(event.message, 220)}`;
    default:
      return null;
  }
}

function resolveInitialThread(): Thread {
  const saved = savedSessions[sessionKey];
  if (saved?.threadId) {
    return codex.resumeThread(saved.threadId, threadOptionsFromEnv());
  }
  return codex.startThread(threadOptionsFromEnv());
}

function resetThread(): void {
  state.thread = codex.startThread(threadOptionsFromEnv());
  savedSessions[sessionKey] = {};
  saveSessions(config.sessionFile, savedSessions);
}

function threadOptionsFromEnv(): ThreadOptions {
  const yolo = readBoolean(process.env.CODEX_YOLO);

  const sandboxMode =
    (process.env.CODEX_SANDBOX_MODE as ThreadOptions["sandboxMode"] | undefined) ??
    (yolo ? "danger-full-access" : undefined);
  const approvalPolicy =
    (process.env.CODEX_APPROVAL_POLICY as ThreadOptions["approvalPolicy"] | undefined) ??
    (yolo ? "never" : undefined);

  const additionalDirectories = process.env.CODEX_ADDITIONAL_DIRECTORIES
    ? process.env.CODEX_ADDITIONAL_DIRECTORIES.split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    : undefined;

  return {
    model: process.env.CODEX_MODEL,
    workingDirectory: process.env.CODEX_WORKING_DIRECTORY,
    skipGitRepoCheck: readBoolean(process.env.CODEX_SKIP_GIT_REPO_CHECK),
    networkAccessEnabled: readBoolean(process.env.CODEX_NETWORK_ACCESS),
    sandboxMode,
    approvalPolicy,
    additionalDirectories,
  };
}

function readConfig(): BridgeConfig {
  const homeserverRaw = process.env.MATRIX_HOMESERVER_URL?.trim();
  if (!homeserverRaw) {
    throw new Error("Missing MATRIX_HOMESERVER_URL.");
  }

  const accessToken = process.env.MATRIX_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error("Missing MATRIX_ACCESS_TOKEN.");
  }

  const botUserId = process.env.MATRIX_BOT_USER?.trim();
  if (!botUserId) {
    throw new Error("Missing MATRIX_BOT_USER.");
  }

  const roomId = process.env.MATRIX_ROOM_ID?.trim();
  if (!roomId) {
    throw new Error("Missing MATRIX_ROOM_ID.");
  }

  const timeoutRaw = process.env.MATRIX_SYNC_TIMEOUT_MS?.trim();
  const syncTimeoutMs = timeoutRaw && /^\d+$/.test(timeoutRaw) ? Number.parseInt(timeoutRaw, 10) : 30_000;

  const sessionFile = path.resolve(process.env.BRIDGE_SESSION_FILE?.trim() || path.join("data", "bridge-sessions.json"));

  return {
    homeserverUrl: normalizeHomeserverUrl(homeserverRaw),
    accessToken,
    botUserId,
    roomId,
    projectKey: process.env.PROJECT_KEY?.trim() || undefined,
    sparkProject: process.env.SPARK_PROJECT?.trim() || undefined,
    sparkName: process.env.SPARK_NAME?.trim() || undefined,
    initialPrompt: process.env.INITIAL_PROMPT,
    syncTimeoutMs,
    sessionFile,
  };
}

function loadSavedSessions(filePath: string): Record<string, SavedSession> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const result: Record<string, SavedSession> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") {
        continue;
      }

      const threadId = (value as { threadId?: unknown }).threadId;
      if (typeof threadId === "string" && threadId.length > 0) {
        result[key] = { threadId };
      } else {
        result[key] = {};
      }
    }

    return result;
  } catch {
    return {};
  }
}

function saveSessions(filePath: string, sessions: Record<string, SavedSession>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(sessions, null, 2), "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
