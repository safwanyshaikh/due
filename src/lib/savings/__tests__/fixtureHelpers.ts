export * from '..';
/** Test helper: unwrap a parser result that the fixture guarantees. */
export function emptyIfNull<T>(v: T | null): T {
  if (v === null) throw new Error('expected a parsed summary');
  return v;
}
