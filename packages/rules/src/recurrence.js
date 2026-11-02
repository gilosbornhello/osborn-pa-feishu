// recurrence@1 — series stored separately from occurrences.
//
// A series is a rule; occurrences are time-block rows generated inside a
// rolling window. Each occurrence has a stable key built from the series id,
// its generation and the ORIGINAL local start, so rescheduling one occurrence
// never changes its key, and re-running the generator never duplicates it.
// Exceptions (cancelled / moved) and tombstones win over generation.
//
// This is a NEW capability relative to legacy Osborn PA, which expanded up to
// 120 rows at creation time (365 days for "never ends") and supported only
// delete scopes, not edit scopes (audit finding R-07).

import { addDays, diffDays, wallToInstant, weekdayOf } from "./time.js";

export const RECURRENCE_RULE_VERSION = "recurrence@1";
export const DEFAULT_WINDOW_DAYS = 56; // 8 weeks; product setting, pending user decision

/**
 * @typedef {object} Series
 * @property {string} seriesId
 * @property {number} generation        bumps when "edit this and following" splits a series
 * @property {"daily"|"weekly"} frequency
 * @property {number} interval          phase 1: always 1
 * @property {string} timezone          IANA
 * @property {string} startLocal        "YYYY-MM-DDTHH:mm" (timed) or "YYYY-MM-DD" (all-day)
 * @property {boolean} allDay
 * @property {number} [durationMinutes] timed series only
 * @property {number} [allDaySpanDays]  all-day series only
 * @property {"date"|"rolling"} endMode
 * @property {string} [until]           inclusive local date, endMode=date
 * @property {string} [retiredFrom]     original local date from which this series no longer generates
 */

export function validateSeries(s) {
  const errors = [];
  if (!s.seriesId) errors.push("seriesId required");
  if (!["daily", "weekly"].includes(s.frequency)) errors.push("frequency must be daily|weekly");
  if ((s.interval ?? 1) !== 1) errors.push("interval must be 1 in phase 1");
  if (s.allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.startLocal)) errors.push("all-day startLocal must be YYYY-MM-DD");
    if (!(s.allDaySpanDays >= 1)) errors.push("allDaySpanDays >= 1 required");
    if (s.durationMinutes) errors.push("all-day series must not set durationMinutes");
  } else {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s.startLocal)) errors.push("timed startLocal must be YYYY-MM-DDTHH:mm");
    if (!(s.durationMinutes > 0)) errors.push("durationMinutes > 0 required");
    if (s.allDaySpanDays) errors.push("timed series must not set allDaySpanDays");
  }
  if (s.endMode === "date" && !s.until) errors.push("until required when endMode=date");
  if (!s.timezone) errors.push("timezone required");
  return errors;
}

export function occurrenceKey(s, originalDate) {
  return `${s.seriesId}#g${s.generation ?? 1}@${originalDate}`;
}

/**
 * Generate occurrences whose original date falls in [fromDate, toDate].
 * @param {Series} s
 * @param {{fromDate:string,toDate:string}} window
 * @param {Map<string, {type:"cancelled"|"moved", startMs?:number, endMs?:number}>} exceptions keyed by occurrenceKey
 */
export function generateOccurrences(s, { fromDate, toDate }, exceptions = new Map()) {
  const errors = validateSeries(s);
  if (errors.length) throw new Error(`invalid series: ${errors.join("; ")}`);
  const startDate = s.startLocal.slice(0, 10);
  const step = s.frequency === "weekly" ? 7 : 1;
  const out = [];
  let first = startDate;
  if (fromDate > startDate) {
    const k = Math.ceil(diffDays(startDate, fromDate) / step);
    first = addDays(startDate, k * step);
  }
  for (let d = first; d <= toDate; d = addDays(d, step)) {
    if (s.endMode === "date" && d > s.until) break;
    if (s.retiredFrom && d >= s.retiredFrom) break;
    const key = occurrenceKey(s, d);
    const ex = exceptions.get(key);
    if (ex?.type === "cancelled") continue;
    let startMs; let endMs;
    if (s.allDay) {
      startMs = null; endMs = null;
    } else {
      startMs = wallToInstant(`${d}${s.startLocal.slice(10)}`, s.timezone);
      endMs = startMs + s.durationMinutes * 60_000;
    }
    const occ = {
      occurrenceKey: key, seriesId: s.seriesId, generation: s.generation ?? 1,
      originalDate: d, allDay: Boolean(s.allDay),
      date: s.allDay ? d : null, endDate: s.allDay ? addDays(d, s.allDaySpanDays - 1) : null,
      startMs, endMs, exception: null,
    };
    if (ex?.type === "moved") Object.assign(occ, { startMs: ex.startMs, endMs: ex.endMs, exception: "moved" });
    out.push(occ);
  }
  return out;
}

/**
 * Diff the generator output against occurrences already stored, returning only
 * rows to create. Existing keys are never recreated, so the generator can run
 * repeatedly (or concurrently, given a unique key at the store) without duplicates.
 */
export function planGeneration(s, window, existingKeys, exceptions) {
  const existing = new Set(existingKeys);
  return generateOccurrences(s, window, exceptions).filter((o) => !existing.has(o.occurrenceKey));
}

/**
 * "Edit this and following": retire the old series from the cut-off original
 * date and start a new generation carrying the new rule.
 * Returns the two series plus the decisions needed for already-generated rows.
 */
export function splitSeries(oldSeries, cutoffDate, changes, storedOccurrences = []) {
  const retired = { ...oldSeries, retiredFrom: cutoffDate };
  const next = {
    ...oldSeries, ...changes,
    seriesId: oldSeries.seriesId,
    generation: (oldSeries.generation ?? 1) + 1,
    supersedes: occurrenceKey(oldSeries, cutoffDate),
    retiredFrom: undefined,
  };
  if (!changes.startLocal) {
    next.startLocal = `${cutoffDate}${oldSeries.startLocal.slice(10)}`;
  }
  const errors = validateSeries(next);
  if (errors.length) throw new Error(`invalid new generation: ${errors.join("; ")}`);
  const sameCadence = next.frequency === oldSeries.frequency
    && weekdayOf(next.startLocal.slice(0, 10)) === weekdayOf(cutoffDate);
  const supersede = [];
  const carryExceptions = [];
  const conflicts = [];
  for (const o of storedOccurrences) {
    if (o.generation !== (oldSeries.generation ?? 1) || o.originalDate < cutoffDate) continue;
    if (o.state === "done") continue; // history is never rewritten
    supersede.push(o.occurrenceKey);
    if (o.exception) {
      if (sameCadence) carryExceptions.push({ from: o.occurrenceKey, to: occurrenceKey(next, o.originalDate), type: o.exception });
      else conflicts.push({ occurrenceKey: o.occurrenceKey, reason: "cadence_changed_exception_needs_user_decision" });
    }
  }
  return { retired, next, supersede, carryExceptions, conflicts };
}
