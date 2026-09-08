import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Copy the non-TypeScript assets `tsc` leaves behind, so the npm bin entries in
 * package.json (`dist/src/cli.js` and `dist/src/gee/cli.js`) actually run.
 *
 * Both resolve PI_PACKAGE_DIR to `dist/`. Pi then looks for themes under
 * `<packageDir>/src/modes/interactive/theme` (because `dist/src` exists) and
 * RSIH looks for built-in Genomes under `<packageDir>/genomes`. Neither is a
 * `.ts` file, so neither survives compilation on its own.
 *
 * `scripts/build-binary.ts` lays out the same assets for the Bun binary, which
 * uses a different layout (`dist/theme`, `dist/genomes`).
 */
const distDirectory = resolve("dist");

const themeTarget = join(distDirectory, "src", "modes", "interactive", "theme");
mkdirSync(themeTarget, { recursive: true });
cpSync(resolve("src", "modes", "interactive", "theme"), themeTarget, {
  recursive: true,
});
console.log(`Copied themes to ${themeTarget}`);

const genomesTarget = join(distDirectory, "genomes");
// Clear the target first: a plain cpSync would leave a Genome deleted from
// config/genomes haunting every later incremental build.
rmSync(genomesTarget, { recursive: true, force: true });
cpSync(resolve("config", "genomes"), genomesTarget, { recursive: true });
console.log(`Copied built-in Genomes to ${genomesTarget}`);
