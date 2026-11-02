// Calendar-date and wall-clock helpers, parameterized by an IANA timezone.
// Rules never read the system clock: every function takes `now` explicitly so
// fixtures are deterministic.

export const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const formatters = new Map();
function partsFormatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of instant `ms` in `tz`. */
export function wallParts(ms, tz = DEFAULT_TIMEZONE) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    date: `${out.year}-${out.month}-${out.day}`,
    hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second),
    weekday: WEEKDAYS[out.weekday],
    day: Number(out.day),
  };
}

export function toInstant(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && !DATE_ONLY.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Normalize a date-like value to a "YYYY-MM-DD" calendar date in `tz`.
 * - "YYYY-MM-DD" is already a calendar date and is returned as-is (if valid).
 * - Epoch ms (Feishu datetime cells), Date, or full ISO strings are projected
 *   onto the wall calendar of `tz`.
 * Returns null for empty or invalid input.
 */
export function toLocalDate(value, tz = DEFAULT_TIMEZONE) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && DATE_ONLY.test(value)) {
    const probe = new Date(`${value}T12:00:00Z`);
    if (Number.isNaN(probe.getTime())) return null;
    return probe.toISOString().slice(0, 10) === value ? value : null;
  }
  const ms = toInstant(value);
  if (ms === null || !Number.isFinite(ms)) return null;
  return wallParts(ms, tz).date;
}

export function addDays(dateIso, days) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / DAY_MS);
}

/**
 * Calendar-day difference from "today in tz" to the target date.
 * Equivalent to the legacy `daysUntil` for "YYYY-MM-DD" inputs. Unlike the
 * legacy code, datetime inputs are projected to tz instead of becoming null
 * (see audit finding R-03).
 */
export function daysUntil(value, now, tz = DEFAULT_TIMEZONE) {
  const target = toLocalDate(value, tz);
  if (!target) return null;
  return diffDays(wallParts(toInstant(now), tz).date, target);
}

/** Weekday (0=Sun) of a calendar date. */
export function weekdayOf(dateIso) {
  return new Date(`${dateIso}T12:00:00Z`).getUTCDay();
}

function offsetMs(ms, tz) {
  const p = wallParts(ms, tz);
  const [y, m, d] = p.date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * Wall time "YYYY-MM-DDTHH:mm" in `tz` → epoch ms. Non-existent wall times
 * (DST gaps) resolve forward; ambiguous ones resolve to the earlier instant.
 */
export function wallToInstant(localDateTime, tz = DEFAULT_TIMEZONE) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localDateTime);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ms = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(ms, tz);
  if (second !== ms) ms = Math.min(ms, second);
  return ms;
}
