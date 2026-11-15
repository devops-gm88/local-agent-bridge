/**
 * The bridge loop: poll -> handle -> reply -> log.
 *
 * The `handler` is the seam where DSH goes. In increment I1 the handler is a
 * plain function so the loop is testable with no model, no token and no network.
 * In I2 the handler becomes: `dsh headless "<task>"`.
 */
import { appendRun, makeRunId } from './log.js';

export async function runBridge({ transport, handler, logPath = null, clock = () => Date.now() }) {
  const runs = [];
  await transport.poll(async (message) => {
    const startedAt = clock();
    const runId = makeRunId(startedAt);
    let status = 'ok';
    let reply;
    let error = null;
    try {
      reply = await handler(message);
    } catch (err) {
      status = 'error';
      error = err instanceof Error ? err.message : String(err);
      reply = `Error: ${error}`;
    }
    await transport.send(message.chatId, reply);
    const record = {
      run_id: runId,
      chat: message.chatId,
      task: message.text,
      status,
      error,
      started_at: new Date(startedAt).toISOString(),
      duration_ms: clock() - startedAt,
      reply,
    };
    runs.push(record);
    if (logPath) await appendRun(logPath, record);
    return record;
  });
  return runs;
}
