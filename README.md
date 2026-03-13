# Gringo — Slack Bot for Argentine Spanish

A Slack bot that teaches Argentine Spanish (Rioplatense dialect) to a mission trip group of 6-15 people. Features free conversation practice, daily lessons, spaced repetition flashcards, voice processing, and an LLM-powered admin interface.

## Features

### Daily Content
- **Daily Lessons** — AI-generated grammar + vocabulary lessons posted to `#daily-lesson` (Mon-Fri at 9 AM ET). All explanations in English, Spanish only in examples and exercises.
- **Lunfardo del Dia** — Daily Argentine slang word with English etymology, translated examples, and cultural notes posted to `#lunfardo-del-dia` (daily at noon ET)
- Vocabulary from lessons is automatically converted into SRS flashcards

### Free Conversation (Charla)
- Chat with Gringo via DMs, `@mentions`, or in monitored channels (`#daily-lesson`, `#lunfardo-del-dia`)
- Scaffolded teaching: one concept at a time, practice before moving on
- The LLM handles all intent detection naturally — confusion, questions, profile updates — no regex heuristics
- LLM tool use during conversation:
  - **Observations** — logs errors, strengths, interests, and knowledge gaps to build your learner profile
  - **Profile updates** — automatically updates your level, timezone, name, and interests when you mention them
  - **Pronunciation** — generates Azure TTS audio clips on demand

### Voice Processing
- Voice memo transcription via Deepgram STT
- Pronunciation evaluation and feedback from the LLM
- TTS audio with Argentine Spanish voice (`es-AR-ElenaNeural`) at 0.85x speed for learner-friendly pacing

### Spaced Repetition (SRS)
- SM-2 algorithm for vocabulary, conjugations, phrases, and vesre (Argentine word reversals)
- Interactive review sessions with quality scoring (Again, Hard, Good, Easy)
- Personalized scheduling based on performance

### Pair Practice (Desafio)
- Scenario-based dialogue practice between two students
- LLM-generated scenarios adapted to both users' levels and interests

### Progress & Gamification
- XP system with automatic level-ups (levels 1-5)
- Daily practice streaks with timezone awareness
- AI-generated learner profile (strengths, weaknesses, interests, pronunciation notes)
- Error pattern tracking across grammar, vocabulary, conjugation, and pronunciation

### Admin
- **Unified Admin Agent** — Chat in natural language to manage settings, users, prompts, errors, and SRS data
- **16 admin tools** — Settings CRUD, user management, error analysis, prompt editing, SRS health, XP awards
- Access via `/gringo admin <message>` or DM the bot as an admin

### Onboarding
- Automatic welcome DM when a new user joins the workspace
- Interactive level assessment (1-5) via buttons
- Voice memo tutorial with desktop/mobile instructions
- Channel guide and level-adapted first exercise

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Slack**: `@slack/bolt` with Socket Mode
- **LLM**: Anthropic Claude (Haiku 4.5 default, configurable)
- **Speech-to-Text**: Deepgram
- **Text-to-Speech**: Azure Speech Services (SSML with prosody rate control)
- **Database**: `sql.js` (SQLite) — 22 tables
- **Scheduler**: `node-cron`
- **Testing**: Vitest

## Setup

```bash
npm install
cp .env.example .env   # Fill in env vars
npm run dev             # Dev mode (tsx watch)
npm run build && npm start  # Production
npm test                # Run tests
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
| `AZURE_SPEECH_KEY` | — | Azure Speech Services key (for TTS) |
| `AZURE_SPEECH_REGION` | `eastus` | Azure region |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Claude model |
| `ANTHROPIC_MAX_TOKENS` | `1024` | Max tokens per LLM response |
| `DB_PATH` | `./data/gringo.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log level (trace/debug/info/warn/error) |
| `PORT` | `3000` | HTTP port (unused in Socket Mode) |
| `ADMIN_USER_IDS` | — | Comma-separated Slack user IDs for admins |

## Slack Workspace Setup

### 1. Create Channels

| Channel | Purpose |
|---|---|
| `#daily-lesson` | Daily lessons posted Mon-Fri at 9 AM ET |
| `#lunfardo-del-dia` | Daily lunfardo word posted at noon ET |

After creating each channel, invite the bot (`/invite @Gringo`). The bot automatically listens and responds to all messages in these channels.

### 2. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
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
| `im:history` | Read DM messages |
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
| `message.im` | Respond to DMs |
| `team_join` | Trigger onboarding for new members |

### 7. Signing Secret

Go to **Basic Information → App Credentials** and copy the **Signing Secret** — this is your `SLACK_SIGNING_SECRET`.

### 8. Bootstrap Admins

Set `ADMIN_USER_IDS` in your `.env` to a comma-separated list of Slack user IDs who should have admin access.

## Slash Commands

| Command | Description |
|---|---|
| `/gringo help` | Show available commands |
| `/gringo level [1-5]` | View or set proficiency level |
| `/gringo stats` | XP, streak, SRS cards, error patterns |
| `/gringo profile` | Learner profile (strengths, weaknesses, interests) |
| `/gringo plan` | View or generate personalized lesson plan |
| `/gringo repaso` | Start an SRS review session |
| `/gringo desafio [@user]` | Start pair practice (random or targeted) |
| `/gringo notifications` | View/configure notification settings |
| `/gringo notifications quiet HH:MM HH:MM` | Set quiet hours |
| `/gringo timezone <IANA>` | Set timezone (e.g. `America/New_York`) |
| `/gringo onboard` | Restart onboarding flow |
| `/gringo admin <message>` | Admin interface (admin only) |

## Scheduled Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| Daily Lesson | 9 AM ET, Mon-Fri | Post lesson to `#daily-lesson` |
| Lunfardo del Dia | 12 PM ET, daily | Post slang word to `#lunfardo-del-dia` |
| SRS Reminders | 10 AM ET, daily | DM users with due cards |
| Stale Thread Cleanup | 3 AM ET, daily | Close abandoned conversation threads |
| Onboarding Follow-up | Hourly | Nudge incomplete onboardings |

All schedules are configurable via system settings in the database.

## Project Structure

```
src/
├── app.ts                    # Boot sequence & entry point
├── config/                   # Typed env loading & validation
├── db/                       # SQLite init & schema (22 tables)
├── errors/                   # GringoError class & user-facing messages
├── handlers/
│   ├── commands.ts           # /gringo slash command router
│   ├── messageHandler.ts     # Text/voice message routing
│   ├── reviewHandler.ts      # SRS review session UI
│   ├── desafioHandler.ts     # Pair practice matching
│   ├── onboardingHandler.ts  # Welcome flow & level picker
│   └── adminHandler.ts       # Admin DM & slash command routing
├── observability/            # AsyncLocalStorage trace context
├── scheduler/                # Cron job management
├── services/
│   ├── charlaEngine.ts       # Free conversation + LLM tool use
│   ├── lessonEngine.ts       # Daily lesson generation & grading
│   ├── srs.ts                # SM-2 algorithm (pure functions)
│   ├── srsRepository.ts      # SRS card CRUD & scheduling
│   ├── tts.ts                # Azure TTS (SSML + prosody)
│   ├── stt.ts                # Deepgram STT
│   ├── llm.ts                # Claude API wrapper (chat + tool use)
│   ├── userService.ts        # User CRUD, XP, streaks, levels
│   ├── learnerFacts.ts       # Observation storage (errors, strengths, interests)
│   ├── userMemory.ts         # AI-generated learner profiles
│   ├── lessonPlan.ts         # Personalized lesson plans
│   ├── adminAgent.ts         # LLM agent loop with admin tools
│   ├── adminTools.ts         # 16 admin tool definitions
│   ├── settings.ts           # DB-backed system settings with cache
│   ├── prompts.ts            # Prompt template management
│   ├── onboarding.ts         # Welcome flow Block Kit builders
│   ├── notifications.ts      # DM reminders (SRS, lessons, follow-up)
│   └── ...
└── utils/                    # Logger, Slack helpers, audio upload
```

## Architecture Notes

- **Socket Mode** — No public URL needed; uses WebSocket via `SLACK_APP_TOKEN`
- **Idempotent boot** — `CREATE TABLE IF NOT EXISTS` + idempotent seeding means safe restarts
- **Settings in DB** — All tunable constants (SRS params, cron schedules, XP thresholds, TTS voice/speed) are in `system_settings`, editable at runtime via the admin agent
- **LLM-driven intent** — No regex-based intent detection; the LLM handles confusion, questions, profile updates, and observations via tool use
- **Prompt upserts** — Prompt text updates on restart via `ON CONFLICT DO UPDATE`; no DB wipe needed for prompt changes
- **Graceful shutdown** — SIGINT/SIGTERM stops cron, closes DB, and disconnects Slack cleanly

## Deployment

Running on a VPS with pm2:

```bash
ssh root@your-server
cd /opt/gringo
git pull
npm run build
pm2 restart gringo
```
