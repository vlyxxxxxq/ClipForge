// Saves the newest value after a quiet period. flush() writes anything still waiting right away, so
// leaving a page never drops the last edit.
export function createDebouncedSaver<T>(save: (value: T) => Promise<unknown>, delayMs: number, onError: (e: Error) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting: { value: T } | null = null;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!waiting) return;
    const { value } = waiting;
    waiting = null;
    save(value).catch(onError);
  };

  return {
    schedule(value: T) {
      waiting = { value };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}
