import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicConfig } from '../config/types';
import { GringoError } from '../errors/gringoError';
import { getTraceId } from '../observability/context';
import { log } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { withTimeout, TimeoutError } from '../utils/timeout';

const llmLog = log.withScope('llm');

let client: Anthropic | null = null;
let defaultModel = 'claude-haiku-4-5-20251001';
let defaultMaxTokens = 1024;

const LLM_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

// ── Types ───────────────────────────────────────────────────

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | Anthropic.Messages.ContentBlockParam[];
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  model?: string;
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string | null;
}

// ── Tool-use types ──────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface LlmToolRequest {
  system?: string;
  messages: LlmMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  model?: string;
  temperature?: number;
}

export interface LlmToolResponse {
  content: Anthropic.Messages.ContentBlock[];
  text: string;
  toolUses: ToolUseBlock[];
  inputTokens: number;
  outputTokens: number;
  model: string;
  stopReason: string | null;
}

// ── Init / Client ───────────────────────────────────────────

export function initLlm(config: AnthropicConfig): void {
  client = new Anthropic({ apiKey: config.apiKey });
  defaultModel = config.model;
  defaultMaxTokens = config.maxTokens;
  llmLog.info(`LLM initialized — model: ${config.model}, maxTokens: ${config.maxTokens}`);
}

function getClient(): Anthropic {
  if (!client) {
    throw new GringoError({
      message: 'LLM client not initialized. Call initLlm() first or set ANTHROPIC_API_KEY.',
      code: 'ERR_LLM_RESPONSE',
    });
  }
  return client;
}

/** @internal — test-only hook to inject a mock client */
export function _setClient(mock: Anthropic | null): void {
  client = mock;
}

/** @internal — test-only hook to reset defaults */
export function _setDefaults(model: string, maxTokens: number): void {
  defaultModel = model;
  defaultMaxTokens = maxTokens;
}

// ── Response parsing (exported for testing) ─────────────────

export function extractTextFromResponse(
  content: Anthropic.Messages.ContentBlock[],
): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// ── Error classification (exported for testing) ─────────────

export function isRetryableError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  return false;
}

export function classifyLlmError(
  err: unknown,
  meta: { model: string; attempt: number; traceId?: string },
): GringoError {
  if (err instanceof GringoError) return err;

  if (err instanceof TimeoutError) {
    return new GringoError({
      message: err.message,
      code: 'ERR_LLM_TIMEOUT',
      cause: err,
      trace_id: meta.traceId,
      metadata: { model: meta.model, attempt: meta.attempt },
    });
  }

  if (err instanceof Anthropic.RateLimitError) {
    return new GringoError({
      message: 'LLM rate limit exceeded',
      code: 'ERR_LLM_RATE_LIMIT',
      cause: err,
      trace_id: meta.traceId,
      metadata: { model: meta.model, attempt: meta.attempt },
    });
  }

  return new GringoError({
    message: `LLM request failed: ${err instanceof Error ? err.message : String(err)}`,
    code: 'ERR_LLM_RESPONSE',
    cause: err,
    trace_id: meta.traceId,
    metadata: { model: meta.model, attempt: meta.attempt },
  });
}

// ── Main call ───────────────────────────────────────────────

export async function callLlm(request: LlmRequest): Promise<LlmResponse> {
  const anthropic = getClient();
  const traceId = getTraceId();
  const model = request.model ?? defaultModel;
  const maxTokens = request.maxTokens ?? defaultMaxTokens;

  let attempt = 0;

  try {
    return await withRetry(
      async () => {
        attempt++;

        const response = await withTimeout(
          anthropic.messages.create({
            model,
            max_tokens: maxTokens,
            temperature: request.temperature ?? 0.7,
            system: request.system ?? undefined,
            messages: request.messages,
          }),
          LLM_TIMEOUT_MS,
        );

        const text = extractTextFromResponse(response.content);

        if (!text) {
          throw new GringoError({
            message: 'LLM returned empty response',
            code: 'ERR_LLM_RESPONSE',
            metadata: { model, stopReason: response.stop_reason },
            trace_id: traceId,
          });
        }

        llmLog.debug(
          `LLM call OK — ${response.usage.input_tokens}in/${response.usage.output_tokens}out`,
          { model, traceId },
        );

        return {
          text,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          model: response.model,
          stopReason: response.stop_reason,
        };
      },
      {
        maxAttempts: MAX_RETRIES,
        delayMs: RETRY_DELAY_MS,
        isRetryable: isRetryableError,
        label: 'LLM',
      },
    );
  } catch (err) {
    throw classifyLlmError(err, { model, attempt, traceId });
  }
}

// ── Tool-use call ───────────────────────────────────────────

export function extractToolUses(
  content: Anthropic.Messages.ContentBlock[],
): ToolUseBlock[] {
  return content
    .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({
      type: 'tool_use' as const,
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    }));
}

export async function callLlmWithTools(request: LlmToolRequest): Promise<LlmToolResponse> {
  const anthropic = getClient();
  const traceId = getTraceId();
  const model = request.model ?? defaultModel;
  const maxTokens = request.maxTokens ?? defaultMaxTokens;

  let attempt = 0;

  try {
    return await withRetry(
      async () => {
        attempt++;

        const response = await withTimeout(
          anthropic.messages.create({
            model,
            max_tokens: maxTokens,
            temperature: request.temperature ?? 0.3,
            system: request.system ?? undefined,
            messages: request.messages as Anthropic.Messages.MessageParam[],
            tools: request.tools as Anthropic.Messages.Tool[],
          }),
          LLM_TIMEOUT_MS * 2, // Tool calls may need more time
        );

        const text = extractTextFromResponse(response.content);
        const toolUses = extractToolUses(response.content);

        llmLog.debug(
          `LLM tool call OK — ${response.usage.input_tokens}in/${response.usage.output_tokens}out, ${toolUses.length} tool use(s)`,
          { model, traceId, stopReason: response.stop_reason },
        );

        return {
          content: response.content,
          text,
          toolUses,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          model: response.model,
          stopReason: response.stop_reason,
        };
      },
      {
        maxAttempts: MAX_RETRIES,
        delayMs: RETRY_DELAY_MS,
        isRetryable: isRetryableError,
        label: 'LLM-tools',
      },
    );
  } catch (err) {
    throw classifyLlmError(err, { model, attempt, traceId });
  }
}
