// Shared trip expenses: who paid what, and the fewest transfers to settle up (per currency).

export const SYMBOL = { EUR: '€', GBP: '£', USD: '$' };

const CURRENCY_WORDS = [
  [/€|\beur(o|os)?\b/i, 'EUR'],
  [/£|\b(gbp|pounds?|quid)\b/i, 'GBP'],
  [/\$|\b(usd|dollars?|bucks)\b/i, 'USD'],
];

export function currencyIn(text, fallback) {
  for (const [re, cur] of CURRENCY_WORDS) if (re.test(text)) return cur;
  return fallback;
}

export const money = (amount, cur) => `${SYMBOL[cur] || ''}${(Math.round(amount * 100) / 100).toFixed(2).replace(/\.00$/, '')}${SYMBOL[cur] ? '' : ` ${cur}`}`;

/**
 * "45 dinner", "€45.50 for petrol", "60 quid parking", "I paid 30 for the ferry".
 * Returns { amount, currency, what } or null.
 */
export function parsePaid(text, fallbackCurrency) {
  const t = text.trim().replace(/^(?:i|we)\s+(?:just\s+)?(?:paid|spent|covered|got)\s+/i, '');
  const m = t.match(/^([€£$])?\s*(\d+(?:[.,]\d{1,2})?)\s*(eur(?:os?)?|gbp|pounds?|quid|usd|dollars?|bucks|€|£)?\s*(?:for|on)?\s+(.+)$/i);
  if (!m) return null;
  const amount = Number(m[2].replace(',', '.'));
  if (!(amount > 0) || amount > 20000) return null;
  return { amount, currency: currencyIn(`${m[1] || ''} ${m[3] || ''}`, fallbackCurrency), what: m[4].trim().replace(/[.!]+$/, '') };
}

/**
 * expenses: [{ payer, amount, currency, split: [names] | null }]
 * people:   everyone on the trip (used when split is null).
 * Returns { [currency]: { total, balances: { name: +owed/-owes }, transfers: [{ from, to, amount }] } }.
 */
export function settle(expenses, people) {
  const out = {};
  for (const e of expenses) {
    const cur = e.currency;
    const c = (out[cur] ||= { total: 0, balances: {}, transfers: [] });
    const among = e.split?.length ? e.split : people;
    if (!among.length) continue;
    c.total += e.amount;
    c.balances[e.payer] = (c.balances[e.payer] || 0) + e.amount;
    for (const p of among) c.balances[p] = (c.balances[p] || 0) - e.amount / among.length;
  }
  for (const c of Object.values(out)) {
    const debtors = Object.entries(c.balances).filter(([, v]) => v < -0.005).map(([n, v]) => [n, -v]).sort((a, b) => b[1] - a[1]);
    const creditors = Object.entries(c.balances).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const amt = Math.min(debtors[i][1], creditors[j][1]);
      if (amt >= 0.01) c.transfers.push({ from: debtors[i][0], to: creditors[j][0], amount: Math.round(amt * 100) / 100 });
      debtors[i][1] -= amt;
      creditors[j][1] -= amt;
      if (debtors[i][1] < 0.005) i++;
      if (creditors[j][1] < 0.005) j++;
    }
  }
  return out;
}

// Venmo opens straight to "pay this person this amount" (on a phone it opens the app).
export const venmoLink = (handle, amount, note) => `https://venmo.com/${encodeURIComponent(handle.replace(/^@/, ''))}?txn=pay&amount=${amount.toFixed(2)}&note=${encodeURIComponent(note)}`;

// Today's rates to US dollars (Frankfurter: free, no key, ECB rates). Returns { EUR: 1.13, GBP: 1.32, USD: 1 } or null.
export async function usdRates(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { rates } = await res.json();
    return { USD: 1, EUR: 1 / rates.EUR, GBP: 1 / rates.GBP };
  } catch {
    return null;
  }
}

export function toCsv(expenses, rates) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['#', 'Date', 'What', 'Paid by', 'Amount', 'Currency', 'USD (approx)', 'Split between', 'Added by']];
  for (const e of expenses) {
    rows.push([e.n, e.at.slice(0, 10), e.what, e.payer, e.amount.toFixed(2), e.currency, rates ? (e.amount * rates[e.currency]).toFixed(2) : '', e.split?.join(' + ') || 'everyone', e.by]);
  }
  return rows.map((r) => r.map(q).join(',')).join('\n');
}

/**
 * For entering the whole trip into Splitwise as ONE expense per currency ("paid by multiple people",
 * "split by exact amounts"): what each person paid and what each person's share is, in cents that add up.
 * Returns { [currency]: { total, paid: { name: amount }, owed: { name: amount } } }.
 */
export function splitwiseShares(expenses, people) {
  const out = {};
  for (const e of expenses) {
    const c = (out[e.currency] ||= { total: 0, paid: {}, owed: {} });
    const among = e.split?.length ? e.split : people;
    if (!among.length) continue;
    c.total += e.amount;
    c.paid[e.payer] = (c.paid[e.payer] || 0) + e.amount;
    for (const p of among) c.owed[p] = (c.owed[p] || 0) + e.amount / among.length;
  }
  // Round to cents and make each column add up to the total exactly (Splitwise checks).
  const fix = (m, total) => {
    const cents = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v * 100)]));
    const diff = Math.round(total * 100) - Object.values(cents).reduce((a, b) => a + b, 0);
    const top = Object.keys(cents).sort((a, b) => cents[b] - cents[a])[0];
    if (top) cents[top] += diff;
    return Object.fromEntries(Object.entries(cents).filter(([, v]) => v).map(([k, v]) => [k, v / 100]));
  };
  for (const c of Object.values(out)) {
    c.total = Math.round(c.total * 100) / 100;
    c.paid = fix(c.paid, c.total);
    c.owed = fix(c.owed, c.total);
  }
  return out;
}
