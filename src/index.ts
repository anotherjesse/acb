import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { Codex, Thread, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import dotenv from "dotenv";
import { Context, Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { z } from "zod";

dotenv.config();

const token =
  process.env.TELEGRAM_BOT_KEY ??
  process.env.TELEGRAM_BOT_TOKEN ??
  process.env.BOT_TOKEN;

if (!token) {
  throw new Error("Missing Telegram bot token. Set TELEGRAM_BOT_KEY in .env.");
}

type SavedSession = {
  threadId?: string;
};

type OptionState = {
  label: string;
  selected: boolean;
};

type PendingSelection = {
  chatId: number;
  question: string;
  multiSelect: boolean;
  options: OptionState[];
};

type ActiveRun = {
  abortController: AbortController;
  done: Promise<void>;
};

type ChatState = {
  thread: Thread;
  activeRun?: ActiveRun;
};

const storeFile = path.resolve(process.cwd(), "data", "chat-sessions.json");
const savedSessions: Record<string, SavedSession> = loadSavedSessions();
const chatStates = new Map<number, ChatState>();
const pendingSelections = new Map<string, PendingSelection>();

const questionSchema = z
  .object({
    type: z.literal("question"),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(1).max(20),
    multiSelect: z.boolean().optional(),
  })
  .strict();

const codex = new Codex();
const bot = new Telegraf(token);

bot.start(async (ctx) => {
  await ctx.reply(
    [
      "Bot is online.",
      "Use /run <prompt> to send work to Codex.",
      "Use /new to reset the session, /thread for status, /stop to interrupt.",
    ].join("\n"),
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    [
      "/run <prompt> - run a Codex turn",
      "/new - create a fresh Codex thread for this chat",
      "/thread - show current thread id",
      "/stop - interrupt active run",
      "Send plain text (without a command) to run it as a prompt.",
    ].join("\n"),
  );
});

bot.command("new", async (ctx) => {
  const chatId = getChatId(ctx);
  const thread = codex.startThread(threadOptionsFromEnv());
  chatStates.set(chatId, { thread });
  savedSessions[String(chatId)] = {};
  saveSessions();
  await ctx.reply("Started a new Codex session for this chat.");
});

bot.command("thread", async (ctx) => {
  const chatId = getChatId(ctx);
  const state = await getOrCreateState(chatId);
  await ctx.reply(state.thread.id ? `Thread: ${state.thread.id}` : "Thread exists but has no id yet (run a turn first).");
});

bot.command("stop", async (ctx) => {
  const chatId = getChatId(ctx);
  const state = chatStates.get(chatId);
  if (!state?.activeRun) {
    await ctx.reply("No active run to stop.");
    return;
  }

  state.activeRun.abortController.abort();
  await ctx.reply("Stopping active run...");
});

bot.command("run", async (ctx) => {
  if (!ctx.message || !("text" in ctx.message)) {
    return;
  }

  const prompt = ctx.message.text.replace(/^\/run(@\w+)?\s*/i, "").trim();
  if (!prompt) {
    await ctx.reply("Usage: /run <prompt>");
    return;
  }

  const chatId = getChatId(ctx);
  const state = await getOrCreateState(chatId);
  triggerRun(ctx, state, prompt);
});

bot.on(message("text"), async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    await next();
    return;
  }

  const chatId = getChatId(ctx);
  const state = await getOrCreateState(chatId);
  triggerRun(ctx, state, text);
});

bot.on("callback_query", async (ctx) => {
  const query = ctx.callbackQuery;
  if (!("data" in query)) {
    await ctx.answerCbQuery();
    return;
  }

  const data = query.data;
  if (!data.startsWith("ms:")) {
    await ctx.answerCbQuery();
    return;
  }

  const parts = data.split(":");
  if (parts.length < 4) {
    await ctx.answerCbQuery();
    return;
  }

  const [, kind, key, value] = parts;
  const state = pendingSelections.get(key);
  if (!state) {
    await ctx.answerCbQuery("This selection is no longer active.");
    return;
  }

  if (kind === "toggle") {
    const idx = Number(value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= state.options.length) {
      await ctx.answerCbQuery();
      return;
    }

    if (state.multiSelect) {
      state.options[idx].selected = !state.options[idx].selected;
    } else {
      for (let i = 0; i < state.options.length; i += 1) {
        state.options[i].selected = i === idx;
      }
    }

    await ctx.editMessageReplyMarkup({
      inline_keyboard: buildSelectionKeyboard(key, state.options, state.multiSelect),
    });
    await ctx.answerCbQuery();
    return;
  }

  if (kind === "submit") {
    const selected = state.options.filter((o) => o.selected).map((o) => o.label);
    if (selected.length === 0) {
      await ctx.answerCbQuery("Pick at least one option first.");
      return;
    }

    pendingSelections.delete(key);
    await ctx.editMessageText(
      `Question: ${state.question}\nSelected: ${selected.join(", ")}`,
    );
    await ctx.answerCbQuery("Submitted");

    const chatState = await getOrCreateState(state.chatId);
    triggerRun(
      ctx,
      chatState,
      `User answered question \"${state.question}\" with: ${selected.join(", ")}`,
    );
    return;
  }

  await ctx.answerCbQuery();
});

bot.catch((error) => {
  // Keep process alive for chat sessions; logging is enough here.
  console.error("Telegram bot error:", error);
});

bot.launch().then(() => {
  console.log("Telegram Codex bot is running.");
});

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});

async function startOrReplaceRun(ctx: Context, state: ChatState, prompt: string): Promise<void> {
  if (state.activeRun) {
    state.activeRun.abortController.abort();
    try {
      await state.activeRun.done;
    } catch {
      // Ignore cancellation failures; new run starts immediately after.
    }
    await ctx.reply("Previous run interrupted. Starting your latest prompt.");
  }

  const abortController = new AbortController();
  const done = runPrompt(ctx, state, prompt, abortController);
  state.activeRun = { abortController, done };

  try {
    await done;
  } finally {
    if (state.activeRun?.done === done) {
      state.activeRun = undefined;
    }
  }
}

function triggerRun(ctx: Context, state: ChatState, prompt: string): void {
  void startOrReplaceRun(ctx, state, prompt).catch((error) => {
    console.error("Run failed:", error);
  });
}

async function runPrompt(
  ctx: Context,
  state: ChatState,
  prompt: string,
  abortController: AbortController,
): Promise<void> {
  const chatId = getChatId(ctx);
  const status = await ctx.reply("⏳ Starting Codex...");
  const statusMessageId = status.message_id;

  const pushStatus = createStatusUpdater(ctx, chatId, statusMessageId);
  pushStatus("⏳ Starting Codex...");

  const typingInterval = setInterval(() => {
    void ctx.telegram.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);
  const maxAttempts = 2;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const last = {
        command: "",
        reasoning: "",
        finalResponse: "",
      };
      let streamError: string | null = null;

      try {
        const { events } = await state.thread.runStreamed(prompt, {
          signal: abortController.signal,
        });

        for await (const event of events) {
          const display = eventToStatus(event, last);
          if (display) {
            pushStatus(display);
          }

          if (event.type === "thread.started") {
            const key = String(chatId);
            savedSessions[key] = { threadId: event.thread_id };
            saveSessions();
          }

          if (event.type === "item.completed" && event.item.type === "agent_message") {
            last.finalResponse = event.item.text;
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
            resetThreadForChat(chatId, state);
            await pushStatus(
              "⚠️ Previous Codex session is unavailable. Starting a fresh session and retrying once...",
              true,
            );
            continue;
          }
          await pushStatus(`❌ Run failed\n\n${truncate(streamError)}`, true);
          return;
        }

        if (last.finalResponse) {
          await pushStatus(`✅ Done\n\n${truncate(last.finalResponse)}`, true);
          await maybeAskQuestion(ctx, chatId, last.finalResponse);
          return;
        }

        await pushStatus("✅ Done", true);
        return;
      } catch (error) {
        const message = formatError(error);
        if (abortController.signal.aborted) {
          await pushStatus("⛔ Run interrupted.", true);
          return;
        }

        if (attempt < maxAttempts && isStaleResumeError(message)) {
          resetThreadForChat(chatId, state);
          await pushStatus(
            "⚠️ Previous Codex session is unavailable. Starting a fresh session and retrying once...",
            true,
          );
          continue;
        }

        await pushStatus(`❌ Error\n\n${truncate(message)}`, true);
        return;
      }
    }
  } finally {
    clearInterval(typingInterval);
  }
}

function eventToStatus(
  event: ThreadEvent,
  last: { command: string; reasoning: string; finalResponse: string },
): string | null {
  switch (event.type) {
    case "thread.started":
      return "🧵 Session started.";
    case "turn.started":
      return "🔄 Codex is working...";
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = event.item;
      if (item.type === "command_execution") {
        last.command = item.command;
        const base = item.status === "in_progress" ? "🛠️ Running" : "🛠️ Command";
        return `${base}: ${truncate(item.command, 240)}`;
      }

      if (item.type === "reasoning") {
        last.reasoning = item.text;
        return `🧠 ${truncate(item.text, 300)}`;
      }

      if (item.type === "web_search") {
        return `🌐 Searching: ${truncate(item.query, 260)}`;
      }

      if (item.type === "todo_list") {
        const preview = item.items
          .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`)
          .slice(0, 5)
          .join("\n");
        return `📝 Plan\n${truncate(preview, 500)}`;
      }

      if (item.type === "file_change") {
        const changed = item.changes.map((c) => `${c.kind}:${c.path}`).join("\n");
        return `📁 File changes\n${truncate(changed, 500)}`;
      }

      if (item.type === "mcp_tool_call") {
        return `🔌 MCP: ${item.server}/${item.tool} (${item.status})`;
      }

      if (item.type === "error") {
        return `⚠️ ${truncate(item.message, 700)}`;
      }

      if (item.type === "agent_message") {
        return `💬 ${truncate(item.text, 900)}`;
      }

      return null;
    }
    case "turn.completed":
      return `✅ Turn complete\nTokens in/out: ${event.usage.input_tokens}/${event.usage.output_tokens}`;
    case "turn.failed":
      return `❌ Turn failed\n${truncate(event.error.message, 900)}`;
    case "error":
      return `❌ Stream error\n${truncate(event.message, 900)}`;
    default:
      return null;
  }
}

async function maybeAskQuestion(ctx: Context, chatId: number, responseText: string): Promise<void> {
  const parsed = parseQuestionResponse(responseText);
  if (!parsed) {
    return;
  }

  const key = `${chatId}:${Date.now()}`;
  pendingSelections.set(key, {
    chatId,
    question: parsed.question,
    multiSelect: parsed.multiSelect ?? true,
    options: parsed.options.map((label) => ({ label, selected: false })),
  });

  await ctx.reply(parsed.question, {
    reply_markup: {
      inline_keyboard: buildSelectionKeyboard(
        key,
        pendingSelections.get(key)?.options ?? [],
        pendingSelections.get(key)?.multiSelect ?? true,
      ),
    },
  });
}

function parseQuestionResponse(responseText: string): z.infer<typeof questionSchema> | null {
  const candidates = [responseText, extractJsonCodeFence(responseText), extractCurlyBlock(responseText)].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate);
      const parsed = questionSchema.safeParse(json);
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Keep trying the next candidate.
    }
  }

  return null;
}

function extractJsonCodeFence(text: string): string | null {
  const match = text.match(/```json\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function extractCurlyBlock(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1).trim();
}

function buildSelectionKeyboard(
  key: string,
  options: OptionState[],
  multiSelect: boolean,
): ReturnType<typeof Markup.button.callback>[][] {
  const rows = options.map((option, idx) => {
    const text = `${option.selected ? "✅" : "⬜"} ${option.label}`;
    return [Markup.button.callback(text, `ms:toggle:${key}:${idx}`)];
  });

  rows.push([
    Markup.button.callback(
      multiSelect ? "Submit selection" : "Submit choice",
      `ms:submit:${key}:0`,
    ),
  ]);

  return rows;
}

function createStatusUpdater(ctx: Context, chatId: number, messageId: number): (text: string, force?: boolean) => Promise<void> {
  let lastText = "";
  let queuedText = "";
  let lastEditAt = 0;
  let flushing = false;

  return async (text: string, force = false): Promise<void> => {
    const next = truncate(text, 3900);
    if (!next || next === lastText) {
      return;
    }

    queuedText = next;
    if (flushing) {
      return;
    }

    flushing = true;
    try {
      while (queuedText) {
        const target = queuedText;
        queuedText = "";

        const now = Date.now();
        const delay = force ? 0 : Math.max(0, 900 - (now - lastEditAt));
        if (delay > 0) {
          await sleep(delay);
        }

        if (target === lastText) {
          continue;
        }

        try {
          await ctx.telegram.editMessageText(chatId, messageId, undefined, target);
          lastText = target;
          lastEditAt = Date.now();
        } catch (error) {
          const message = formatError(error).toLowerCase();
          if (message.includes("message is not modified")) {
            lastText = target;
            continue;
          }
        }
      }
    } finally {
      flushing = false;
    }
  };
}

async function getOrCreateState(chatId: number): Promise<ChatState> {
  const existing = chatStates.get(chatId);
  if (existing) {
    return existing;
  }

  const saved = savedSessions[String(chatId)];
  const thread =
    saved?.threadId && saved.threadId.length > 0
      ? codex.resumeThread(saved.threadId, threadOptionsFromEnv())
      : codex.startThread(threadOptionsFromEnv());

  const state: ChatState = { thread };
  chatStates.set(chatId, state);
  return state;
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
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
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

function loadSavedSessions(): Record<string, SavedSession> {
  if (!fs.existsSync(storeFile)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(storeFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, SavedSession>;
  } catch {
    return {};
  }
}

function saveSessions(): void {
  const dir = path.dirname(storeFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(savedSessions, null, 2), "utf8");
}

function resetThreadForChat(chatId: number, state: ChatState): void {
  state.thread = codex.startThread(threadOptionsFromEnv());
  savedSessions[String(chatId)] = {};
  saveSessions();
}

function isStaleResumeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("state db missing rollout path for thread") ||
    normalized.includes("missing rollout path for thread")
  );
}

function truncate(value: string, maxLen = 1200): string {
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, maxLen - 3)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getChatId(ctx: Context): number {
  if (!ctx.chat) {
    throw new Error("Missing chat context.");
  }
  return ctx.chat.id;
}

function readBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
