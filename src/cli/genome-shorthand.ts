/**
 * Launch shorthand for `--genome`: a leading `:`, `::` or `+` on the first
 * argument. `rsih +paperlab` is `rsih --genome paperlab`.
 *
 * Only the first argument is rewritten, because anywhere else the token is
 * genuinely ambiguous. Pi takes free-form messages as positional arguments
 * (`rsih add +1 to the counter`) and most of its options take values
 * (`rsih --thinking +x`), so a shorthand accepted mid-argv would sometimes eat
 * a message word or an option value. At the launch position neither is
 * possible, and `--genome` keeps working everywhere.
 *
 * `(` is deliberately not a sigil: it is a shell metacharacter, so
 * `rsih (paperlab` is a syntax error in both zsh and bash.
 */

/** Longest first, so `::name` is not read as `:` plus `:name`. */
const GENOME_SHORTHAND_PREFIXES = Object.freeze(["::", ":", "+"]);

/** The Genome a shorthand argument names, or undefined if it is not one. */
export function genomeShorthandReference(argument) {
  if (typeof argument !== "string") return undefined;
  const prefix = GENOME_SHORTHAND_PREFIXES.find((candidate) =>
    argument.startsWith(candidate),
  );
  if (!prefix) return undefined;
  const reference = argument.slice(prefix.length);
  // A bare sigil names nothing, and whitespace means the argument is prose.
  if (reference === "" || /\s/.test(reference)) return undefined;
  return reference;
}

/**
 * Rewrite a leading Genome shorthand into `--genome <reference>`. Idempotent:
 * once expanded the first argument is `--genome`, which is not a shorthand.
 */
export function expandGenomeShorthand(argv) {
  const reference = genomeShorthandReference(argv[0]);
  if (reference === undefined) return argv;
  return ["--genome", reference, ...argv.slice(1)];
}
