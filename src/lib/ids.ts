let counter = 0;

/** Locally unique id with a readable prefix. */
export function newId(prefix = 'id'): string {
  counter++;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}${counter}`;
}
