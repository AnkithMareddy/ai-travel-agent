// All trip logic runs on Europe/London wall-clock time.
export const TZ = 'Europe/London';
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const MIN = 60_000;

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
});

export function londonParts(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hh = Number(p.hour);
  const mm = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hh, mm,
    minutes: hh * 60 + mm,
    weekday: p.weekday.toLowerCase().slice(0, 3),
  };
}

const pad = (n) => String(n).padStart(2, '0');

export function hhmm(date) {
  const p = londonParts(date);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

export function toMinutes(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export const addMin = (date, m) => new Date(date.getTime() + m * MIN);
export const minutesBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / MIN);

// "2026-10-10" + "08:30" (London wall clock) -> Date. Tries BST then GMT.
export function localToDate(dateStr, time) {
  for (const off of ['+01:00', '+00:00']) {
    const d = new Date(`${dateStr}T${time}:00${off}`);
    const p = londonParts(d);
    if (p.date === dateStr && p.minutes === toMinutes(time)) return d;
  }
  return new Date(`${dateStr}T${time}:00Z`);
}

export function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayLabel(dateOrStr) {
  const d = typeof dateOrStr === 'string' ? localToDate(dateOrStr, '12:00') : dateOrStr;
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

export function weekdayOf(dateStr) {
  return londonParts(localToDate(dateStr, '12:00')).weekday;
}

// A clock that can be offset for test mode (/fake command or the simulator).
export class Clock {
  constructor(offsetMs = 0) { this.offsetMs = offsetMs; }
  now() { return new Date(Date.now() + this.offsetMs); }
  setNow(date) { this.offsetMs = date.getTime() - Date.now(); }
  reset() { this.offsetMs = 0; }
  get faked() { return this.offsetMs !== 0; }
}

// Fully manual clock for the simulator and tests.
export class ManualClock {
  constructor(date) { this.t = new Date(date); }
  now() { return new Date(this.t); }
  set(date) { this.t = new Date(date); }
  advance(min) { this.t = addMin(this.t, min); }
  get faked() { return true; }
}
