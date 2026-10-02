import {shanghaiDate, RETRY_DELAYS_MS} from './core.js';

export const MAIL_DELAYS_MS = [1, 5, 30].map(minutes => minutes * 60_000);
export const DAY_MS = 86_400_000;

export function nextDaily(now) {
  const today = Date.parse(`${shanghaiDate(new Date(now))}T08:17:00+08:00`);
  return today > now ? today : today + DAY_MS;
}

export function dayEnds(date) {
  return Date.parse(`${date}T00:00:00+08:00`) + DAY_MS;
}

export function retryAt(now, attempt, date, retryAfterMs = 0) {
  const delay = RETRY_DELAYS_MS[attempt - 1];
  if (delay === undefined) return null;
  const due = now + Math.max(delay, retryAfterMs || 0);
  return due < dayEnds(date) ? due : null;
}

export function parseRetryAfter(value, now) {
  if (!value) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, DAY_MS)) : 0;
}
