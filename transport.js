/**
 * Transport abstraction for the local agent bridge.
 *
 * Both implementations expose the same interface, so everything downstream is
 * written and tested against MockTelegram and never needs a real bot token.
 *
 *   poll(onMessage)              deliver queued inbound messages to the handler
 *   send(chatId, text, options)  post a text reply
 *   sendFile(chatId, path)       post a file
 */

export class MockTelegram {
  constructor(updates = []) {
    this.inbox = [...updates];
    this.sent = [];
  }

  /** Deliver each queued Telegram update once, then drain the inbox. */
  async poll(onMessage) {
    const batch = this.inbox;
    this.inbox = [];
    for (const update of batch) {
      const message = update.message ?? {};
      await onMessage({
        id: update.update_id,
        chatId: String(message.chat?.id ?? ''),
        text: message.text ?? '',
        raw: update,
      });
    }
    return batch.length;
  }

  async send(chatId, text, options = {}) {
    this.sent.push({ chatId, text, options });
    return { ok: true, chatId, text };
  }

  async sendFile(chatId, path) {
    this.sent.push({ chatId, file: path });
    return { ok: true, chatId, file: path };
  }
}

/**
 * Real Bot API transport. Increment I3. Same interface as MockTelegram, so
 * switching is a config change and nothing above this layer moves.
 *
 * Deliberately unimplemented in I1 so that no network call can run in a test.
 */
export class HttpTelegram {
  constructor(token) {
    if (!token) throw new Error('HttpTelegram requires a bot token');
    this.token = token;
    throw new Error('HttpTelegram is increment I3 and is not implemented yet');
  }
}

/** Pick a transport from config. Mock is the default so tests need no secrets. */
export function createTransport({ kind = 'mock', token, fixtures = [] } = {}) {
  if (kind === 'mock') return new MockTelegram(fixtures);
  if (kind === 'http') return new HttpTelegram(token);
  throw new Error(`unknown transport kind: ${kind}`);
}
