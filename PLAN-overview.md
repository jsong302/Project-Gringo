# Project Gringo — How the Bot Works

A Slack bot that teaches Argentinian Spanish (Rioplatense dialect) to a small group preparing for an Argentina mission trip. The bot provides structured lessons, voice memo practice, AI-powered conversation, and personalized feedback. It remembers each person's strengths, weaknesses, and progress over time and adapts accordingly.

---

## What It Teaches

- **Voseo** — the Argentinian way of conjugating verbs (using "vos" instead of "tú"). For example: "vos hablás" instead of "tú hablas"
- **Lunfardo** — Buenos Aires street slang (~200 words), mostly with Italian origins. Words like "laburo" (work), "morfar" (to eat), "guita" (money)
- **Sheísmo** — the distinct Argentinian pronunciation where "ll" and "y" sound like "sh". So "calle" sounds like "cashe" and "playa" sounds like "plasha"
- **Vesre** — a fun Argentinian wordplay where syllables get flipped. "Café" becomes "feca", "hotel" becomes "telo"
- **Culture** — mate etiquette, porteño customs, Buenos Aires neighborhoods, regional expressions
- **Christian vocabulary** — church, faith, prayer, and ministry terms in Argentine Spanish

---

## How You Learn

### The Home Tab (Your Dashboard)

When you open the Gringo app in Slack and click the **Home** tab, you see your personal dashboard:

- **Profile** — your name, level, streak, feedback mode, timezone
- **Curriculum Progress** — a progress bar showing how many units you've completed out of 41
- **Stats** — SRS cards, common errors, learner profile summary
- **Action buttons** — Next Unit, Practice SRS, View Curriculum

This is where you do your structured learning. When you click **Next Unit**, the bot loads a lesson and exercise right on the Home tab. You read the lesson, then click **Answer** to open a popup where you type your response in Spanish. The bot grades it and shows your score, feedback, and corrections — all on the Home tab.

If you pass (score 3/5 or higher), you move to the next unit. If not, you can try again with feedback on what to fix.

### DM Conversations (Free Practice)

Send the bot a message in DMs anytime to practice conversational Spanish. The bot responds in Rioplatense Spanish, using voseo and lunfardo appropriate to your level. If you make mistakes, it gently corrects you. You can also send voice memos — the bot transcribes them, grades your pronunciation, and gives feedback.

### Channels

| Channel | What Happens |
|---------|-------------|
| `#daily-lesson` | A new lesson posts Monday-Friday at 9am. Read it, practice, and reply in the thread |
| `#lunfardo-del-dia` | A new slang word posts every day at noon with etymology, meaning, and usage examples |
| `#desafios` | Pair practice — get matched with another member for a conversation scenario |

### Voice Memos

Speaking practice is critical. You can send voice memos in DMs:

**On desktop:**
1. Click the **+** icon to the left of the message field
2. Select **"Record audio clip"**
3. Record and send

**On mobile:**
1. Tap the **microphone** icon
2. Hold to record
3. Release to send

The bot transcribes your audio, evaluates it, and gives feedback on pronunciation and grammar.

---

## The 41-Unit Curriculum

The curriculum has 41 units across 5 levels, progressing from basic greetings to advanced conversation:

**Level 1 (Beginner):** Greetings, numbers, basic questions, ser vs estar, present tense, food, getting around, family, time, shopping, review

**Level 2 (Elementary):** Voseo introduction, past tense, describing things, weather, church vocabulary, feelings, phone/messaging, health, imperfect tense, review

**Level 3 (Intermediate):** Lunfardo basics, subjunctive, sharing your faith, opinions, Argentine culture, narrating events, conditional tense, slang, prayer/worship, review

**Level 4 (Upper Intermediate):** Vesre wordplay, complex subjunctive, humor/irony, pastoral conversations, idioms, social topics, advanced lunfardo

**Level 5 (Advanced):** Leading a Bible study, native-speed comprehension, final review & graduation

Each unit has a shared lesson (same for everyone) and a personalized exercise (generated for you based on your level and history). You need to score 3/5 or higher to pass and move to the next unit.

---

## Spaced Repetition (SRS)

The bot tracks vocabulary from your lessons and conversations using a spaced repetition system. Words you struggle with come back sooner. Words you know well get pushed further out.

Click **Practice SRS** on the Home tab to review due cards. Each card shows the front (a question), you think of the answer, then click **Show Answer** to see it. Rate yourself: Again, Hard, Good, or Easy. The bot adjusts the review schedule accordingly.

---

## Five Levels

| Level | What You're Learning |
|-------|---------------------|
| **1 - Beginner** | Basic greetings, numbers, common words. Present tense voseo only. No slang yet |
| **2 - Elementary** | Daily life vocab. Past tense voseo. Basic slang (che, dale, boludo) |
| **3 - Intermediate** | Work, emotions, opinions. All tenses. Common lunfardo. Faith vocabulary |
| **4 - Upper Intermediate** | Abstract concepts, idioms. Subjunctive and conditionals. Full lunfardo + vesre |
| **5 - Advanced** | Nuanced expression, humor. All grammar. Deep slang. Ministry and pastoral language |

---

## The Bot Remembers You

The bot builds a profile of each person over time:
- What words and grammar points you've practiced
- What mistakes you tend to make repeatedly
- Your strengths and areas that need work
- How your pronunciation is developing

This profile gets updated regularly and is used every time the bot interacts with you, so feedback is always personalized.

---

## Commands You Can Use

| Command | What It Does |
|---------|-------------|
| `/gringo help` | Shows all available commands |
| `/gringo next` | Load the next lesson on your Home tab |
| `/gringo repaso` | Start an SRS review session |
| `/gringo progress` | See your curriculum progress |
| `/gringo level` | View or change your level (1-5) |
| `/gringo stats` | View your streak, SRS cards, and error patterns |
| `/gringo profile` | View your learner profile |
| `/gringo plan` | View your lesson plan |
| `/gringo desafio` | Get paired with another member for a conversation challenge |
| `/gringo timezone` | Set your timezone |
| `/gringo notifications` | Manage reminder preferences |
| `/gringo onboard` | Re-run the onboarding setup |

---

## Getting Started

1. **Check your DMs** — the bot sends you a welcome message when you join (or type `/gringo onboard` to trigger it)
2. **Take the placement test** — a few quick multiple-choice questions, or skip if you're a complete beginner
3. **Pick your feedback style** — text corrections with audio clips, or full voice memo explanations
4. **Open the Home tab** — click on the Gringo app and go to Home. This is your dashboard
5. **Click Next Unit** — start your first lesson!
6. **Chat in DMs** — send the bot a message anytime to practice conversational Spanish

---

## Admin Controls

Admins can manage the bot by typing `/gringo admin` followed by natural language. The bot understands requests like:

- "show all users" — list users with levels and progress
- "show curriculum" — view all 41 units
- "edit unit 5" — change a unit's title, prompts, or pass threshold
- "add unit after 3" — insert a new unit
- "remove unit 12" — permanently delete a unit
- "generate lesson bank" — generate shared lessons for all units
- "show settings" — view all system settings
- "add @user as admin" — manage admin access
- "update prompt conversation" — edit the bot's personality

Changes take effect immediately — no restarts needed.
