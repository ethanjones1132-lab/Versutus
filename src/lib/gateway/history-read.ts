/** Result of reading gateway history, retaining the last-good value on failure. */
export type HistoryReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; value: T; error: string };

/** Read history without turning a transport failure into an empty transcript. */
export async function readHistory<T>(read: () => Promise<T>, lastGood: T): Promise<HistoryReadResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return {
      ok: false,
      value: lastGood,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
