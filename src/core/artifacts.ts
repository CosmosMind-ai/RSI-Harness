import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, contentHash } from "./json.ts";

export function createArtifact(type, payload, options = {}) {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const lineage = {
    parents: [...(options.parents ?? [])],
    operator: options.operator ?? null,
    operator_version: options.operatorVersion ?? null,
    evidence: [...(options.evidence ?? [])],
  };
  const digest = contentHash({ type, payload, lineage });

  return {
    artifact_id: `${type}:${digest.slice(0, 16)}`,
    artifact_type: type,
    schema_version: options.schemaVersion ?? "1",
    created_at: createdAt,
    content_hash: digest,
    lineage,
    payload,
  };
}

export class FileArtifactStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  async put(artifact) {
    await mkdir(this.rootDirectory, { recursive: true });
    const filename = `${artifact.artifact_id.replaceAll(":", "__")}.json`;
    await writeFile(
      join(this.rootDirectory, filename),
      `${canonicalJson(artifact)}\n`,
      "utf8",
    );
    return artifact;
  }

  async get(artifactId) {
    const filename = `${artifactId.replaceAll(":", "__")}.json`;
    return JSON.parse(
      await readFile(join(this.rootDirectory, filename), "utf8"),
    );
  }
}
