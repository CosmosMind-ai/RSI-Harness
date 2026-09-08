import { setTimeout as delay } from "node:timers/promises";
import { extractJsonCandidates } from "../core/json.ts";
import { assertJsonSchema } from "../core/schema.ts";

function joinEndpoint(baseUrl, endpoint) {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  if (normalizedBase.endsWith(`/${endpoint}`)) return normalizedBase;
  return `${normalizedBase}/${endpoint}`;
}

function parseArguments(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: String(value) };
  }
}

function normalizeTools(tools = []) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    strict: tool.strict !== false,
  }));
}

function toChatTools(tools, profile) {
  return normalizeTools(tools).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(profile.compat?.supportsStrictMode === false
        ? {}
        : { strict: tool.strict }),
    },
  }));
}

function toChatMessages(system, messages = []) {
  const output = [];
  if (system) output.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "tool") {
      output.push({
        role: "tool",
        tool_call_id: message.tool_call_id,
        content: String(message.content ?? ""),
      });
      continue;
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      output.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: message.tool_calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
          },
        })),
      });
      continue;
    }

    output.push({
      role: message.role,
      content: String(message.content ?? ""),
    });
  }

  return output;
}

function toResponsesInput(messages = []) {
  const input = [];

  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: String(message.content ?? ""),
      });
      continue;
    }

    if (message.role === "assistant" && message.content) {
      input.push({ role: "assistant", content: message.content });
    } else if (
      message.role === "user" ||
      message.role === "system" ||
      message.role === "developer"
    ) {
      input.push({
        role: message.role,
        content: String(message.content ?? ""),
      });
    }

    for (const call of message.tool_calls ?? []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments ?? {}),
      });
    }
  }

  return input;
}

function parseChatResponse(body, profile) {
  const choice = body.choices?.[0];
  if (!choice?.message) {
    throw new Error("Chat Completions response did not contain a message.");
  }

  const message = choice.message;
  return {
    text: message.content ?? "",
    reasoning:
      message.reasoning ??
      message.reasoning_content ??
      "",
    tool_calls: (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function?.name,
      arguments: parseArguments(call.function?.arguments),
    })),
    usage: {
      input: body.usage?.prompt_tokens ?? 0,
      output: body.usage?.completion_tokens ?? 0,
      total_tokens: body.usage?.total_tokens ?? 0,
    },
    stop_reason: choice.finish_reason ?? "stop",
    model: body.model ?? profile.model,
    provider: profile.provider,
    response_id: body.id,
  };
}

function parseResponsesResponse(body, profile) {
  const text = [];
  const toolCalls = [];

  for (const item of body.output ?? []) {
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id,
        name: item.name,
        arguments: parseArguments(item.arguments),
      });
      continue;
    }

    if (item.type === "message") {
      for (const content of item.content ?? []) {
        if (content.type === "output_text" && content.text) {
          text.push(content.text);
        }
      }
    }
  }

  return {
    text: body.output_text ?? text.join(""),
    tool_calls: toolCalls,
    usage: {
      input: body.usage?.input_tokens ?? 0,
      output: body.usage?.output_tokens ?? 0,
      total_tokens: body.usage?.total_tokens ?? 0,
    },
    stop_reason:
      toolCalls.length > 0
        ? "tool_use"
        : body.status === "incomplete"
          ? "length"
          : "stop",
    model: body.model ?? profile.model,
    provider: profile.provider,
    response_id: body.id,
  };
}

function buildHeaders(profile) {
  const headers = {
    "content-type": "application/json",
    ...(profile.headers ?? {}),
  };
  if (profile.api_key) {
    headers.authorization = `Bearer ${profile.api_key}`;
  } else if (!profile.allow_unauthenticated) {
    throw new Error(
      `Provider profile "${profile.id}" has no resolved API key.`,
    );
  }
  return headers;
}

function isRequestTimeout(error) {
  for (let current = error; current; current = current.cause) {
    if (
      current.name === "TimeoutError" ||
      (current.name === "AbortError" &&
        /timeout|timed out/i.test(current.message ?? ""))
    ) {
      return true;
    }
  }
  return false;
}

function isTransportFailure(error) {
  for (let current = error; current; current = current.cause) {
    if (
      [
        "ECONNREFUSED",
        "ECONNRESET",
        "EPIPE",
        "ENOTFOUND",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(current.code) ||
      (current.name === "TypeError" &&
        /fetch failed|socket|connection|terminated/i.test(
          current.message ?? "",
        ))
    ) {
      return true;
    }
  }
  return false;
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function rateLimitDelayMs(response, baseDelayMs, jitterRatio, random) {
  const retryAfterMs = parseRetryAfterMs(
    response.headers.get("retry-after"),
  );
  const minimumDelayMs = Math.max(baseDelayMs, retryAfterMs ?? 0);
  return Math.round(
    minimumDelayMs + minimumDelayMs * jitterRatio * random(),
  );
}

function modelRequestTimeoutError(timeoutMs, cause) {
  const error = new Error(
    `Model request timed out after ${timeoutMs} ms.`,
    { cause },
  );
  error.code = "MODEL_REQUEST_TIMEOUT";
  error.timeout_ms = timeoutMs;
  return error;
}

function modelRequestFailedError(attempts, cause) {
  const error = new Error(
    `Model request failed after ${attempts} attempt(s): ${cause?.message ?? "unknown error"}`,
    { cause },
  );
  error.code = "MODEL_REQUEST_FAILED";
  return error;
}

function isContextLengthError(message) {
  return (
    /maximum context length/i.test(message) ||
    /context length.*exceed/i.test(message)
  );
}

function compactInputText(text) {
  const targetLength = Math.max(256, Math.floor((text.length * 2) / 3));
  if (targetLength >= text.length) return text;
  const marker =
    `\n\n[... ${text.length - targetLength} input characters omitted to fit model context ...]\n\n`;
  const retainedLength = targetLength - marker.length;
  if (retainedLength <= 1) return text.slice(0, targetLength);
  const headLength = Math.floor(retainedLength / 2);
  return [
    text.slice(0, headLength),
    marker,
    text.slice(-(retainedLength - headLength)),
  ].join("");
}

function compactAssistantTrajectory(value) {
  let changed = false;

  const visit = (current) => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== "object") return;
    if (
      current.role === "assistant" &&
      typeof current.content === "string" &&
      current.content.length > 256
    ) {
      current.content = compactInputText(current.content);
      changed = true;
    }
    for (const [key, item] of Object.entries(current)) {
      if (key === "content" && current.role === "assistant") continue;
      visit(item);
    }
  };

  visit(value);
  return changed;
}

function trimPayloadInput(payload) {
  if (!Array.isArray(payload.messages)) return false;
  for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
    const message = payload.messages[index];
    if (typeof message?.content !== "string") continue;
    let value;
    try {
      value = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!compactAssistantTrajectory(value)) continue;
    message.content = JSON.stringify(value);
    return true;
  }
  return false;
}

function assertHttpProfile(profile) {
  for (const field of ["api", "provider", "model", "base_url"]) {
    if (!profile[field]) {
      throw new Error(
        `Provider profile "${profile.id}" is missing required field "${field}".`,
      );
    }
  }
  if (!["openai-responses", "openai-completions"].includes(profile.api)) {
    throw new Error(
      `Provider profile "${profile.id}" uses unsupported API "${profile.api}".`,
    );
  }
}

export class ModelRuntime {
  constructor({
    profiles = {},
    mockResponses = {},
    fetchImpl = fetch,
    delayImpl = delay,
    randomImpl = Math.random,
  } = {}) {
    this.profiles = new Map(Object.entries(profiles));
    this.mockResponses = new Map(
      Object.entries(mockResponses).map(([id, responses]) => [
        id,
        [...responses],
      ]),
    );
    this.fetchImpl = fetchImpl;
    this.delayImpl = delayImpl;
    this.randomImpl = randomImpl;
  }

  getProfile(profileId) {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`Unknown model profile "${profileId}".`);
    }
    return { id: profileId, ...profile };
  }

  capabilities(profileId) {
    return {
      tools: false,
      structured_output: false,
      streaming: false,
      reasoning: false,
      images: false,
      usage: false,
      ...(this.getProfile(profileId).capabilities ?? {}),
    };
  }

  async generate(profileId, request) {
    const profile = this.getProfile(profileId);
    if (profile.kind === "mock") {
      return this.#generateMock(profileId, request);
    }

    assertHttpProfile(profile);
    const tools = normalizeTools(request.tools);
    const isResponses = profile.api === "openai-responses";
    const chatTemplateKwargs =
      request.chatTemplateKwargs ??
      profile.chat_template_kwargs ??
      (profile.provider === "local"
        ? { enable_thinking: true }
        : undefined);
    const extraBody = request.extraBody ?? profile.extra_body ?? {};
    const endpoint = joinEndpoint(
      profile.base_url,
      isResponses ? "responses" : "chat/completions",
    );
    const payload = isResponses
      ? {
          model: profile.model,
          instructions: request.system,
          input: toResponsesInput(request.messages),
          tools: tools.length
            ? tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: tool.strict,
              }))
            : undefined,
          max_output_tokens: request.maxTokens ?? profile.max_tokens,
          temperature: request.temperature,
          store: false,
          metadata: request.metadata,
        }
      : {
          ...extraBody,
          model: profile.model,
          messages: toChatMessages(request.system, request.messages),
          tools: tools.length ? toChatTools(tools, profile) : undefined,
          max_tokens: request.maxTokens ?? profile.max_tokens,
          temperature: request.temperature,
          thinking: request.thinking ?? profile.thinking,
          chat_template_kwargs: chatTemplateKwargs,
          stream: false,
        };

    const body = await this.#postJson(profile, endpoint, payload, request);
    return isResponses
      ? parseResponsesResponse(body, profile)
      : parseChatResponse(body, profile);
  }

  async *stream(profileId, request) {
    const response = await this.generate(profileId, request);
    if (response.reasoning) {
      yield {
        type: "reasoning_delta",
        delta: response.reasoning,
      };
    }
    if (response.text) {
      yield { type: "text_delta", delta: response.text };
    }
    yield { type: "done", response };
  }

  async generateStructured(profileId, request, schema, label = "model output") {
    const maxRetries = Math.max(
      0,
      Number(request.maxStructuredRetries ?? 2),
    );
    const system = [
      request.system,
      "Return exactly one JSON value. Do not include Markdown or commentary.",
      `JSON Schema:\n${JSON.stringify(schema)}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const baseMessages = [...(request.messages ?? [])];
    let messages = baseMessages;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await this.generate(profileId, {
        ...request,
        system,
        messages,
      });
      try {
        let lastSchemaError = null;
        for (const value of extractJsonCandidates(response.text)) {
          try {
            assertJsonSchema(value, schema, label);
            return {
              value,
              response,
            };
          } catch (error) {
            lastSchemaError ??= error;
          }
        }
        if (lastSchemaError) throw lastSchemaError;
        throw new Error("Model response did not contain a matching JSON value.");
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) break;
        messages = [
          ...baseMessages,
          {
            role: "user",
            content: [
              `The prior ${label} was invalid: ${error.message}`,
              "Return one corrected JSON value matching the schema exactly.",
              "Do not repeat commentary or Markdown.",
            ].join("\n"),
          },
        ];
      }
    }

    throw new Error(
      `${label} remained invalid after ${maxRetries + 1} attempt(s): ${lastError?.message ?? "unknown validation error"}`,
      { cause: lastError },
    );
  }

  async #postJson(profile, endpoint, payload, request) {
    const maxRetries = Math.max(
      0,
      Number(request.maxRetries ?? profile.max_retries ?? 2),
    );
    const timeoutMs = Number(
      request.timeoutMs ?? profile.timeout_ms ?? 600000,
    );
    const transportRecoveryMs = Math.max(
      0,
      Number(
        request.transportRecoveryMs ??
          profile.transport_recovery_ms ??
          900000,
      ),
    );
    const transportRetryDelayMs = Math.max(
      1,
      Number(
        request.transportRetryDelayMs ??
          profile.transport_retry_delay_ms ??
          1000,
      ),
    );
    const rateLimitRetryDelayMs = Math.max(
      0,
      Number(
        request.rateLimitRetryDelayMs ??
          profile.rate_limit_retry_delay_ms ??
          60000,
      ),
    );
    const rateLimitRetryJitterRatio = Math.max(
      0,
      Number(
        request.rateLimitRetryJitterRatio ??
          profile.rate_limit_retry_jitter_ratio ??
          0.1,
      ),
    );
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let retryDelayMs = Math.min(1000, 100 * 2 ** attempt);
      try {
        const { response, body } =
          await this.#fetchJsonWithTransportRecovery({
            profile,
            endpoint,
            payload,
            timeoutMs,
            maxRetries,
            transportRecoveryMs,
            transportRetryDelayMs,
            signal: request.signal,
          });

        if (response.ok) return body;

        const message =
          body.error?.message ??
          body.message ??
          `HTTP ${response.status} from model provider`;
        const contextInputReduced =
          response.status === 400 &&
          isContextLengthError(message) &&
          trimPayloadInput(payload);
        const retryable =
          contextInputReduced ||
          [408, 409, 429].includes(response.status) ||
          response.status >= 500;
        if (!retryable || attempt === maxRetries) {
          throw new Error(message);
        }
        if (response.status === 429) {
          retryDelayMs = rateLimitDelayMs(
            response,
            rateLimitRetryDelayMs,
            rateLimitRetryJitterRatio,
            this.randomImpl,
          );
        }
        lastError = new Error(message);
      } catch (error) {
        lastError = error;
        if (request.signal?.aborted) throw error;
        if (
          error?.code === "MODEL_REQUEST_TIMEOUT" ||
          error?.code === "MODEL_REQUEST_FAILED"
        ) {
          throw error;
        }
        if (isRequestTimeout(error)) {
          throw modelRequestTimeoutError(timeoutMs, error);
        }
        if (attempt === maxRetries) break;
      }

      await this.delayImpl(
        retryDelayMs,
        undefined,
        request.signal ? { signal: request.signal } : undefined,
      );
    }

    throw modelRequestFailedError(maxRetries + 1, lastError);
  }

  async #fetchJsonWithTransportRecovery({
    profile,
    endpoint,
    payload,
    timeoutMs,
    maxRetries,
    transportRecoveryMs,
    transportRetryDelayMs,
    signal,
  }) {
    let quickAttempts = 0;
    const recoveryStartedAt = Date.now();

    while (true) {
      try {
        if (signal?.aborted) throw signal.reason;
        const response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: buildHeaders(profile),
          body: JSON.stringify(payload),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        return {
          response,
          body: text ? JSON.parse(text) : {},
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (isRequestTimeout(error)) {
          throw modelRequestTimeoutError(timeoutMs, error);
        }
        if (!isTransportFailure(error)) throw error;
        if (quickAttempts < maxRetries) {
          await delay(
            Math.min(1000, 100 * 2 ** quickAttempts),
            undefined,
            signal ? { signal } : undefined,
          );
          quickAttempts += 1;
          continue;
        }
        if (Date.now() - recoveryStartedAt >= transportRecoveryMs) {
          throw modelRequestFailedError(quickAttempts + 1, error);
        }
        const recoveryAttempt = quickAttempts - maxRetries + 1;
        await delay(
          Math.min(
            15000,
            transportRetryDelayMs *
              2 ** Math.min(4, recoveryAttempt - 1),
          ),
          undefined,
          signal ? { signal } : undefined,
        );
        quickAttempts += 1;
      }
    }
  }

  async #generateMock(profileId, request) {
    const queue = this.mockResponses.get(profileId) ?? [];
    if (queue.length === 0) {
      throw new Error(`Mock profile "${profileId}" has no queued response.`);
    }
    const next = queue.shift();
    this.mockResponses.set(profileId, queue);
    const produced =
      typeof next === "function" ? await next(request) : next;
    const normalized =
      produced && typeof produced === "object"
        ? produced
        : { text: String(produced) };

    return {
      text: normalized.text ?? "",
      reasoning: normalized.reasoning ?? "",
      tool_calls: normalized.tool_calls ?? [],
      usage: normalized.usage ?? {
        input: 0,
        output: 0,
        total_tokens: 0,
      },
      stop_reason:
        normalized.stop_reason ??
        (normalized.tool_calls?.length ? "tool_use" : "stop"),
      model: normalized.model ?? this.getProfile(profileId).model ?? "mock",
      provider: "mock",
      response_id: normalized.response_id ?? null,
    };
  }
}
