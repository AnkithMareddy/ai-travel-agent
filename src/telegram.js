// Minimal Telegram Bot API client using long polling (no public URL needed).
export class Telegram {
  constructor(token, { log = console } = {}) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing');
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
    this.log = log;
    this.offset = 0;
    this.running = false;
  }

  async api(method, body = {}) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(70_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || res.status}`);
    return json.result;
  }

  async me() { return this.api('getMe'); }

  // Downloads a photo/file someone sent (bots can fetch up to 20 MB). Returns { base64, size }.
  async download(fileId) {
    const f = await this.api('getFile', { file_id: fileId });
    const res = await fetch(`${this.fileBase}/${f.file_path}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { base64: buf.toString('base64'), size: buf.length, path: f.file_path };
  }

  // Shows "typing…" in the chat for ~5s while the bot researches an answer.
  typing(chatId) {
    this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  }

  // A non-anonymous poll, so the bot gets vote updates (bots only see votes on polls they sent).
  async poll(chatId, question, options, { multiple = false } = {}) {
    return this.api('sendPoll', {
      chat_id: chatId,
      question: question.slice(0, 300),
      options: options.slice(0, 10).map((text) => ({ text: String(text).slice(0, 100) })),
      is_anonymous: false,
      allows_multiple_answers: multiple,
    });
  }

  // Sends a text file (e.g. a CSV export) as a document.
  async sendFile(chatId, filename, content, caption = '') {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption);
    form.set('document', new Blob([content], { type: 'text/csv' }), filename);
    const res = await fetch(`${this.base}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`Telegram sendDocument: ${json.description || res.status}`);
    return json.result;
  }

  async send(chatId, html) {
    // Telegram caps messages at 4096 chars; split on line breaks if needed.
    const chunks = [];
    let buf = '';
    for (const line of html.split('\n')) {
      if ((buf + line).length > 3900) { chunks.push(buf); buf = ''; }
      buf += (buf ? '\n' : '') + line;
    }
    if (buf) chunks.push(buf);
    for (const text of chunks) {
      try {
        await this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      } catch (err) {
        // If the HTML is somehow malformed, send it as plain text rather than dropping it.
        if (/can't parse entities/i.test(err.message)) {
          await this.api('sendMessage', { chat_id: chatId, text: text.replace(/<[^>]+>/g, ''), link_preview_options: { is_disabled: true } });
        } else throw err;
      }
    }
  }

  async start(onUpdate) {
    await this.api('deleteWebhook', { drop_pending_updates: false });
    await this.api('setMyCommands', {
      commands: [
        { command: 'today', description: "Today's plan" },
        { command: 'status', description: 'Where I think you are + next alert' },
        { command: 'weather', description: 'Weather now + along today\'s route' },
        { command: 'expenses', description: 'The running tab: who owes who' },
        { command: 'report', description: 'End-of-trip entries for Splitwise' },
        { command: 'reminders', description: 'Reminders that are set' },
        { command: 'pack', description: 'What to pack/bring today' },
        { command: 'bookings', description: 'Saved reservations + reference numbers' },
        { command: 'map', description: 'Timeline + map web page' },
        { command: 'mute', description: 'Pause tips (e.g. /mute 60)' },
        { command: 'unmute', description: 'Resume tips' },
        { command: 'help', description: 'What I can do' },
      ],
    }).catch(() => {});
    this.running = true;
    while (this.running) {
      try {
        const updates = await this.api('getUpdates', {
          offset: this.offset, timeout: 50,
          allowed_updates: ['message', 'edited_message', 'my_chat_member', 'poll'],
        });
        // Several screenshots sent at once arrive as an album (same media_group_id): hand them over together.
        if (updates.at(-1)?.message?.media_group_id) {
          const more = await this.api('getUpdates', { offset: updates.at(-1).update_id + 1, timeout: 2, allowed_updates: ['message', 'edited_message', 'my_chat_member', 'poll'] }).catch(() => []);
          updates.push(...more);
        }
        for (let i = 0; i < updates.length; i++) {
          const u = updates[i];
          this.offset = u.update_id + 1;
          const gid = u.message?.media_group_id;
          if (gid) {
            const album = [u.message];
            while (updates[i + 1]?.message?.media_group_id === gid) album.push(updates[++i].message);
            this.offset = updates[i].update_id + 1;
            if (album.length > 1) u.album = album;
          }
          await onUpdate(u);
        }
      } catch (err) {
        this.log.error?.(`polling error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop() { this.running = false; }
}
