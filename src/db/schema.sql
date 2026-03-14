-- ============================================================
-- Project Gringo — Full Database Schema
-- ============================================================

-- Migration tracking
CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Users
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_user_id TEXT UNIQUE NOT NULL,
    display_name TEXT,
    level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
    xp INTEGER NOT NULL DEFAULT 0,
    streak_days INTEGER NOT NULL DEFAULT 0,
    last_practice_at TEXT,
    preferred_difficulty TEXT NOT NULL DEFAULT 'normal' CHECK (preferred_difficulty IN ('easy', 'normal', 'hard')),
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    notification_prefs TEXT NOT NULL DEFAULT '{}',
    onboarded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    response_mode TEXT NOT NULL DEFAULT 'text' CHECK (response_mode IN ('text', 'voice'))
);

-- ============================================================
-- Content tables (seeded from JSON in Phase 2)
-- ============================================================

CREATE TABLE IF NOT EXISTS vocabulary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spanish TEXT NOT NULL,
    english TEXT NOT NULL,
    category TEXT NOT NULL,
    difficulty INTEGER NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
    example_sentence TEXT,
    pronunciation_notes TEXT,
    cultural_notes TEXT,
    is_lunfardo INTEGER NOT NULL DEFAULT 0,
    etymology TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phrases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spanish TEXT NOT NULL,
    english TEXT NOT NULL,
    category TEXT NOT NULL,
    difficulty INTEGER NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
    context_notes TEXT,
    cultural_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vesre (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original TEXT NOT NULL,
    vesre_form TEXT NOT NULL,
    meaning TEXT,
    example_sentence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conjugations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    verb_infinitive TEXT NOT NULL,
    tense TEXT NOT NULL,
    mood TEXT NOT NULL DEFAULT 'indicativo',
    vos_form TEXT NOT NULL,
    tu_form TEXT,
    example_sentence TEXT,
    notes TEXT,
    UNIQUE(verb_infinitive, tense, mood)
);

-- ============================================================
-- Spaced Repetition (SM-2)
-- ============================================================

CREATE TABLE IF NOT EXISTS srs_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    card_type TEXT NOT NULL CHECK (card_type IN ('vocab', 'conjugation', 'phrase', 'vesre')),
    content_id INTEGER NOT NULL,
    ease_factor REAL NOT NULL DEFAULT 2.5,
    interval_days REAL NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    next_review_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_review_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, card_type, content_id)
);

CREATE TABLE IF NOT EXISTS review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    srs_card_id INTEGER NOT NULL REFERENCES srs_cards(id),
    quality INTEGER NOT NULL CHECK (quality BETWEEN 0 AND 5),
    response_type TEXT CHECK (response_type IN ('voice', 'text', 'button')),
    response_text TEXT,
    feedback_given TEXT,
    reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Conversations & Lessons
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    slack_channel_id TEXT NOT NULL,
    slack_thread_ts TEXT NOT NULL,
    thread_type TEXT NOT NULL CHECK (thread_type IN ('charla', 'lesson', 'review', 'desafio', 'shadow', 'dialogue')),
    scenario TEXT,
    turn_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
    partner_user_id INTEGER REFERENCES users(id),
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lesson_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_type TEXT NOT NULL CHECK (lesson_type IN ('daily', 'lunfardo', 'shadow', 'listening')),
    topic TEXT,
    content_json TEXT NOT NULL,
    slack_channel_id TEXT,
    slack_message_ts TEXT,
    posted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lesson_engagement (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_log_id INTEGER NOT NULL REFERENCES lesson_log(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    engagement_type TEXT NOT NULL CHECK (engagement_type IN ('voice_response', 'text_response', 'reaction')),
    reaction_emoji TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- User tracking
-- ============================================================

CREATE TABLE IF NOT EXISTS user_vocab_encounters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    vocabulary_id INTEGER NOT NULL REFERENCES vocabulary(id),
    encounter_type TEXT NOT NULL CHECK (encounter_type IN ('lesson', 'charla', 'review', 'lookup')),
    context TEXT,
    encountered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learning_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    error_category TEXT NOT NULL CHECK (error_category IN ('grammar', 'vocab', 'conjugation', 'pronunciation', 'syntax', 'other')),
    description TEXT NOT NULL,
    user_said TEXT,
    correction TEXT,
    source TEXT CHECK (source IN ('voice', 'text', 'review')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    error_code TEXT NOT NULL,
    message TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    trace_id TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    profile_summary TEXT NOT NULL,
    strengths TEXT,
    weaknesses TEXT,
    interests TEXT,
    pronunciation_notes TEXT,
    interaction_count_at_generation INTEGER NOT NULL DEFAULT 0,
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id)
);

-- ============================================================
-- Admin & Feedback
-- ============================================================

CREATE TABLE IF NOT EXISTS system_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    prompt_text TEXT NOT NULL,
    description TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    feedback_type TEXT NOT NULL CHECK (feedback_type IN ('command', 'reaction', 'post_charla')),
    message TEXT,
    reaction_emoji TEXT,
    target_message_ts TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- System Settings (key-value config, admin-editable)
-- ============================================================

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    description TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Conversation Messages (thread history for LLM context)
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversation_threads(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    message_ts TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Learner Facts (discrete observations, Mem0-style)
-- ============================================================

CREATE TABLE IF NOT EXISTS learner_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    category TEXT NOT NULL CHECK (category IN ('error_pattern', 'strength', 'interest', 'preference', 'knowledge_gap', 'pronunciation', 'other')),
    fact TEXT NOT NULL,
    source TEXT CHECK (source IN ('tool', 'pronunciation', 'review', 'onboarding', 'system')),
    superseded_by INTEGER REFERENCES learner_facts(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Review Sessions (persisted SRS sessions)
-- ============================================================

CREATE TABLE IF NOT EXISTS review_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    conversation_id INTEGER REFERENCES conversation_threads(id),
    cards_json TEXT NOT NULL,
    current_index INTEGER NOT NULL DEFAULT 0,
    results_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Lesson Plans (personalized curriculum per user)
-- ============================================================

CREATE TABLE IF NOT EXISTS lesson_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    topic_order INTEGER NOT NULL,
    topic TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'skipped')),
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, topic_order)
);

-- ============================================================
-- Shared Curriculum
-- ============================================================

CREATE TABLE IF NOT EXISTS curriculum_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_order INTEGER NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    level_band INTEGER NOT NULL CHECK (level_band BETWEEN 1 AND 5),
    lesson_prompt TEXT,
    exercise_prompt TEXT,
    pass_threshold INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_curriculum_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    unit_id INTEGER NOT NULL REFERENCES curriculum_units(id),
    status TEXT NOT NULL DEFAULT 'locked'
        CHECK (status IN ('locked', 'active', 'practicing', 'passed', 'skipped')),
    best_score INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    lesson_text TEXT,
    exercise_text TEXT,
    started_at TEXT,
    passed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, unit_id)
);

CREATE TABLE IF NOT EXISTS placement_tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    questions_json TEXT NOT NULL,
    results_json TEXT NOT NULL,
    placed_at_unit INTEGER NOT NULL REFERENCES curriculum_units(id),
    derived_level INTEGER NOT NULL CHECK (derived_level BETWEEN 1 AND 5),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Home Tab Sessions (persisted state for App Home tab)
-- ============================================================

CREATE TABLE IF NOT EXISTS home_sessions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    slack_user_id TEXT NOT NULL,
    state_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Admin Audit Log (tracks admin tool invocations)
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_slack_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    before_snapshot TEXT,
    after_snapshot TEXT,
    input_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_users_slack_id ON users(slack_user_id);
CREATE INDEX IF NOT EXISTS idx_srs_cards_user_review ON srs_cards(user_id, next_review_at);
CREATE INDEX IF NOT EXISTS idx_srs_cards_type ON srs_cards(card_type, content_id);
CREATE INDEX IF NOT EXISTS idx_review_log_user ON review_log(user_id, reviewed_at);
CREATE INDEX IF NOT EXISTS idx_conversation_threads_slack ON conversation_threads(slack_channel_id, slack_thread_ts);
CREATE INDEX IF NOT EXISTS idx_learning_errors_user ON learning_errors(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_system_errors_code ON system_errors(error_code, created_at);
CREATE INDEX IF NOT EXISTS idx_user_vocab_encounters_user ON user_vocab_encounters(user_id, vocabulary_id);
CREATE INDEX IF NOT EXISTS idx_lesson_engagement_lesson ON lesson_engagement(lesson_log_id);
CREATE INDEX IF NOT EXISTS idx_vocabulary_category ON vocabulary(category, difficulty);
CREATE INDEX IF NOT EXISTS idx_conjugations_verb ON conjugations(verb_infinitive);
CREATE INDEX IF NOT EXISTS idx_phrases_category ON phrases(category, difficulty);
CREATE INDEX IF NOT EXISTS idx_conv_messages_conv ON conversation_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_learner_facts_user ON learner_facts(user_id, category);
CREATE INDEX IF NOT EXISTS idx_review_sessions_user ON review_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_lesson_plans_user ON lesson_plans(user_id, status);
CREATE TABLE IF NOT EXISTS lesson_bank (
    unit_id INTEGER PRIMARY KEY REFERENCES curriculum_units(id),
    lesson_text TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Exit Exam Question Bank
-- ============================================================

CREATE TABLE IF NOT EXISTS exit_exam_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level_band INTEGER NOT NULL CHECK (level_band BETWEEN 1 AND 4),
    source_unit_id INTEGER REFERENCES curriculum_units(id),
    question_type TEXT NOT NULL CHECK (question_type IN ('mc', 'fill_blank', 'translation')),
    question_text TEXT NOT NULL,
    options_json TEXT,
    correct_index INTEGER,
    answers_json TEXT,
    translation_direction TEXT CHECK (translation_direction IN ('en_to_es', 'es_to_en')),
    reference_answer TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS exit_exam_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    level_band INTEGER NOT NULL,
    questions_json TEXT NOT NULL,
    total_correct INTEGER NOT NULL,
    total_questions INTEGER NOT NULL,
    passed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_exit_exam_questions_level ON exit_exam_questions(level_band, status);
CREATE INDEX IF NOT EXISTS idx_exit_exam_attempts_user ON exit_exam_attempts(user_id, level_band);

CREATE INDEX IF NOT EXISTS idx_audit_log_admin ON admin_audit_log(admin_slack_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_tool ON admin_audit_log(tool_name, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON admin_audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_curriculum_units_order ON curriculum_units(unit_order);
CREATE INDEX IF NOT EXISTS idx_user_curriculum_user ON user_curriculum_progress(user_id, status);
CREATE INDEX IF NOT EXISTS idx_placement_tests_user ON placement_tests(user_id);
