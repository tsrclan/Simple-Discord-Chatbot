# AI Royal Discord Chatbot

A mention-only Discord bot that replies using any OpenAI-compatible Chat Completions API.

This is the same bot deployed on https://discord.gg/tsrclan <3

## Features
- Replies only when mentioned
- Per-user short memory with size limits
- Slash commands for system prompt and reset
- Optional auto-ban channel protection

## Requirements
- Node.js 18+ (built-in `fetch`)
- A Discord application + bot token
- An OpenAI-compatible API key (OpenAI, OpenRouter, Novita, etc.)

## Setup
1) Create a Discord app and bot at https://discord.com/developers/applications
2) Enable the Message Content intent for the bot
3) Install dependencies:
```bash
npm install
```
4) Create your env file:
```bash
cp .env.example .env
```
5) Fill the required values in `.env`:
```
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
OPENAI_API_KEY=...
```
6) Start the bot:
```bash
node ai-royal.js
```

Slash commands are registered on startup. Use `DISCORD_GUILD_ID` to register to a single guild for faster updates while testing.

## Configuration
All config lives in `.env`. Key options:

### Discord
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID` (optional)

### OpenAI-compatible provider
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL` (base URL like `https://api.openai.com/v1`)
- `OPENAI_API_URL` (full endpoint override)
- `OPENAI_MODEL`
- `OPENAI_AUTH_HEADER` / `OPENAI_AUTH_PREFIX` (optional overrides)
- `OPENAI_EXTRA_HEADERS` (JSON string for extra headers)

### System prompt
Set the system prompt with the slash command:
```
/systemprompt prompt:"You are a helpful Discord assistant."
```

### Auto-ban
Optional protection for specific channels:
- `AUTO_BAN_CHANNEL_IDS` (comma-separated channel IDs)
- `AUTO_BAN_DELETE_MESSAGE_SECONDS`

Use this to create a "Trap" channel that auto-bans known spammers (for example, bots that blast casino image spam across channels).

## Provider Examples

OpenAI:
```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

OpenRouter:
```
OPENAI_API_KEY=...
OPENAI_API_URL=https://openrouter.ai/api/v1/chat/completions
OPENAI_MODEL=meta-llama/llama-3.1-8b-instruct
OPENAI_EXTRA_HEADERS={"HTTP-Referer":"https://example.com","X-Title":"Discord Bot"}
```

Novita:
```
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.novita.ai/openai
OPENAI_MODEL=deepseek/deepseek-r1
```

## Slash Commands
- `/systemprompt` - set a global system prompt
- `/reset` - clear all conversation memory

## Notes
- The bot only replies when mentioned.
- DMs are ignored for the chat assistant.

