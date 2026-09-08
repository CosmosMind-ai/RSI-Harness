import { copyFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Copy the component contracts into every shipped Genome bundle.
 *
 * `docs/genome/components/*.dev.md` is the single source of truth, but a bundle
 * has to carry its own copy: `contract` is a required field on every component
 * and the path is resolved relative to the manifest, so a bundle that points
 * outside itself stops loading the moment it is installed elsewhere.
 *
 * `test/harness-rsi-genome.test.ts` fails when the copies drift, so run this
 * after editing any contract.
 */
const source = resolve("docs", "genome", "components");
const bundles = ["paperlab", "harness-rsi"];

const contracts = readdirSync(source).filter((name) => name.endsWith(".dev.md"));
if (contracts.length === 0) {
  throw new Error(`No contracts found in ${source}.`);
}

for (const bundle of bundles) {
  const target = resolve("config", "genomes", bundle, "contracts");
  for (const name of contracts) {
    copyFileSync(join(source, name), join(target, name));
  }
  console.log(`Synced ${contracts.length} contracts to ${target}`);
}
