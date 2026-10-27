/**
 * Whether the bundled fonts can set a name: every letter Latin script
 * (digits, punctuation, spaces and accents are fine). Names in other scripts
 * would render blank or in a mismatched fallback face.
 */
export const settable = (name: string) =>
  /\p{L}/u.test(name) && /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u.test(name);
