// Splitwise (https://dev.splitwise.com): add the group's expenses there, with the receipt photo attached.
// Auth is a personal API key (Bearer) from https://secure.splitwise.com/apps → register an app → "API key".
const BASE = 'https://secure.splitwise.com/api/v3.0';

export class Splitwise {
  constructor({ apiKey = '', groupId = null, fetchImpl = globalThis.fetch, log = console } = {}) {
    Object.assign(this, { apiKey, groupId: groupId ? Number(groupId) : null, fetch: fetchImpl, log });
    this.cache = new Map();
  }

  get enabled() { return Boolean(this.apiKey); }

  async call(path, { method = 'GET', form = null } = {}) {
    const res = await this.fetch(`${BASE}/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}` },
      ...(form ? { body: form } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Splitwise rejected the API key (401)');
    if (!res.ok) throw new Error(`Splitwise ${path}: HTTP ${res.status}`);
    // "200 OK does not indicate success": check errors on the body too.
    const errs = json.errors && (Array.isArray(json.errors) ? json.errors : Object.values(json.errors).flat());
    if (errs?.length) throw new Error(`Splitwise ${path}: ${errs.join('; ')}`);
    return json;
  }

  async me() {
    if (!this.cache.has('me')) this.cache.set('me', (await this.call('get_current_user')).user);
    return this.cache.get('me');
  }

  async groups() {
    return ((await this.call('get_groups')).groups || []).filter((g) => g.id !== 0); // 0 = "non-group expenses"
  }

  // The trip group: members [{ id, first_name, last_name, balance: [{ currency_code, amount }] }].
  async group(fresh = false) {
    if (!this.groupId) return null;
    const hit = this.cache.get('group');
    if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    const value = (await this.call(`get_group/${this.groupId}`)).group;
    this.cache.set('group', { at: Date.now(), value });
    return value;
  }

  /**
   * payerId paid the whole cost; it's split equally between owedIds (cents go to the first few people).
   * receipt: { base64, mime } (optional photo/PDF of the receipt). Returns the created expense.
   */
  async createExpense({ cost, currency, description, details = '', date = new Date(), payerId, owedIds, receipt = null }) {
    const cents = Math.round(cost * 100);
    const each = Math.floor(cents / owedIds.length);
    const extra = cents - each * owedIds.length;
    const people = [...new Set([payerId, ...owedIds])];
    const build = (withReceipt) => {
      const f = new FormData();
      f.set('cost', (cents / 100).toFixed(2));
      f.set('description', description.slice(0, 100));
      f.set('group_id', String(this.groupId));
      f.set('split_equally', 'false');
      f.set('currency_code', currency);
      f.set('date', date.toISOString());
      if (details) f.set('details', details.slice(0, 500));
      people.forEach((id, i) => {
        const k = owedIds.indexOf(id);
        const owed = k < 0 ? 0 : each + (k < extra ? 1 : 0);
        f.set(`users__${i}__user_id`, String(id));
        f.set(`users__${i}__paid_share`, (id === payerId ? cents / 100 : 0).toFixed(2));
        f.set(`users__${i}__owed_share`, (owed / 100).toFixed(2));
      });
      if (withReceipt && receipt) {
        const ext = receipt.mime === 'application/pdf' ? 'pdf' : receipt.mime.split('/')[1] || 'jpg';
        f.set('receipt', new Blob([Buffer.from(receipt.base64, 'base64')], { type: receipt.mime }), `receipt.${ext}`);
      }
      return f;
    };
    let json;
    try {
      json = await this.call('create_expense', { method: 'POST', form: build(true) });
    } catch (err) {
      if (!receipt) throw err;
      // If the receipt upload is what failed, still record the expense.
      this.log.warn?.(`Splitwise receipt upload failed, adding without it: ${err.message}`);
      json = await this.call('create_expense', { method: 'POST', form: build(false) });
      json.receiptFailed = true;
    }
    const expense = json.expenses?.[0];
    if (!expense) throw new Error('Splitwise did not return the new expense');
    this.cache.delete('group');
    return { ...expense, receiptFailed: Boolean(json.receiptFailed) };
  }

  async deleteExpense(id) {
    const json = await this.call(`delete_expense/${id}`, { method: 'POST' });
    this.cache.delete('group');
    return json.success !== false;
  }
}

export const memberName = (m) => [m.first_name, m.last_name].filter(Boolean).join(' ');
