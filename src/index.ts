import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Codex, Thread, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import dotenv from "dotenv";
import { Context, Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { z } from "zod";

dotenv.config({ quiet: true });

const token =
  process.env.TELEGRAM_BOT_KEY ??
  process.env.TELEGRAM_BOT_TOKEN ??
  process.env.BOT_TOKEN;

if (!token) {
  throw new Error("Missing Telegram bot token. Set TELEGRAM_BOT_KEY in .env.");
}

type LogLevel = "debug" | "info" | "warn" | "error";

type RoutingScope = {
  chatId: string | number;
  threadId?: number;
  source: "env" | "forum-topic";
};

type SavedSession = {
  threadId?: string;
};

type SavedLocationTopic = {
  topicId: number;
  topicName: string;
  createdAt: string;
};

type ForumAnnouncementResult =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      ok: true;
      createdTopic: boolean;
      topicId: number;
      topicName: string;
      forumChatId: string | number;
      locationKey: string;
    }
  | { enabled: true; ok: false; reason: string };

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

type AudioPromptInput = {
  fileId: string;
  fileName: string;
  mimeType?: string;
};

const storeFile = path.resolve(process.cwd(), "data", "chat-sessions.json");
const locationTopicStoreFile = path.resolve(process.cwd(), "data", "location-topics.json");
const savedSessions: Record<string, SavedSession> = loadSavedSessions();
const savedLocationTopics: Record<string, SavedLocationTopic> = loadSavedLocationTopics();
const chatStates = new Map<number, ChatState>();
const pendingSelections = new Map<string, PendingSelection>();
let routingScope: RoutingScope | undefined;

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

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;
  const fromId = ctx.from?.id;
  const updateType = ctx.updateType;

  if (ctx.message && "text" in ctx.message) {
    log("debug", "Incoming text message.", {
      updateType,
      chatId,
      chatType,
      fromId,
      text: truncate(ctx.message.text, 280),
    });
  } else if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
    log("debug", "Incoming callback query.", {
      updateType,
      chatId,
      chatType,
      fromId,
      data: truncate(ctx.callbackQuery.data ?? "", 280),
    });
  } else {
    log("debug", "Incoming Telegram update.", {
      updateType,
      chatId,
      chatType,
      fromId,
    });
  }

  await next();
});

bot.use(async (ctx, next) => {
  if (!isRoutingScopeEnabled()) {
    await next();
    return;
  }

  const text = getIncomingText(ctx);
  const bypass = isRoutingBypassCommand(text);
  const target = extractUpdateTarget(ctx);

  if (!routingScope) {
    if (bypass) {
      await next();
      return;
    }

    log("warn", "Dropping update while routing scope is not initialized yet.", {
      chatId: target.chatId,
      threadId: target.threadId,
      updateType: ctx.updateType,
    });
    return;
  }

  if (!targetMatchesScope(target, routingScope)) {
    log("debug", "Ignoring update outside routing scope.", {
      updateType: ctx.updateType,
      chatId: target.chatId,
      threadId: target.threadId,
      scopeChatId: routingScope.chatId,
      scopeThreadId: routingScope.threadId,
    });
    return;
  }

  await next();
});

bot.start(async (ctx) => {
  log("info", "Handling /start.", { chatId: ctx.chat?.id });
  await ctx.reply(
    [
      "Bot is online.",
      "Use /run <prompt> to send work to Codex.",
      "Use /new to reset the session, /thread for status, /stop to interrupt.",
    ].join("\n"),
  );
});

bot.command("help", async (ctx) => {
  log("info", "Handling /help.", { chatId: ctx.chat?.id });
  await ctx.reply(
    [
      "/run <prompt> - run a Codex turn",
      "/new - create a fresh Codex thread for this chat",
      "/thread - show current thread id",
      "/stop - interrupt active run",
      "/chatid - print current chat id and thread id",
      "/announce - post this bot's location metadata to the forum topic",
      "Send a voice note or audio file to transcribe and run as a prompt.",
      "Send plain text (without a command) to run it as a prompt.",
    ].join("\n"),
  );
});

bot.command("new", async (ctx) => {
  const chatId = getChatId(ctx);
  log("info", "Handling /new.", { chatId });
  const thread = codex.startThread(threadOptionsFromEnv());
  chatStates.set(chatId, { thread });
  savedSessions[String(chatId)] = {};
  saveSessions();
  await ctx.reply("Started a new Codex session for this chat.");
});

bot.command("thread", async (ctx) => {
  const chatId = getChatId(ctx);
  log("info", "Handling /thread.", { chatId });
  const state = await getOrCreateState(chatId);
  await ctx.reply(state.thread.id ? `Thread: ${state.thread.id}` : "Thread exists but has no id yet (run a turn first).");
});

bot.command("stop", async (ctx) => {
  const chatId = getChatId(ctx);
  log("info", "Handling /stop.", { chatId });
  const state = chatStates.get(chatId);
  if (!state?.activeRun) {
    await ctx.reply("No active run to stop.");
    return;
  }

  state.activeRun.abortController.abort();
  await ctx.reply("Stopping active run...");
});

bot.command("announce", async (ctx) => {
  log("info", "Handling /announce.", { chatId: ctx.chat?.id });
  const result = await announceLocationInForum();
  if (!result.enabled) {
    await ctx.reply(`Announcement is disabled: ${result.reason}`);
    return;
  }

  if (!result.ok) {
    const permissionHint = inferForumPermissionHint(result.reason);
    const detail = permissionHint ? `${result.reason}\n\n${permissionHint}` : result.reason;
    await ctx.reply(`Announcement failed: ${detail}`);
    return;
  }

  const action = result.createdTopic ? "Created topic and posted" : "Posted update to topic";
  if (isRoutingScopeEnabled()) {
    setRoutingScope({
      chatId: result.forumChatId,
      threadId: result.topicId,
      source: "forum-topic",
    });
  }
  await ctx.reply(
    `${action} "${result.topicName}" (topic ${result.topicId}) in chat ${result.forumChatId}.`,
  );
});

bot.command("chatid", async (ctx) => {
  const chatId = getChatId(ctx);
  log("info", "Handling /chatid.", { chatId });
  const chatType = ctx.chat?.type ?? "(unknown)";
  const threadId =
    ctx.message && "message_thread_id" in ctx.message && typeof ctx.message.message_thread_id === "number"
      ? ctx.message.message_thread_id
      : undefined;

  const details = [`chat_id: ${chatId}`, `chat_type: ${chatType}`];
  if (threadId !== undefined) {
    details.push(`message_thread_id: ${threadId}`);
  }
  await ctx.reply(details.join("\n"));
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
  log("info", "Handling /run.", { chatId, prompt: truncate(prompt, 240) });
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
  log("info", "Handling plain text run.", { chatId, prompt: truncate(text, 240) });
  const state = await getOrCreateState(chatId);
  triggerRun(ctx, state, text);
});

bot.on(message("voice"), async (ctx) => {
  const voice = ctx.message.voice;
  log("info", "Handling voice message.", {
    chatId: ctx.chat?.id,
    fileId: voice.file_id,
    mimeType: voice.mime_type,
  });
  triggerAudioPrompt(ctx, {
    fileId: voice.file_id,
    fileName: `voice-${voice.file_unique_id}.ogg`,
    mimeType: voice.mime_type ?? "audio/ogg",
  });
});

bot.on(message("audio"), async (ctx) => {
  const audio = ctx.message.audio;
  log("info", "Handling audio message.", {
    chatId: ctx.chat?.id,
    fileId: audio.file_id,
    fileName: audio.file_name,
    mimeType: audio.mime_type,
  });
  triggerAudioPrompt(ctx, {
    fileId: audio.file_id,
    fileName: audio.file_name ?? `audio-${audio.file_unique_id}.mp3`,
    mimeType: audio.mime_type,
  });
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
  log("debug", "Handling callback selection.", {
    chatId: ctx.chat?.id,
    kind,
    key,
    value,
  });
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
  log("error", "Telegram bot error.", { error: formatError(error) });
});

void bootstrap().catch((error) => {
  log("error", "Fatal startup failure.", { error: formatError(error) });
  process.exitCode = 1;
});

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled promise rejection.", { reason: formatError(reason) });
});

process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception.", { error: formatError(error) });
});

async function startOrReplaceRun(ctx: Context, state: ChatState, prompt: string): Promise<void> {
  const chatId = getChatId(ctx);
  if (state.activeRun) {
    log("warn", "Interrupting previous active run for new prompt.", { chatId });
    state.activeRun.abortController.abort();
    try {
      await state.activeRun.done;
    } catch {
      // Ignore cancellation failures; new run starts immediately after.
    }
    await ctx.reply("Previous run interrupted. Starting your latest prompt.");
  }

  const abortController = new AbortController();
  log("info", "Starting run.", { chatId, prompt: truncate(prompt, 280) });
  const done = runPrompt(ctx, state, prompt, abortController);
  state.activeRun = { abortController, done };

  try {
    await done;
  } finally {
    if (state.activeRun?.done === done) {
      state.activeRun = undefined;
    }
    log("info", "Run finished.", { chatId });
  }
}

function triggerRun(ctx: Context, state: ChatState, prompt: string): void {
  const chatId = ctx.chat?.id;
  void startOrReplaceRun(ctx, state, prompt).catch((error) => {
    log("error", "Run failed.", {
      chatId,
      error: formatError(error),
      prompt: truncate(prompt, 220),
    });
  });
}

function triggerAudioPrompt(ctx: Context, input: AudioPromptInput): void {
  void handleAudioPrompt(ctx, input).catch((error) => {
    log("error", "Audio prompt failed.", {
      chatId: ctx.chat?.id,
      fileId: input.fileId,
      fileName: input.fileName,
      error: formatError(error),
    });
  });
}

async function handleAudioPrompt(ctx: Context, input: AudioPromptInput): Promise<void> {
  const chatId = getChatId(ctx);
  log("info", "Starting audio transcription.", {
    chatId,
    fileId: input.fileId,
    fileName: input.fileName,
    mimeType: input.mimeType,
  });
  const status = await ctx.reply("🎙️ Audio received. Transcribing...");
  const pushStatus = createStatusUpdater(ctx, chatId, status.message_id);
  void pushStatus("🎙️ Audio received. Transcribing...");

  try {
    const transcript = await transcribeTelegramAudio(ctx, input);
    log("info", "Audio transcription completed.", {
      chatId,
      transcriptChars: transcript.length,
    });
    await pushStatus(`📝 Transcript\n\n${truncate(transcript, 3600)}`, true);

    const state = await getOrCreateState(chatId);
    triggerRun(ctx, state, transcript);
  } catch (error) {
    log("error", "Audio transcription failed.", { chatId, error: formatError(error) });
    await pushStatus(`❌ Transcription failed\n\n${truncate(formatError(error), 3400)}`, true);
  }
}

async function transcribeTelegramAudio(ctx: Context, input: AudioPromptInput): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY for audio transcription.");
  }

  const fileUrl = await ctx.telegram.getFileLink(input.fileId);
  const fileResponse = await fetch(fileUrl.toString());
  if (!fileResponse.ok) {
    throw new Error(`Failed to download Telegram audio (${fileResponse.status}).`);
  }

  const bytes = await fileResponse.arrayBuffer();
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: input.mimeType ?? "application/octet-stream" }),
    input.fileName,
  );
  form.append("model", "gpt-4o-transcribe");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Transcription API failed (${response.status}): ${truncate(bodyText, 700)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Transcription API returned non-JSON response: ${truncate(bodyText, 700)}`);
  }

  if (!parsed || typeof parsed !== "object" || typeof (parsed as { text?: unknown }).text !== "string") {
    throw new Error(`Transcription response missing text: ${truncate(bodyText, 700)}`);
  }

  const text = (parsed as { text: string }).text.trim();
  if (!text) {
    throw new Error("Transcription returned empty text.");
  }

  return text;
}

async function maybeSendSpeechResponse(ctx: Context, chatId: number, responseText: string): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return;
  }

  const text = responseText.trim();
  if (!text) {
    return;
  }

  const payload = {
    model: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
    input: truncate(text, 3500),
    voice: process.env.OPENAI_TTS_VOICE ?? "coral",
    instructions: process.env.OPENAI_TTS_INSTRUCTIONS ?? "Speak in a cheerful and positive tone.",
  };

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    log("error", "TTS API failed.", { status: response.status, detail: truncate(detail, 700) });
    return;
  }

  const bytes = await response.arrayBuffer();
  const audioBuffer = Buffer.from(bytes);
  if (audioBuffer.length === 0) {
    return;
  }

  await ctx.telegram.sendAudio(
    chatId,
    {
      source: audioBuffer,
      filename: "codex-response.mp3",
    },
    {
      title: "Codex response",
      performer: "Codex",
    },
  );
}

async function runPrompt(
  ctx: Context,
  state: ChatState,
  prompt: string,
  abortController: AbortController,
): Promise<void> {
  const chatId = getChatId(ctx);
  const startedAt = Date.now();
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
      log("info", "Run attempt started.", { chatId, attempt, maxAttempts });
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
            log("warn", "Run hit stale thread. Resetting and retrying.", { chatId, attempt });
            resetThreadForChat(chatId, state);
            await pushStatus(
              "⚠️ Previous Codex session is unavailable. Starting a fresh session and retrying once...",
              true,
            );
            continue;
          }
          log("error", "Run ended with stream error.", { chatId, attempt, streamError });
          await pushStatus(`❌ Run failed\n\n${truncate(streamError)}`, true);
          return;
        }

        if (last.finalResponse) {
          log("info", "Run completed with final response.", {
            chatId,
            attempt,
            responseChars: last.finalResponse.length,
          });
          await pushStatus(`✅ Done\n\n${truncate(last.finalResponse)}`, true);
          await maybeSendSpeechResponse(ctx, chatId, last.finalResponse);
          await maybeAskQuestion(ctx, chatId, last.finalResponse);
          return;
        }

        log("info", "Run completed without final response body.", { chatId, attempt });
        await pushStatus("✅ Done", true);
        return;
      } catch (error) {
        const message = formatError(error);
        if (abortController.signal.aborted) {
          log("warn", "Run was interrupted by user.", { chatId, attempt });
          await pushStatus("⛔ Run interrupted.", true);
          return;
        }

        if (attempt < maxAttempts && isStaleResumeError(message)) {
          log("warn", "Run threw stale thread error. Resetting and retrying.", {
            chatId,
            attempt,
            message,
          });
          resetThreadForChat(chatId, state);
          await pushStatus(
            "⚠️ Previous Codex session is unavailable. Starting a fresh session and retrying once...",
            true,
          );
          continue;
        }

        log("error", "Run crashed.", { chatId, attempt, message });
        await pushStatus(`❌ Error\n\n${truncate(message)}`, true);
        return;
      }
    }
  } finally {
    clearInterval(typingInterval);
    log("info", "Run loop ended.", {
      chatId,
      durationMs: Date.now() - startedAt,
      promptChars: prompt.length,
    });
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

function loadSavedLocationTopics(): Record<string, SavedLocationTopic> {
  if (!fs.existsSync(locationTopicStoreFile)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(locationTopicStoreFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const result: Record<string, SavedLocationTopic> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const topicId = (value as { topicId?: unknown }).topicId;
      const topicName = (value as { topicName?: unknown }).topicName;
      const createdAt = (value as { createdAt?: unknown }).createdAt;
      if (
        Number.isInteger(topicId) &&
        typeof topicName === "string" &&
        topicName.length > 0 &&
        typeof createdAt === "string" &&
        createdAt.length > 0
      ) {
        result[key] = {
          topicId: topicId as number,
          topicName,
          createdAt,
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveSessions(): void {
  const dir = path.dirname(storeFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storeFile, JSON.stringify(savedSessions, null, 2), "utf8");
}

function saveLocationTopics(): void {
  const dir = path.dirname(locationTopicStoreFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(locationTopicStoreFile, JSON.stringify(savedLocationTopics, null, 2), "utf8");
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

function resolveLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function shouldLog(level: LogLevel, current: LogLevel): boolean {
  const rank: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  return rank[level] >= rank[current];
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function inferForumPermissionHint(reason: string): string | null {
  const normalized = reason.toLowerCase();
  if (
    normalized.includes("not enough rights") ||
    normalized.includes("chat_admin_required") ||
    normalized.includes("forbidden")
  ) {
    return "Give the bot admin rights in the forum supergroup with at least: Manage Topics and Post Messages.";
  }
  return null;
}

async function announceLocationInForum(): Promise<ForumAnnouncementResult> {
  const forumChatId = readForumChatId();
  if (forumChatId === null) {
    return {
      enabled: false,
      reason: "set TELEGRAM_FORUM_CHAT_ID to a forum supergroup id (for example -1001234567890).",
    };
  }

  const location = detectLocationIdentity();
  const { hostname, workingDirectory, repoName, repoRemote, locationKey, locationLabel } = location;
  const topicTitle = truncate(`${locationLabel} / ${repoName}`, 120);
  log("info", "Preparing forum announcement.", {
    forumChatId,
    hostname,
    repoName,
    locationKey,
    topicTitle,
  });

  let savedTopic = savedLocationTopics[locationKey];
  let createdTopic = false;

  try {
    const membership = await getForumMembershipDiagnostics(forumChatId);
    log("info", "Forum membership diagnostics.", membership);

    if (!savedTopic) {
      log("info", "Creating new forum topic for location.", { forumChatId, topicTitle, locationKey });
      const created = (await bot.telegram.callApi("createForumTopic", {
        chat_id: forumChatId,
        name: topicTitle,
      })) as { message_thread_id: number; name?: string };

      savedTopic = {
        topicId: created.message_thread_id,
        topicName: created.name ?? topicTitle,
        createdAt: new Date().toISOString(),
      };
      savedLocationTopics[locationKey] = savedTopic;
      saveLocationTopics();
      createdTopic = true;
      log("info", "Created forum topic.", {
        forumChatId,
        topicId: savedTopic.topicId,
        topicName: savedTopic.topicName,
      });
    } else {
      log("info", "Reusing saved forum topic.", {
        forumChatId,
        topicId: savedTopic.topicId,
        topicName: savedTopic.topicName,
        locationKey,
      });
    }

    const botIdentity = await getBotIdentity();
    const lines = [
      createdTopic ? "🆕 New location registered." : "🔄 Location restarted.",
      `location_key: ${locationKey}`,
      `hostname: ${hostname}`,
      `repo: ${repoName}`,
      `cwd: ${workingDirectory}`,
      `remote: ${repoRemote ?? "(none)"}`,
      `bot: ${botIdentity}`,
      `time_utc: ${new Date().toISOString()}`,
    ];

    await bot.telegram.callApi("sendMessage", {
      chat_id: forumChatId,
      message_thread_id: savedTopic.topicId,
      text: lines.join("\n"),
    });
    log("info", "Posted forum announcement message.", {
      forumChatId,
      topicId: savedTopic.topicId,
      createdTopic,
      locationKey,
    });

    return {
      enabled: true,
      ok: true,
      createdTopic,
      topicId: savedTopic.topicId,
      topicName: savedTopic.topicName,
      forumChatId,
      locationKey,
    };
  } catch (error) {
    log("error", "Forum announcement failed.", {
      forumChatId,
      locationKey,
      error: formatError(error),
    });
    return {
      enabled: true,
      ok: false,
      reason: formatError(error),
    };
  }
}

async function bootstrap(): Promise<void> {
  const envRouting = readRoutingScopeFromEnv();
  if (envRouting) {
    setRoutingScope(envRouting);
  }

  log("info", "Boot sequence started.", {
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    workingDirectory: process.env.CODEX_WORKING_DIRECTORY ?? process.cwd(),
    forumChatIdConfigured: Boolean(process.env.TELEGRAM_FORUM_CHAT_ID),
    openAiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    logLevel: resolveLogLevel(),
  });

  // Fast health check before polling so startup failures are visible.
  const me = await bot.telegram.getMe();
  log("info", "Telegram token verified.", {
    botId: me.id,
    username: me.username,
    name: me.first_name,
  });

  const launchWatchdog = setTimeout(() => {
    log("warn", "Still waiting for bot.launch() to resolve.", {
      hint: "This can happen with network issues or Telegram getUpdates conflicts.",
    });
  }, 15000);

  try {
    await bot.launch({
      dropPendingUpdates: true,
    });
  } finally {
    clearTimeout(launchWatchdog);
  }

  log("info", "Telegram polling is active.");

  const result = await announceLocationInForum();
  if (!result.enabled) {
    log("info", "Startup forum announcement skipped.", { reason: result.reason });
    if (isRoutingScopeEnabled() && !routingScope) {
      log("warn", "Routing scope is enabled but no scope is active yet.");
    }
    return;
  }

  if (!result.ok) {
    log("error", "Startup forum announcement failed.", { reason: result.reason });
    return;
  }

  log("info", "Startup forum announcement sent.", {
    createdTopic: result.createdTopic,
    topicId: result.topicId,
    topicName: result.topicName,
    forumChatId: result.forumChatId,
  });

  if (isRoutingScopeEnabled()) {
    setRoutingScope({
      chatId: result.forumChatId,
      threadId: result.topicId,
      source: "forum-topic",
    });
    log("info", "Routing scope pinned to location topic.", {
      locationKey: result.locationKey,
      chatId: result.forumChatId,
      threadId: result.topicId,
    });
  }
}

function detectLocationIdentity(): {
  hostname: string;
  workingDirectory: string;
  repoRemote?: string;
  repoName: string;
  locationKey: string;
  locationLabel: string;
} {
  const hostname = os.hostname();
  const workingDirectory = process.env.CODEX_WORKING_DIRECTORY ?? process.cwd();
  const repoRemote = readGitRemote(workingDirectory);
  const repoName =
    process.env.TELEGRAM_REPO_NAME?.trim() ||
    parseRepoNameFromRemote(repoRemote) ||
    path.basename(workingDirectory);
  const locationKey = process.env.TELEGRAM_LOCATION_KEY?.trim() || `${hostname}:${repoName}`;
  const locationLabel = process.env.TELEGRAM_LOCATION_LABEL?.trim() || hostname;

  return {
    hostname,
    workingDirectory,
    repoRemote,
    repoName,
    locationKey,
    locationLabel,
  };
}

function readRoutingScopeFromEnv(): RoutingScope | null {
  const chatId = readAllowedChatId();
  const threadIdRaw = process.env.TELEGRAM_ALLOWED_THREAD_ID?.trim();
  const threadId =
    threadIdRaw && /^\d+$/.test(threadIdRaw)
      ? Number(threadIdRaw)
      : undefined;

  if (chatId === null) {
    return null;
  }

  return {
    chatId,
    threadId,
    source: "env",
  };
}

function readAllowedChatId(): string | number | null {
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_ID?.trim();
  if (!raw) {
    return null;
  }
  if (/^-?\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function isRoutingScopeEnabled(): boolean {
  const explicit = readBoolean(process.env.TELEGRAM_SCOPE_TO_FORUM_TOPIC);
  if (explicit !== undefined) {
    return explicit;
  }
  return Boolean(process.env.TELEGRAM_FORUM_CHAT_ID);
}

function setRoutingScope(scope: RoutingScope): void {
  routingScope = scope;
  log("info", "Routing scope set.", {
    chatId: scope.chatId,
    threadId: scope.threadId,
    source: scope.source,
  });
}

function isRoutingBypassCommand(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith("/announce") ||
    normalized.startsWith("/chatid") ||
    normalized.startsWith("/help") ||
    normalized.startsWith("/start")
  );
}

function getIncomingText(ctx: Context): string | undefined {
  if (ctx.message && "text" in ctx.message) {
    return ctx.message.text;
  }
  return undefined;
}

function extractUpdateTarget(ctx: Context): { chatId?: string | number; threadId?: number } {
  const chatId = ctx.chat?.id;
  let threadId: number | undefined;

  if (ctx.message && "message_thread_id" in ctx.message && typeof ctx.message.message_thread_id === "number") {
    threadId = ctx.message.message_thread_id;
  } else if (
    ctx.callbackQuery &&
    "message" in ctx.callbackQuery &&
    ctx.callbackQuery.message &&
    "message_thread_id" in ctx.callbackQuery.message &&
    typeof ctx.callbackQuery.message.message_thread_id === "number"
  ) {
    threadId = ctx.callbackQuery.message.message_thread_id;
  }

  return { chatId, threadId };
}

function targetMatchesScope(
  target: { chatId?: string | number; threadId?: number },
  scope: RoutingScope,
): boolean {
  if (target.chatId === undefined) {
    return false;
  }

  if (!isSameChatId(target.chatId, scope.chatId)) {
    return false;
  }

  if (scope.threadId !== undefined) {
    return target.threadId === scope.threadId;
  }

  return true;
}

function isSameChatId(a: string | number, b: string | number): boolean {
  return String(a) === String(b);
}

function readForumChatId(): string | number | null {
  const raw = process.env.TELEGRAM_FORUM_CHAT_ID?.trim();
  if (!raw) {
    return null;
  }
  if (/^-?\d+$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

async function getBotIdentity(): Promise<string> {
  try {
    const me = await bot.telegram.getMe();
    if (me.username) {
      return `@${me.username}`;
    }
    return me.first_name;
  } catch {
    return "(unavailable)";
  }
}

async function getForumMembershipDiagnostics(forumChatId: string | number): Promise<Record<string, unknown>> {
  try {
    const me = await bot.telegram.getMe();
    const member = (await bot.telegram.callApi("getChatMember", {
      chat_id: forumChatId,
      user_id: me.id,
    })) as unknown as Record<string, unknown>;

    return {
      ok: true,
      botId: me.id,
      username: me.username,
      status: member.status,
      canManageTopics: member.can_manage_topics,
      canPostMessages: member.can_post_messages,
      canManageChat: member.can_manage_chat,
      canDeleteMessages: member.can_delete_messages,
      isAnonymous: member.is_anonymous,
    };
  } catch (error) {
    return {
      ok: false,
      error: formatError(error),
    };
  }
}

function readGitRemote(cwd: string): string | undefined {
  try {
    const output = execSync("git config --get remote.origin.url", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf8")
      .trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function parseRepoNameFromRemote(remote: string | undefined): string | undefined {
  if (!remote) {
    return undefined;
  }

  const withoutGitSuffix = remote.replace(/\.git$/i, "");
  if (!withoutGitSuffix) {
    return undefined;
  }

  if (!withoutGitSuffix.includes("://") && withoutGitSuffix.includes(":")) {
    const sshPath = withoutGitSuffix.split(":").pop();
    if (!sshPath) {
      return undefined;
    }
    const candidate = path.basename(sshPath);
    return candidate || undefined;
  }

  try {
    const parsed = new URL(withoutGitSuffix);
    const candidate = path.basename(parsed.pathname);
    return candidate || undefined;
  } catch {
    const pieces = withoutGitSuffix.split("/");
    const candidate = pieces[pieces.length - 1];
    return candidate || undefined;
  }
}
