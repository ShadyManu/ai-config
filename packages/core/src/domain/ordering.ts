/**
 * Compares strings by UTF-16 code unit.
 *
 * Deliberately not `localeCompare`: that depends on the host's ICU locale, so
 * the same configuration could compile to a different file order — and
 * therefore different bytes — on two machines. Generated output has to be
 * byte-stable across platforms, so ordering must not consult a locale.
 */
export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const byName = <T extends { readonly name: string }>(a: T, b: T): number =>
  compareStrings(a.name, b.name);
