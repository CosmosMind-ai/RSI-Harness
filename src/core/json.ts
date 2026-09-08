import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }

  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function contentHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function cloneJson(value) {
  return structuredClone(value);
}

function repairInvalidStringEscapes(text) {
  let repaired = "";
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      inString = !inString;
      repaired += char;
      continue;
    }
    if (!inString || char !== "\\") {
      repaired += char;
      continue;
    }

    const next = text[index + 1];
    if ('"\\/bfnrt'.includes(next)) {
      repaired += `${char}${next}`;
      index += 1;
      continue;
    }
    if (
      next === "u" &&
      /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))
    ) {
      repaired += text.slice(index, index + 6);
      index += 5;
      continue;
    }
    repaired += "\\\\";
  }

  return repaired;
}

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const repaired = repairInvalidStringEscapes(text);
    if (repaired === text) throw error;
    return JSON.parse(repaired);
  }
}

function balancedJsonCandidates(text) {
  const candidates = [];

  for (let start = 0; start < text.length; start += 1) {
    if (!"{[".includes(text[start])) continue;

    const stack = [text[start]];
    let inString = false;
    let escaped = false;

    for (
      let index = start + 1;
      index < text.length;
      index += 1
    ) {
      const char = text[index];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }

      if (char !== "}" && char !== "]") continue;

      const opening = stack.at(-1);
      const expected = char === "}" ? "{" : "[";
      if (opening !== expected) break;

      stack.pop();
      if (stack.length === 0) {
        candidates.push(text.slice(start, index + 1));
        break;
      }
    }
  }

  return candidates;
}

function jsonCandidateTexts(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Model returned an empty response.");
  }

  const candidates = [];
  try {
    candidates.push(trimmed);
  } catch {
    // Continue to fenced or embedded JSON extraction.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    candidates.push(fenced[1].trim());
  }

  const firstObject = trimmed.indexOf("{");
  const firstArray = trimmed.indexOf("[");
  const starts = [firstObject, firstArray].filter((index) => index >= 0);
  if (starts.length === 0) {
    throw new Error("Model response did not contain JSON.");
  }

  candidates.push(...balancedJsonCandidates(trimmed));
  return candidates;
}

export function extractJsonCandidates(text) {
  const candidates = jsonCandidateTexts(text);
  const values = [];
  let lastError = null;

  for (const candidate of candidates) {
    try {
      values.push(parseModelJson(candidate));
    } catch (error) {
      lastError = error;
    }
  }

  if (values.length > 0) return values;
  if (lastError) throw lastError;
  throw new Error("Model response contained incomplete JSON.");
}

export function extractJson(text) {
  return extractJsonCandidates(text)[0];
}
