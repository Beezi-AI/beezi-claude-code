// Gracefully drain undici's keep-alive pool before a forced exit. On Windows,
// process.exit() while undici still holds its async handle trips the libuv
// assertion (!(handle->flags & UV_HANDLE_CLOSING), async.c). close() releases
// those handles first so the exit is clean. Falls back to plain exit if the
// internal dispatcher symbol ever goes away.
export async function exitClean(code = 0) {
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (dispatcher) {
    try { await dispatcher.close(); }
    catch { try { await dispatcher.destroy(); } catch { /* exit anyway */ } }
  }
  process.exit(code);
}
