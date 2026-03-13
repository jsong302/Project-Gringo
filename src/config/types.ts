export interface SlackConfig {
  botToken: string;
  signingSecret: string;
  appToken: string;
}

export interface DbConfig {
  path: string;
}

export interface AppConfig {
  logLevel: string;
  port: number;
  adminUserIds: string[];
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface DeepgramConfig {
  apiKey: string;
}

export interface TtsConfig {
  apiKey: string;
  voice: string;
  languageCode: string;
}

export interface Config {
  slack: SlackConfig;
  db: DbConfig;
  app: AppConfig;
  anthropic?: AnthropicConfig;
  deepgram?: DeepgramConfig;
  tts?: TtsConfig;
}
