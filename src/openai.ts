import OpenAI from 'openai';
import { config } from './config.js';

/**
 * One request against the Responses API, streamed, returning parsed JSON.
 *
 * This is the whole of what the call needs from the source's OpenAiResponsesClient
 * (`createJsonStream`), and it is deliberately the whole of what is ported.
 * Left behind, on purpose:
 *
 * - the opossum circuit breaker and the retry loop. Both exist to ride out a
 *   flaky vendor over a request whose caller can wait; the caller here is a phone
 *   webhook with a single-digit-second budget and a caller listening to silence,
 *   so a second attempt would blow the deadline rather than rescue it.
 * - `buildJsonInput`, which always returns `input.prompt` on this path (no
 *   document, no image).
 * - `resolveTemperature`, which always returns undefined (the conversation never
 *   sets one).
 * - `ensureAdditionalPropertiesFalse`, a provable no-op here: the reply schema
 *   already declares `additionalProperties: false`, lists all six properties as
 *   required, and nests no objects.
 *
 * `resolveReasoning` below is NOT dead and must stay.
 */

export type OpenAiReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Which models take a `reasoning` block.
 *
 * Sending `reasoning.effort` to a model that does not reason is a 400
 * (`unsupported_parameter`), so this is what lets the model be pinned to
 * anything without the call breaking.
 */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

function resolveReasoning(
  model: string,
  effort?: OpenAiReasoningEffort,
): { effort: OpenAiReasoningEffort } | undefined {
  return effort && isReasoningModel(model) ? { effort } : undefined;
}

export interface JsonStreamRequest {
  /** Called with the whole buffer so far, on every delta, inside the read loop. */
  onPartialText?: (buffer: string) => void;
  instructions: string;
  prompt: string;
  schemaName: string;
  schemaDescription?: string;
  schema: Record<string, unknown>;
  model?: string;
  reasoningEffort?: OpenAiReasoningEffort;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface JsonStreamResponse<TValue> {
  json: TValue;
  model: string | null;
  responseId: string;
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY is not set');
  if (!client) {
    client = new OpenAI({
      apiKey: config.openai.apiKey,
      ...(config.openai.baseUrl ? { baseURL: config.openai.baseUrl } : {}),
      /*
       * Explicitly zero, matching the source.
       *
       * The SDK's own default is 2. Left alone, a rate-limited turn quietly
       * becomes three sequential attempts, which blows Twilio's ~15 second
       * webhook window and makes the caller hear "an application error has
       * occurred" instead of a sentence. The deadline in the conversation
       * service is the only retry policy this path gets.
       */
      maxRetries: 0,
      timeout: config.openai.timeoutMs,
    });
  }
  return client;
}

export function isOpenAiConfigured(): boolean {
  return Boolean(config.openai.apiKey);
}

export function defaultModel(): string {
  return config.openai.responsesModel;
}

export async function createJsonStream<TValue = unknown>(
  input: JsonStreamRequest,
): Promise<JsonStreamResponse<TValue>> {
  const model = input.model?.trim() || config.openai.responsesModel;

  /*
   * A real abort, not just a race.
   *
   * The source's `withDeadline` stops WAITING for a slow turn but cannot stop
   * the request, so an abandoned turn holds its socket open for the client's
   * full timeout. Since this wrapper is new, the deadline is wired to the SDK's
   * signal and the request actually ends.
   */
  const controller = new AbortController();
  const deadline = input.timeoutMs
    ? setTimeout(() => controller.abort(), input.timeoutMs)
    : undefined;

  let buffer = '';
  let responseId = '';
  let responseModel: string | null = null;

  try {
    // `stream: true` is inlined rather than hoisted into a variable: the
    // overload is keyed on the literal type, and a widened `boolean` silently
    // selects the non-streaming overload.
    const stream = await getClient().responses.create(
      {
        model,
        input: input.prompt,
        instructions: input.instructions,
        max_output_tokens: input.maxOutputTokens,
        reasoning: resolveReasoning(model, input.reasoningEffort),
        stream: true,
        text: {
          format: {
            type: 'json_schema' as const,
            name: input.schemaName,
            description: input.schemaDescription,
            schema: input.schema,
            strict: true,
          },
        },
      } as never,
      { signal: controller.signal, timeout: input.timeoutMs ?? config.openai.timeoutMs },
    );

    for await (const event of stream as unknown as AsyncIterable<{
      type?: string;
      delta?: string;
      response?: { id?: string; model?: string; output_text?: string };
    }>) {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        buffer += event.delta;
        // Inside the read loop on purpose: the whole point is that the caller
        // hears about `say` the instant it lands, not one tick later.
        input.onPartialText?.(buffer);
      } else if (event.response) {
        responseId = event.response.id ?? responseId;
        responseModel = event.response.model ?? responseModel;
        if (!buffer && event.response.output_text) buffer = event.response.output_text;
      }
    }
  } finally {
    if (deadline) clearTimeout(deadline);
  }

  try {
    return { json: JSON.parse(buffer) as TValue, model: responseModel ?? model, responseId };
  } catch (error) {
    throw new Error(
      `OpenAI JSON response could not be parsed (${(error as Error).message}): ` +
        buffer.slice(0, 300),
    );
  }
}
