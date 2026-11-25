/** Hands a PDF opened with / shared to the native app over to the upload screen. */
let pending: File | null = null;
const listeners = new Set<() => void>();

export function setPendingFile(file: File): void {
  pending = file;
  for (const l of [...listeners]) l();
}

export function takePendingFile(): File | null {
  const f = pending;
  pending = null;
  return f;
}

/** Subscribes to new pending files; returns the unsubscribe function. */
export function onPendingFile(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
