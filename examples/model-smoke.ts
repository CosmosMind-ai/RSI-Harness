import { existsSync } from "node:fs";
import {
  loadEnvFile,
  loadProviderProfiles,
  ModelRuntime,
} from "../src/index.ts";

const configPath = process.argv[2] ?? "config/providers.json";
const profileId = process.argv[3] ?? "gpt";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

if (!existsSync(configPath)) {
  throw new Error(
    `Missing ${configPath}. Copy config/providers.example.json and set the model environment variables first.`,
  );
}

const runtime = new ModelRuntime({
  profiles: loadProviderProfiles(configPath),
});
const response = await runtime.generate(profileId, {
  system: "Return a concise confirmation.",
  messages: [
    {
      role: "user",
      content: "Reply with: RSiH model runtime is connected.",
    },
  ],
  maxTokens: 64,
  temperature: 0,
});

console.log(
  JSON.stringify(
    {
      profile: profileId,
      provider: response.provider,
      model: response.model,
      stop_reason: response.stop_reason,
      text: response.text,
      usage: response.usage,
    },
    null,
    2,
  ),
);
