import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadEnvFile(path = ".env", options = {}) {
  const absolutePath = resolve(path);
  const text = readFileSync(absolutePath, "utf8");
  const loaded = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (!options.override && process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded.push(key);
  }

  return loaded;
}

function resolveProfileValue(profile, field, envField, environment) {
  if (profile[field] !== undefined) return profile[field];
  const variable = profile[envField];
  if (!variable) return undefined;
  return environment[variable];
}

export function resolveProviderProfile(id, profile, environment = process.env) {
  const resolved = {
    ...profile,
    id,
    model: resolveProfileValue(profile, "model", "model_env", environment),
    base_url: resolveProfileValue(
      profile,
      "base_url",
      "base_url_env",
      environment,
    ),
    api_key: resolveProfileValue(
      profile,
      "api_key",
      "api_key_env",
      environment,
    ),
  };

  delete resolved.model_env;
  delete resolved.base_url_env;
  delete resolved.api_key_env;
  return resolved;
}

export function loadProviderProfiles(path, environment = process.env) {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  return Object.fromEntries(
    Object.entries(raw).map(([id, profile]) => [
      id,
      resolveProviderProfile(id, profile, environment),
    ]),
  );
}
