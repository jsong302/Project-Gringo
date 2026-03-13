# Project Gringo — How the Bot Works

A Slack bot that teaches Argentinian Spanish (Rioplatense dialect) to a group of 6-15 people through daily lessons, voice memo practice, AI-powered conversation, and personalized feedback. The bot remembers each person's strengths, weaknesses, and progress over time and adapts accordingly.

---

## What It Teaches

- **Voseo** — the Argentinian way of conjugating verbs (using "vos" instead of "tú"). For example: "vos hablás" instead of "tú hablas"
- **Lunfardo** — Buenos Aires street slang (~200 words), mostly with Italian origins. Words like "laburo" (work), "morfar" (to eat), "guita" (money)
- **Sheísmo** — the distinct Argentinian pronunciation where "ll" and "y" sound like "sh". So "calle" sounds like "cashe" and "playa" sounds like "plasha"
- **Vesre** — a fun Argentinian wordplay where syllables get flipped. "Café" becomes "feca", "hotel" becomes "telo"
- **Culture** — mate etiquette, porteño customs, Buenos Aires neighborhoods, regional expressions

---

## The Slack Workspace

The bot lives in a Slack workspace with 5 channels, each serving a different purpose:

### #daily-lesson
A new lesson is posted here every day at a set time. Each lesson includes:
- 3-5 new vocabulary words (with audio pronunciation)
- A grammar point (how to conjugate a certain verb with vos, for example)
- A cultural note (like how to properly share mate)
- A listening exercise — the bot plays an audio clip and you try to transcribe or answer a question about it
- A voice prompt — a question or scenario for you to respond to by recording a voice memo

You reply in the thread with a voice memo, and the bot gives you personalized feedback: what you got right, grammar corrections, pronunciation tips, and new vocabulary to learn.

### #charla-libre (Free Chat)
This is an open conversation channel. Send a voice memo or text message anytime and the bot will respond in Argentinian Spanish — using voseo, lunfardo appropriate to your level, and natural Rioplatense expressions. If you make mistakes, it gently corrects you inline. Conversations happen in threads so multiple people can chat at once.

You can also start a **roleplay scenario** here by typing something like `/charlar en el kiosco` (at the convenience store) or `/charlar pidiendo un remís` (ordering a rideshare). The bot becomes a character in that scenario and you go back and forth for 5-10 exchanges. At the end, it gives you a summary of corrections, new vocab, and fluency notes.

### #lunfardo-del-dia (Slang of the Day)
Every day, the bot picks a new lunfardo word the group hasn't seen yet and posts:
- The word and how to pronounce it
- Where it comes from (usually Italian)
- What it means
- An example sentence
- How and when people actually use it

Then it asks you to use the word in a sentence via voice memo.

### #repaso (Review)
This is where spaced repetition happens. The bot tracks every word and grammar point you've learned, and schedules reviews at optimal intervals — showing you things right before you'd forget them. You can start a review anytime by typing `/repaso`, or the bot will send you a daily reminder.

Reviews come as cards in a thread:
- **Vocab cards** — the bot shows you a Spanish word, you record a voice memo using it in a sentence
- **Conjugation cards** — the bot gives you a verb and a tense, you respond with the correct vos form
- **Phrase cards** — the bot shows you an English phrase, you translate it into Rioplatense Spanish

The bot scores your responses and adjusts the review schedule. Words you struggle with come back sooner. Words you nail get pushed further out.

### #desafios (Challenges)
The bot pairs two members together and gives them a scenario to act out via voice memos:
- "One of you is a waiter at a bodegón, the other wants to order food"
- "You're at the stadium arguing whether Messi or Maradona is better"
- "One of you needs directions to get to San Telmo"

You voice-memo each other back and forth in a thread. The bot listens silently the whole time, transcribing everything. After you're done (or after 10 exchanges), it posts a summary with corrections for both people, new vocab each person used, and suggestions for what to practice next.

This is great because the actual conversation between two humans costs nothing — the bot only needs to transcribe and analyze at the end.

---

## How It Adapts to You

### Five Levels

Everyone starts at a level and the bot adjusts what it shows you:

| Level | What You're Learning |
|-------|---------------------|
| **1 - Beginner** | Basic greetings, numbers, common words. Present tense voseo only. No slang yet. Simple prompts like "introduce yourself" or "order food" |
| **2 - Elementary** | Daily life vocab (food, transport). Past tense voseo. Basic slang (che, dale, boludo). Prompts like "describe your day" |
| **3 - Intermediate** | Work, emotions, opinions. All tenses + commands. Common lunfardo. Situational prompts like "at the market" or "giving directions" |
| **4 - Upper Intermediate** | Abstract concepts, idioms. Subjunctive and conditionals. Full lunfardo + vesre wordplay. Complex prompts like "debate a topic" or "tell a story" |
| **5 - Advanced** | Nuanced expression, humor. All grammar, natural flow. Deep slang and wordplay. Free-form prompts like "tell a joke" or "negotiate a deal" |

### The Bot Remembers You

The bot builds a profile of each person over time:
- What words and grammar points you've practiced
- What mistakes you tend to make repeatedly
- What topics you're interested in
- How your pronunciation is developing
- Your strengths and areas that need work

This profile gets updated regularly and is used every time the bot interacts with you, so feedback is always personalized. Someone who keeps mixing up -ar and -ir conjugations will get extra practice on those. Someone who never uses lunfardo will get encouraged to try it.

### The Bot Learns from the Group

The bot also looks at patterns across everyone:
- If 70% of the group is struggling with -ir conjugations, it emphasizes those in upcoming lessons
- If lunfardo lessons get way more voice memo responses than grammar drills, it leans more into lunfardo
- If multiple people say "more food vocab" via the feedback command, food vocabulary shows up more

---

## Commands You Can Use

| Command | What It Does |
|---------|-------------|
| `/gringo help` | Shows all available commands and explains each channel |
| `/gringo level` | View or change your current level (1-5) |
| `/conjugar hablar` | Look up the full conjugation table for any verb in the Argentinian style |
| `/vocab morfar` | Look up any word — the bot explains it with context, examples, and cultural notes |
| `/repaso` | Start a review session of words and grammar due for practice |
| `/charlar en el kiosco` | Start a roleplay conversation in a scenario |
| `/shadow` | Start a shadowing exercise — the bot plays a phrase, you repeat it, and it compares |
| `/desafio` | Get paired with another member for a conversation challenge |
| `/feedback too easy` | Tell the bot what's working or not — it uses this to improve |

---

## Shadowing Exercises

Available via `/shadow` or as part of daily lessons:

1. The bot plays a phrase at natural Argentinian speed
2. You record yourself repeating it as closely as possible
3. The bot compares your version to the original
4. You get feedback on specific pronunciation patterns — did you get the voseo right? Did you produce the "sh" sound for "ll"? Did you match the rhythm?
5. Over time, phrases get longer and faster: short phrases, then full sentences, then rapid dialogue excerpts

---

## How Feedback Works

There are several ways the bot collects feedback and improves:

- **Emoji reactions** — give a thumbs up or down on daily lessons and lunfardo posts. The bot tracks what resonates
- **`/feedback` command** — type something like `/feedback corrections feel too harsh` or `/feedback more lunfardo please` and the bot stores it
- **Post-conversation check-in** — after roleplay dialogues, the bot asks "Was this useful? Too hard?" with quick button options
- **Automatic adaptation** — the bot looks at engagement patterns (which lessons get the most responses?) and error patterns (what is everyone struggling with?) and adjusts future content

---

## Admin Controls

Admins (designated Slack users) can adjust the bot without touching any code:

| Command | What It Does |
|---------|-------------|
| `/admin curriculum` | View and reorder the lesson plan, skip topics, add new ones |
| `/admin prompt conversation` | View and edit the bot's personality and conversation style in real-time |
| `/admin level @user 3` | Manually change someone's level |
| `/admin seed food` | Add new vocabulary or phrases on a specific topic |
| `/admin schedule` | Change what time daily lessons post, enable or disable features |
| `/admin feedback` | See aggregated data — common errors across all users, feedback messages, which lessons got the most engagement |

Changes take effect immediately — no need to restart or redeploy anything.

---

## A Typical Day Using the Bot

**Morning:** You wake up and check `#daily-lesson`. Today's lesson covers ordering at a parrilla (grill restaurant). There are 4 new food-related words, a grammar point about using the imperative with vos ("pedí", "traeme"), a note about tipping culture in Buenos Aires, an audio clip of a waiter taking an order, and a prompt: "Record yourself ordering a meal at a parrilla."

You record a voice memo ordering an asado with ensalada. The bot replies: "Great use of 'traeme un asado'! Small correction: for the salad, try 'y de paso pedime una ensalada mixta' — using 'de paso' makes it sound more natural. Your voseo was solid. New word for your deck: parrillero (grill master)."

**Afternoon:** You check `#lunfardo-del-dia`. Today's word is "afanar" — to steal, but also to work hard (from Italian "affannare"). You record a voice memo: "Estuve afanando todo el día en el laburo." The bot replies: "Perfect usage and great combo with 'laburo'!"

**Evening:** You feel like practicing, so you type `/charlar en la cancha` in `#charla-libre`. The bot becomes a fellow soccer fan at the stadium. You go back and forth for 8 turns arguing about the match. At the end, the bot gives you a summary: "You used 5 new vocab words correctly. Watch the subjunctive in 'si ganáramos' — with vos it would be 'si ganáramos' (same in this case, but check other verbs). Great use of 're copado'!"

**Before bed:** You type `/repaso` and review 6 cards. You nail 4, struggle with 2 conjugations. Those 2 will come back tomorrow. The others are pushed to next week.

---

## Monthly Cost

For a group of 15 active users, the bot costs approximately **$34/month** to run:
- Voice transcription: ~$2.25/month
- AI tutor responses: ~$27/month
- Audio generation (optional): ~$4.50/month

That's roughly $2.25 per person per month.
