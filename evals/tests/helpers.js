// Shared test helpers for evals unit tests.

/** A logger that discards all output, suitable for passing to evaluate/compare. */
export const silentLogger = { log() {}, error() {} }

/** Wrap flat id strings into the {ids, text}[] chunk shape that resolveIds returns. */
export function mkChunks(...ids) {
  return ids.map(id => ({ ids: [id], text: '' }))
}
