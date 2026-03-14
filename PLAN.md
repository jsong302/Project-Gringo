# Project Gringo — Argentinian Spanish Slack Bot

## What

Slack bot that teaches Argentinian Spanish (Rioplatense) to a small group preparing for an Argentina mission trip. Features structured curriculum with lessons and exercises on the App Home tab, voice memo practice, AI conversation in DMs, spaced repetition (SRS), and an admin agent with 30+ tools. Self-tuning — adapts based on user performance and feedback. Admin-controllable without redeployment.

## Tech Stack

- **TypeScript + Node.js 18+**
- **@slack/bolt** — Slack bot framework (Socket Mode)
- **Claude** — tutor brain (Anthropic SDK)
- **Deepgram Nova-3** — voice memo transcription
- **Google Cloud TTS** — pronunciation audio and voice feedback
- **sql.js** — in-process SQLite database (file-backed)
- **node-cron** — scheduled content
- **vitest** — testing

---

## Architecture

### App Home Tab (Primary Learning Surface)

The Home tab is the main interface for structured learning. It's state-driven via `HomeSessionState`:

- **Dashboard** — profile, curriculum progress bar, stats, learner profile, action buttons
- **Lesson view** — shared lesson from bank + per-user exercise, with Answer/Voice/Back buttons
- **Grade view** — pass/fail feedback with score, errors, correction
- **SRS review** — card front → Show Answer → grade buttons (Again/Hard/Good/Easy)
- **SRS summary** — review stats
- **Curriculum browser** — all units by level, clickable for admins (locked for regular users)

Exercise answers are submitted via a **modal** (Home tab doesn't support text input).

### DMs (Conversational Practice)

DMs are for free-form conversation (charla) with the AI tutor. The charla engine provides personalized Spanish practice using the user's level, memory, and error history. Voice memos are also graded in DMs and results sync to the Home tab.

### Channels

| Channel | Purpose |
|---------|---------|
| `#daily-lesson` | Scheduled lessons Mon-Fri at 9am ET |
| `#lunfardo-del-dia` | Daily lunfardo (slang) word at 12pm ET |
| `#desafios` | Pair practice challenges between users |

Channel IDs are configured via `system_settings` (not hardcoded).

---

## Slash Commands

All under `/gringo`:

| Command | Description |
|---------|-------------|
| `/gringo help` | Channel guide and commands |
| `/gringo next` | Load next lesson to Home tab |
| `/gringo repaso` | Start SRS review session |
| `/gringo progress` | View curriculum progress |
| `/gringo level [1-5]` | View or set proficiency level |
| `/gringo stats` | View streak, SRS stats, error patterns |
| `/gringo profile` | View learner profile and memory |
| `/gringo plan` | View lesson plan |
| `/gringo timezone [tz]` | Set timezone |
| `/gringo notifications` | Manage notification preferences |
| `/gringo desafio` | Start pair practice challenge |
| `/gringo onboard` | Re-trigger onboarding DM |
| `/gringo admin <msg>` | Admin agent (chat-based, restricted) |

---

## Content System

### Shared Lesson Bank

Lessons are generated once per curriculum unit and stored in the `lesson_bank` table. All users see the same lesson text. Exercises are generated per-user and cached in `user_curriculum_progress`.

### Curriculum

41 units across 5 levels (editable by admins via the agent). Each unit has:
- `topic`, `title`, `description`, `level_band` (1-5)
- `lesson_prompt`, `exercise_prompt` (templates for LLM generation)
- `pass_threshold` (score needed to pass, default 3/5)

Users progress linearly: active → practicing → passed → next unit activates.

### SRS (SM-2 Algorithm)

- Cards auto-created from vocabulary encountered in lessons/conversations
- Quality scale: Again (1), Hard (2), Good (4), Easy (5)
- Review on Home tab with inline card rendering
- Standard SM-2 intervals with ease factor adjustment

---

## Onboarding Flow

1. User joins workspace or channel → bot sends welcome DM
2. Self-assessment buttons (No Spanish / Some basics / Conversational / Advanced)
3. Placement test (multiple choice) or skip for beginners
4. Response mode preference (text feedback vs voice memo feedback)
5. Voice memo tutorial
6. Channel guide
7. Home tab shows welcome screen until onboarded, then switches to dashboard

---

## Admin System

### `/gringo admin <message>`

Chat-based admin interface powered by the charla engine with admin tools. The LLM detects admin users and gets access to 31 tools:

**Users & Progress**
- `list_users`, `get_user_detail`, `update_user_level`, `place_user_at_unit`

**Curriculum**
- `view_curriculum`, `view_curriculum_progress`, `edit_curriculum_unit`
- `add_curriculum_unit`, `reorder_curriculum_unit`, `archive_curriculum_unit`, `remove_curriculum_unit`

**Lesson Bank**
- `view_lesson_bank`, `generate_lesson_bank` (background), `regenerate_lesson`

**Settings & System**
- `list_settings`, `get_setting`, `update_setting`, `manage_admins`

**Prompts**
- `list_prompts`, `get_prompt`, `update_prompt`

**Diagnostics**
- `get_error_trends`, `get_user_errors`, `analyze_error_patterns`, `get_srs_health`

**Learning Tools**
- `log_learning_error`, `get_learner_context`, `pronounce`

---

## Cron Jobs

| Job | Schedule | Description |
|-----|----------|-------------|
| `daily-lesson` | 9am weekdays | Post lesson to #daily-lesson |
| `lunfardo-del-dia` | 12pm daily | Post slang word to #lunfardo-del-dia |
| `srs-reminders` | 10am daily | DM users with due SRS cards |
| `stale-thread-cleanup` | 3am daily | Close old conversation threads |
| `onboarding-follow-up` | Hourly | Nudge users who onboarded but haven't practiced |

Schedules are overridable via `system_settings`.

---

## Memory System

### Layer 1: Structured Data (automatic)
Raw facts from every interaction — SRS scores, errors, vocab encounters, session history. SQL inserts, no AI needed.

### Layer 2: Learner Profile (AI-generated, periodic)
Every 20 interactions, Claude rewrites a ~200-300 word learner summary stored in `user_memory`:
- Profile summary, strengths, weaknesses
- Interests and preferred topics
- Pronunciation tendencies

### Layer 3: Active Context (assembled per-interaction)
Every Claude call injects: learner profile (~300 tokens) + recent errors (~200 tokens) + SRS stats (~100 tokens).

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `users` | Slack user ID, level, streak, display name, timezone, response mode, onboarded flag |
| `curriculum_units` | 41 units with order, topic, title, level band, prompts, pass threshold |
| `user_curriculum_progress` | Per-user per-unit status (locked/active/practicing/passed/skipped), attempts, scores, cached exercise text |
| `lesson_bank` | Shared generated lessons per unit |
| `home_sessions` | Home tab state persistence for crash recovery |
| `srs_cards` | SM-2 fields per user per content item |
| `review_log` | Individual review records |
| `user_memory` | AI-generated learner profiles |
| `learning_errors` | Language mistakes with corrections |
| `system_errors` | Operational errors |
| `system_prompts` | All LLM prompts (editable via admin) |
| `system_settings` | Runtime config (channels, cron schedules, admin IDs) |
| `vocabulary` | Spanish/English pairs with context |
| `phrases` | Phrase pairs with cultural notes |
| `vesre` | Syllable-flipped wordplay pairs |
| `conjugations` | Voseo conjugation tables |
| `conversation_threads` | Thread-based conversation tracking |
| `conversation_messages` | Message history for context |
| `lesson_log` | Lessons posted and participation |
| `lesson_engagement` | Reactions and response tracking |
| `lesson_plans` | Per-user lesson plan sequences |
| `user_vocab_encounters` | Word exposure tracking |
| `user_feedback` | User feedback messages |
| `learner_facts` | Structured facts about learners |
| `placement_tests` | Placement test results |
| `review_sessions` | Active review session tracking |

---

## Project Structure

```
src/
  app.ts                          # Entry point, Slack Bolt app
  config/
    env.ts                        # Environment config
  db.ts                           # sql.js database singleton
  db/
    schema.sql                    # Full schema
  errors/
    gringoError.ts
    formatUserFacingError.ts
  handlers/
    commands.ts                   # Slash command router
    homeHandler.ts                # App Home tab (dashboard, lessons, SRS, curriculum)
    messageHandler.ts             # DM message handler (charla + voice memos)
    adminHandler.ts               # Admin slash command handler
    onboardingHandler.ts          # New user welcome flow
    reviewHandler.ts              # SRS review actions
    desafioHandler.ts             # Pair practice
  services/
    charlaEngine.ts               # Conversational AI engine (DMs + admin)
    llm.ts                        # Claude API client
    curriculum.ts                 # Curriculum CRUD operations
    curriculumDelivery.ts         # Lesson/exercise generation, grading, lesson bank
    homeSession.ts                # Home tab state management
    srs.ts                        # SM-2 algorithm (pure functions)
    srsRepository.ts              # SRS card database operations
    reviewSession.ts              # Review session management
    cardContent.ts                # SRS card content rendering
    placementTest.ts              # Placement test logic
    onboarding.ts                 # Onboarding Block Kit builders
    userService.ts                # User CRUD
    userMemory.ts                 # Learner profile management
    settings.ts                   # System settings with cache
    adminTools.ts                 # 31 admin tools for the LLM agent
    lessonEngine.ts               # Channel lesson generation
    lunfardoEngine.ts             # Lunfardo del día generation
    pronunciation.ts              # TTS audio generation
    errorTracker.ts               # Error pattern tracking
    notifications.ts              # SRS reminders and follow-ups
    curriculumMigration.ts        # Migrate existing users to curriculum
    ...
  scheduler/
    cron.ts                       # Cron job orchestration
  observability/
    context.ts                    # Request tracing
  utils/
    logger.ts                     # Scoped logger
    slackHelpers.ts               # Slack API helpers
    slackAudio.ts                 # Audio upload to Slack
    retry.ts                      # Retry with backoff
```

---

## Deployment

- VPS at 149.28.53.166
- PM2 process manager (`pm2 restart gringo`)
- Database file at `/opt/gringo/data/gringo.db`
- Git-based deploys: `git pull && npm run build && pm2 restart gringo`

---

## Per-User Levels (1-5)

| Level | Vocab | Grammar | Lunfardo | Prompts |
|-------|-------|---------|----------|---------|
| 1 | Basic greetings, numbers | Present tense voseo | None yet | Simple (introduce yourself) |
| 2 | Daily life, food, transport | Present + past tense voseo | Basic (che, dale, boludo) | Descriptive (describe your day) |
| 3 | Work, emotions, opinions | All tenses + imperative | Common lunfardo | Situational (at the market) |
| 4 | Abstract concepts, idioms | Subjunctive, conditionals | Full lunfardo + vesre | Complex (debate, stories) |
| 5 | Nuanced expression, humor | All grammar, natural flow | Deep lunfardo, wordplay | Free-form (joke, negotiate) |

---

## API Keys Required

- **Anthropic** — Claude (tutor, lessons, grading, admin agent)
- **Deepgram** — Nova-3 (voice transcription)
- **Google Cloud** — TTS (pronunciation audio, voice feedback)
