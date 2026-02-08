# Codex + Telegram Bot (TypeScript)

A Telegram bot that controls a local `@openai/codex-sdk` session per chat.

## Features

- Streams Codex events and updates a single Telegram message in place (`editMessageText`) to reduce notification spam.
- Sends typing indicators while Codex is running.
- Maintains one Codex thread per Telegram chat and persists thread IDs.
- Supports inline multi-select follow-up questions via Telegram inline keyboards.
- Supports run interruption and quick prompt replacement.
- Supports Telegram voice/audio transcription via OpenAI Audio Transcriptions API (`gpt-4o-transcribe`).
- Sends a spoken MP3 version of the final Codex response via OpenAI TTS (`/v1/audio/speech`).
- Supports optional YOLO mode (`danger-full-access` + `never` approvals).
- Optionally auto-registers each host/repo location into a Telegram forum supergroup topic and posts startup metadata.
- Emits structured CLI logs with configurable `LOG_LEVEL` (`debug|info|warn|error`).

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
# then set TELEGRAM_BOT_KEY and OPENAI_API_KEY in .env
```

3. Run in dev mode:

```bash
npm run dev
```

## Commands

- `/run <prompt>`: run a Codex turn
- `/new`: start a fresh thread for the current chat
- `/thread`: show current thread id
- `/stop`: interrupt active run
- `/chatid`: print the current Telegram chat id (+ topic thread id when present)
- `/announce`: manually post location metadata to the configured forum topic
- plain text message: treated as prompt
- voice note / audio file: transcribed, then sent as prompt

## Build and run

```bash
npm run build
npm start
```

## Notes

- Session IDs are persisted at `data/chat-sessions.json`.
- Location-to-topic mappings are persisted at `data/location-topics.json`.
- This project uses `TELEGRAM_BOT_KEY` directly, matching your current `.env` key name.
- For auto-registration, set `TELEGRAM_FORUM_CHAT_ID` to your forum-enabled supergroup id (usually like `-100...`) and give the bot topic-management rights.
