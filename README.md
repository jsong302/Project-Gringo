# Gringo — Slack Bot for Argentinian Spanish

A Slack bot that teaches Argentinian Spanish (Rioplatense dialect) to a small group of 6–15 people. Features free conversation practice, daily lessons, spaced repetition flashcards, and an LLM-powered admin interface.

## Features

**Learning Channels**
- **#charla-libre** — Free conversation with the bot in Rioplatense Spanish (text + voice memos)
- **#daily-lesson** — Mon–Fri at 9am, an LLM-generated lesson (grammar + vocab + exercise)
- **#lunfardo-del-dia** — Daily lunfardo (Argentine slang) word with etymology and examples
- **#repaso** — SM-2 spaced repetition flashcard reviews with interactive buttons
- **#desafios** — Challenge mode with dialogue simulations

**Core Systems**
- **SM-2 SRS** — Spaced repetition with ease factor, intervals, and quality ratings (0–5)
- **XP & Levels** — 5 levels gating content difficulty, with auto level-up on XP thresholds
- **Streaks** — Daily practice tracking with timezone awareness
- **Error Tracking** — Every grammar, vocab, conjugation, and pronunciation error is logged and used for personalization
- **User Memory** — LLM-generated learner profiles injected into prompts
- **Voice Memos** — Deepgram STT transcription with pronunciation feedback

**Admin**
- **Unified Admin Agent** — Chat with the bot in natural language (English or Spanish) to manage settings, users, prompts, errors, and SRS data. The agent seamlessly switches between admin operations and Spanish conversation practice.
- **Admin DMs** — DM the bot as an admin for a multi-turn conversational admin interface
- **`/gringo admin`** — Slash command for ephemeral admin interactions
- **16 admin tools** — Settings CRUD, user management, error analysis, prompt editing, SRS health, XP awards

**Onboarding**
- Automatic welcome DM when a new user joins the workspace
- Interactive level assessment (1–5) via buttons
- Voice memo tutorial with desktop/mobile instructions
- Channel guide and level-adapted first exercise

## Tech Stack

- **Runtime**: Node.js + TypeScript (CJS)
- **Slack**: `@slack/bolt` with Socket Mode
- **Database**: `sql.js` (SQLite in-memory/WAL) — 15 tables
- **LLM**: Anthropic Claude API (conversation, grading, lessons, admin agent)
- **STT**: Deepgram Nova-2 (voice memo transcription)
- **SRS**: SM-2 algorithm with DB-backed tunable constants
- **Scheduler**: `node-cron` for daily lesson/lunfardo jobs
- **Testing**: Vitest — 404 tests across 38 test files

## Project Structure

```
src/
├── app.ts                    # Boot sequence & entry point
├── db.ts                     # SQLite init, singleton, shutdown
├── config/                   # Typed env loading & validation
├── db/schema.sql             # Full 15-table schema
├── errors/                   # GringoError class & user-facing messages
├── handlers/                 # Slack event/command/action handlers
│   ├── commands.ts           # /gringo subcommands
│   ├── messageHandler.ts     # Text messages & voice memos
│   ├── reviewHandler.ts      # SRS review buttons
│   ├── adminHandler.ts       # Admin DM & slash command routing
│   └── onboardingHandler.ts  # team_join + level picker buttons
├── observability/            # AsyncLocalStorage trace context
├── scheduler/                # Cron job management
├── services/                 # Business logic
│   ├── llm.ts                # Claude API wrapper (chat + tool use)
│   ├── stt.ts                # Deepgram STT wrapper
│   ├── srs.ts                # SM-2 algorithm
│   ├── adminAgent.ts         # LLM agent loop with tools
│   ├── adminTools.ts         # 16 admin tool definitions
│   ├── charlaEngine.ts       # Conversation processing
│   ├── settings.ts           # DB-backed system settings with cache
│   ├── onboarding.ts         # Welcome flow Block Kit builders
│   └── ...                   # 11 more service modules
└── utils/                    # Logger, retry, timeout, Slack helpers
```

## Setup

```bash
# Install dependencies
npm install

# Copy and fill in env vars
cp .env.example .env

# Run in dev mode (tsx watch)
npm run dev

# Build for production
npm run build
npm start

# Run tests
npm test
```

### Required Environment Variables

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot user OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (`xapp-...`) |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `DEEPGRAM_API_KEY` | Deepgram API key for speech-to-text |

### Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DB_PATH` | `./data/gringo.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log level (trace/debug/info/warn/error) |
| `PORT` | `3000` | HTTP port (unused in Socket Mode) |
| `ADMIN_USER_IDS` | — | Comma-separated Slack user IDs to bootstrap as admins |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Claude model to use |

## Slack Workspace Setup

Before running the bot, create these channels and configure your Slack app:

### 1. Create Channels

Create the following public channels in your Slack workspace:

| Channel | Purpose |
|---|---|
| `#charla-libre` | Free conversation practice with the bot |
| `#daily-lesson` | Daily lessons posted Mon–Fri at 9am |
| `#lunfardo-del-dia` | Daily lunfardo word posted at noon |
| `#repaso` | SRS flashcard review sessions |
| `#desafios` | Pair practice / dialogue challenges |

After creating each channel, **invite the bot** to it (`/invite @Gringo`).

### 2. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** → **From scratch**
2. Name it `Gringo` and select your workspace

### 3. Enable Socket Mode

1. Go to **Settings → Socket Mode** and enable it
2. Generate an app-level token with the `connections:write` scope — this is your `SLACK_APP_TOKEN` (`xapp-...`)

### 4. Bot Token Scopes

Go to **OAuth & Permissions → Scopes → Bot Token Scopes** and add:

| Scope | Reason |
|---|---|
| `chat:write` | Send messages |
| `commands` | Handle slash commands |
| `files:read` | Read voice memo audio files |
| `files:write` | Upload pronunciation audio clips |
| `im:history` | Read DM messages (for charla + admin) |
| `im:write` | Send DMs (onboarding, notifications) |
| `channels:history` | Read messages in public channels |
| `users:read` | Look up user info |
| `team:read` | Detect new members for onboarding |

Install the app to your workspace. The **Bot User OAuth Token** (`xoxb-...`) is your `SLACK_BOT_TOKEN`.

### 5. Slash Command

Go to **Slash Commands** and create:

| Command | Request URL | Description |
|---|---|---|
| `/gringo` | *(leave blank for Socket Mode)* | Gringo bot commands |

### 6. Event Subscriptions

Go to **Event Subscriptions** → enable events, then under **Subscribe to bot events** add:

| Event | Reason |
|---|---|
| `message.channels` | Respond to messages in channels |
| `message.im` | Respond to DMs (charla + admin) |
| `team_join` | Trigger onboarding for new members |

### 7. Signing Secret

Go to **Basic Information → App Credentials** and copy the **Signing Secret** — this is your `SLACK_SIGNING_SECRET`.

### 8. Set Environment Variables

Fill in your `.env` file with the tokens from steps above (see Required Environment Variables below).

### 9. Bootstrap Admins

Set `ADMIN_USER_IDS` in your `.env` to a comma-separated list of Slack user IDs who should have admin access. You can find user IDs by clicking a user's profile in Slack → **More** → **Copy member ID**.

## Slash Commands

| Command | Description |
|---|---|
| `/gringo help` | Show the full guide |
| `/gringo level [1-5]` | View or set your level |
| `/gringo stats` | Your XP, streak, cards, and error summary |
| `/gringo repaso` | Start an SRS review session |
| `/gringo admin <message>` | Admin agent (admins only) |
| `/gringo onboard` | Re-send the welcome DM |

## Architecture Notes

- **Socket Mode** — No public URL needed; uses WebSocket via `SLACK_APP_TOKEN`
- **Idempotent boot** — `CREATE TABLE IF NOT EXISTS` + idempotent seeding means safe restarts
- **Settings in DB** — All tunable constants (SRS params, cron schedules, XP thresholds) are in `system_settings`, editable at runtime via the admin agent
- **Admin bootstrap** — `ADMIN_USER_IDS` env var seeds initial admins; they can add others at runtime
- **Graceful shutdown** — SIGINT/SIGTERM stops cron, closes DB, and disconnects Slack cleanly
