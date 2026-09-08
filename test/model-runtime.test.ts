import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractJson,
  loadEnvFile,
  ModelRuntime,
  resolveProviderProfile,
} from "../src/index.ts";

test("extractJson preserves model-generated LaTeX with invalid JSON escapes", () => {
  const value = extractJson(
    String.raw`{"proof":"e^X (e^X)^\dagger = I","valid":"line\nbreak"}`,
  );

  assert.equal(value.proof, String.raw`e^X (e^X)^\dagger = I`);
  assert.equal(value.valid, "line\nbreak");
});

test("extractJson skips malformed JSON-like reasoning before the final value", () => {
  const value = extractJson(
    'The reasoning mentions JSON.parse({not valid}) before the answer.\n{"answer":"ok"}',
  );

  assert.deepEqual(value, { answer: "ok" });
});

test("ModelRuntime selects the first JSON candidate matching the schema", async () => {
  const runtime = new ModelRuntime({
    profiles: {
      mock: { kind: "mock", model: "mock" },
    },
    mockResponses: {
      mock: [
        "The reasoning considered [1,2,3]. Final payload: {\"answer\":\"ok\"}",
      ],
    },
  });

  const result = await runtime.generateStructured(
    "mock",
    { messages: [{ role: "user", content: "Return JSON." }] },
    {
      type: "object",
      required: ["answer"],
      additionalProperties: false,
      properties: { answer: { type: "string" } },
    },
  );

  assert.deepEqual(result.value, { answer: "ok" });
});

test("loadEnvFile accepts whitespace around equals without exposing values", () => {
  const directory = mkdtempSync(join(tmpdir(), "rsih-env-"));
  const path = join(directory, ".env");
  writeFileSync(path, "RSIH_TEST_KEY = secret-value\n", "utf8");
  delete process.env.RSIH_TEST_KEY;

  const loaded = loadEnvFile(path);

  assert.deepEqual(loaded, ["RSIH_TEST_KEY"]);
  assert.equal(process.env.RSIH_TEST_KEY, "secret-value");
  delete process.env.RSIH_TEST_KEY;
});

test("provider profile resolves model, endpoint, and key from named env fields", () => {
  const profile = resolveProviderProfile(
    "local",
    {
      kind: "http",
      api: "openai-completions",
      provider: "local",
      model_env: "MODEL_ID",
      base_url_env: "MODEL_URL",
      api_key_env: "MODEL_KEY",
    },
    {
      MODEL_ID: "test-model",
      MODEL_URL: "http://127.0.0.1:8000/v1",
      MODEL_KEY: "test-key",
    },
  );

  assert.equal(profile.model, "test-model");
  assert.equal(profile.base_url, "http://127.0.0.1:8000/v1");
  assert.equal(profile.api_key, "test-key");
});

test("ModelRuntime calls an OpenAI-compatible Chat Completions endpoint", async () => {
  const requests = [];
  const runtime = new ModelRuntime({
    profiles: {
      local: {
        kind: "http",
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        base_url: "http://127.0.0.1:8000/v1",
        allow_unauthenticated: true,
        compat: {
          supportsStrictMode: false,
        },
      },
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          id: "chat-1",
          model: "local-model",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                reasoning: "I should inspect the requested file.",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "read",
                      arguments: '{"path":"README.md"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await runtime.generate("local", {
    system: "Use tools.",
    messages: [{ role: "user", content: "Read the README." }],
    chatTemplateKwargs: {
      enable_thinking: false,
    },
    tools: [
      {
        name: "read",
        description: "Read a file.",
        parameters: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { path: { type: "string" } },
        },
      },
    ],
  });

  assert.equal(requests[0].url, "http://127.0.0.1:8000/v1/chat/completions");
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.tools[0].function.name, "read");
  assert.deepEqual(payload.chat_template_kwargs, {
    enable_thinking: false,
  });
  assert.equal(
    Object.hasOwn(payload.tools[0].function, "strict"),
    false,
  );
  assert.equal(
    result.reasoning,
    "I should inspect the requested file.",
  );
  assert.deepEqual(result.tool_calls, [
    {
      id: "call-1",
      name: "read",
      arguments: { path: "README.md" },
    },
  ]);
  assert.deepEqual(result.usage, {
    input: 12,
    output: 4,
    total_tokens: 16,
  });
});

test("local profiles default to thinking when no template override is supplied", async () => {
  let payload;
  const runtime = new ModelRuntime({
    profiles: {
      local: {
        kind: "http",
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        base_url: "http://127.0.0.1:8000/v1",
        allow_unauthenticated: true,
      },
    },
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "4", reasoning: "2 + 2 = 4." },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  await runtime.generate("local", {
    messages: [{ role: "user", content: "What is 2 + 2?" }],
  });

  assert.deepEqual(payload.chat_template_kwargs, {
    enable_thinking: true,
  });
});

test("chat-completions profiles can pass provider-specific extra body fields", async () => {
  let payload;
  const runtime = new ModelRuntime({
    profiles: {
      dashscope: {
        kind: "http",
        api: "openai-completions",
        provider: "dashscope",
        model: "qwen3.5-35b-a3b",
        base_url: "https://example.invalid/v1",
        api_key: "test-key",
        extra_body: { enable_thinking: true },
      },
    },
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "answer",
                reasoning_content: "reasoning",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await runtime.generate("dashscope", {
    messages: [{ role: "user", content: "Answer." }],
  });

  assert.equal(payload.enable_thinking, true);
  assert.equal(result.reasoning, "reasoning");
});

test("ModelRuntime backs off sustainedly after allocation quota errors", async () => {
  let attempts = 0;
  const delays = [];
  const runtime = new ModelRuntime({
    profiles: {
      dashscope: {
        kind: "http",
        api: "openai-completions",
        provider: "dashscope",
        model: "qwen3.5-35b-a3b",
        base_url: "https://example.invalid/v1",
        api_key: "test-key",
        max_retries: 1,
        rate_limit_retry_delay_ms: 65000,
        rate_limit_retry_jitter_ratio: 0.1,
      },
    },
    delayImpl: async (milliseconds) => delays.push(milliseconds),
    randomImpl: () => 0.5,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Allocated quota exceeded, please increase your quota limit.",
            },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "recovered" },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await runtime.generate("dashscope", {
    messages: [{ role: "user", content: "Answer." }],
  });

  assert.equal(result.text, "recovered");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [68250]);
});

test("ModelRuntime honors a longer Retry-After window", async () => {
  let attempts = 0;
  const delays = [];
  const runtime = new ModelRuntime({
    profiles: {
      local: {
        kind: "http",
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        base_url: "http://127.0.0.1:8000/v1",
        allow_unauthenticated: true,
        max_retries: 1,
        rate_limit_retry_delay_ms: 1000,
        rate_limit_retry_jitter_ratio: 0,
      },
    },
    delayImpl: async (milliseconds) => delays.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "120",
          },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "recovered" },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await runtime.generate("local", {
    messages: [{ role: "user", content: "Answer." }],
  });

  assert.equal(result.text, "recovered");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [120000]);
});

test("ModelRuntime treats request timeout as terminal without retrying", async () => {
  let attempts = 0;
  const runtime = new ModelRuntime({
    profiles: {
      local: {
        kind: "http",
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        base_url: "http://127.0.0.1:8000/v1",
        allow_unauthenticated: true,
        max_retries: 2,
      },
    },
    fetchImpl: async () => {
      attempts += 1;
      const error = new Error("request exceeded its time budget");
      error.name = "TimeoutError";
      throw error;
    },
  });

  await assert.rejects(
    runtime.generate("local", {
      messages: [{ role: "user", content: "Answer." }],
      timeoutMs: 1500000,
    }),
    (error) =>
      error.code === "MODEL_REQUEST_TIMEOUT" &&
      error.timeout_ms === 1500000,
  );
  assert.equal(attempts, 1);
});

test("ModelRuntime recognizes request timeout wrapped by fetch", async () => {
  let attempts = 0;
  const runtime = new ModelRuntime({
    profiles: {
      local: {
        kind: "http",
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        base_url: "http://127.0.0.1:8000/v1",
        allow_unauthenticated: true,
        max_retries: 2,
      },
    },
    fetchImpl: async () => {
      attempts += 1;
      const timeout = new Error("request exceeded its time budget");
      timeout.name = "TimeoutError";
      throw new TypeError("fetch failed", { cause: timeout });
    },
  });

  await assert.rejects(
    runtime.generate("local", {
      messages: [{ role: "user", content: "Answer." }],
      timeoutMs: 1500000,
    }),
    (error) =>
      error.code === "MODEL_REQUEST_TIMEOUT" &&
      error.timeout_ms === 1500000,
  );
  assert.equal(attempts, 1);
});

test("ModelRuntime marks exhausted transport retries as request failure", async () => {
  let attempts = 0;
  const runtime = new ModelRuntime({
    profiles: {
      local: {
        kind: "http",
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        base_url: "http://127.0.0.1:8000/v1",
        allow_unauthenticated: true,
        max_retries: 2,
      },
    },
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    },
  });

  await assert.rejects(
    runtime.generate("local", {
      messages: [{ role: "user", content: "Answer." }],
      transportRecoveryMs: 0,
    }),
    (error) =>
      error.code === "MODEL_REQUEST_FAILED" &&
      /fetch failed/.test(error.message),
  );
  assert.equal(attempts, 3);
});

test("ModelRuntime waits for transient transport recovery", async () => {
  let attempts = 0;
  const runtime = new ModelRuntime({
    profiles: {
      local: {
        kind: "http",
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        base_url: "http://127.0.0.1:8000/v1",
        allow_unauthenticated: true,
        max_retries: 0,
      },
    },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        const socket = new Error("socket closed");
        socket.code = "UND_ERR_SOCKET";
        throw new TypeError("fetch failed", { cause: socket });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "A" },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await runtime.generate("local", {
    messages: [{ role: "user", content: "Answer." }],
    transportRecoveryMs: 1000,
    transportRetryDelayMs: 1,
  });

  assert.equal(result.text, "A");
  assert.equal(attempts, 3);
});

test("ModelRuntime compacts structured input without reducing output budget", async () => {
  const requests = [];
  const runtime = new ModelRuntime({
    profiles: {
      local: {
        kind: "http",
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        base_url: "http://127.0.0.1:8000/v1",
        allow_unauthenticated: true,
        max_retries: 2,
      },
    },
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push(payload);
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 65536 tokens. However, you requested 24576 output tokens and your prompt contains at least 54615 input tokens.",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "A" },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await runtime.generate("local", {
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          episodes: [
            {
              episode_id: "trace:1",
              trajectory: [
                { role: "user", content: "Question" },
                {
                  role: "assistant",
                  content: `start-${"x".repeat(3000)}-end`,
                },
              ],
            },
          ],
        }),
      },
    ],
    maxTokens: 24576,
  });

  assert.equal(result.text, "A");
  assert.deepEqual(
    requests.map((request) => request.max_tokens),
    [24576, 24576],
  );
  const originalInput = JSON.parse(
    requests[0].messages[0].content,
  );
  const compactedInput = JSON.parse(
    requests[1].messages[0].content,
  );
  assert.equal(compactedInput.episodes.length, 1);
  assert.ok(
    compactedInput.episodes[0].trajectory[1].content.length <
      originalInput.episodes[0].trajectory[1].content.length,
  );
  assert.match(
    compactedInput.episodes[0].trajectory[1].content,
    /^start-/,
  );
  assert.match(
    compactedInput.episodes[0].trajectory[1].content,
    /-end$/,
  );
});

test("ModelRuntime calls the OpenAI Responses endpoint and parses tool calls", async () => {
  const requests = [];
  const runtime = new ModelRuntime({
    profiles: {
      gpt: {
        kind: "http",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        base_url: "https://example.test/v1",
        api_key: "test-only-key",
      },
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(
        JSON.stringify({
          id: "response-1",
          model: "gpt-test",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-2",
              name: "list",
              arguments: '{"path":"."}',
            },
          ],
          usage: {
            input_tokens: 8,
            output_tokens: 3,
            total_tokens: 11,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await runtime.generate("gpt", {
    system: "Use tools.",
    messages: [{ role: "user", content: "List files." }],
    tools: [
      {
        name: "list",
        description: "List files.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { path: { type: "string" } },
        },
      },
    ],
  });

  assert.equal(requests[0].url, "https://example.test/v1/responses");
  assert.equal(
    requests[0].options.headers.authorization,
    "Bearer test-only-key",
  );
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.instructions, "Use tools.");
  assert.equal(payload.input[0].role, "user");
  assert.equal(payload.tools[0].name, "list");
  assert.deepEqual(result.tool_calls[0], {
    id: "call-2",
    name: "list",
    arguments: { path: "." },
  });
});

test("ModelRuntime parses and validates structured mock output", async () => {
  const runtime = new ModelRuntime({
    profiles: {
      mock: { kind: "mock", model: "mock" },
    },
    mockResponses: {
      mock: ['```json\n{"answer":"ok"}\n```'],
    },
  });

  const result = await runtime.generateStructured(
    "mock",
    {
      messages: [{ role: "user", content: "Return JSON." }],
    },
    {
      type: "object",
      required: ["answer"],
      additionalProperties: false,
      properties: {
        answer: { type: "string" },
      },
    },
  );

  assert.deepEqual(result.value, { answer: "ok" });
});

test("ModelRuntime retries malformed structured output with feedback", async () => {
  const requests = [];
  const runtime = new ModelRuntime({
    profiles: {
      mock: { kind: "mock", model: "mock" },
    },
    mockResponses: {
      mock: [
        "{invalid",
        (request) => {
          requests.push(request);
          return JSON.stringify({ answer: "ok" });
        },
      ],
    },
  });

  const result = await runtime.generateStructured(
    "mock",
    {
      messages: [{ role: "user", content: "Return the answer." }],
    },
    {
      type: "object",
      required: ["answer"],
      additionalProperties: false,
      properties: {
        answer: { type: "string" },
      },
    },
    "TestAnswer",
  );

  assert.deepEqual(result.value, { answer: "ok" });
  assert.match(
    requests[0].messages.at(-1).content,
    /prior TestAnswer was invalid/,
  );
});
