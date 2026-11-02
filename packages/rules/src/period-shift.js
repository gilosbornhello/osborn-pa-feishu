// period-shift@1 — moves goals between period buckets as calendar days pass.
//
// Legacy behaviour (server /api/auto-shift, mirrored by client autoShift):
//   every day   tomorrow   → today
//   Monday      this_week  → today,     then next_week  → this_week
//   1st of mon  this_month → this_week, then next_month → this_month
// Each step reads the bucket state *before* that step, so a goal moves at most
// one hop per day (next_week lands in this_week, not today; on a Monday that is
// also the 1st, this_month lands in this_week and waits for next Monday).
//
// Legacy had no idempotency: running twice on a Monday pushed next_week goals
// all the way to today. Here every goal carries `lastShiftDate`; a day is
// applied to a goal at most once, and missed days are replayed one by one so
// a multi-day outage reproduces the legacy day-by-day result.

import { addDays, diffDays, weekdayOf } from "./time.js";

export const PERIOD_SHIFT_RULE_VERSION = "period-shift@1";
export const BUCKETS = Object.freeze([
  "inbox", "today", "tomorrow", "this_week", "next_week",
  "this_month", "next_month", "this_year", "lifetime",
]);
export const MAX_CATCH_UP_DAYS = 31;

/** Apply exactly one calendar day's transition to one bucket. */
export function shiftBucketForDay(bucket, dateIso) {
  const monday = weekdayOf(dateIso) === 1;
  const first = dateIso.endsWith("-01");
  let b = bucket;
  // Order matters and mirrors legacy: each rule sees the result of the previous one.
  if (b === "tomorrow") b = "today";
  if (monday) {
    if (b === "this_week") b = "today";
    else if (b === "next_week") b = "this_week";
  }
  if (first) {
    if (b === "this_month") b = "this_week";
    else if (b === "next_month") b = "this_month";
  }
  return b;
}

/**
 * Plan the shift for a set of goals up to and including `today`.
 * Pure: returns a list of intended updates, each guarded by the revision the
 * plan was computed from, so the executor can reject stale writes
 * (a human edit in between wins).
 *
 * Goals that are done or archived are not moved (server semantics; the legacy
 * client also moved done goals — see audit finding R-05).
 */
export function planPeriodShift(goals, today, { maxCatchUpDays = MAX_CATCH_UP_DAYS } = {}) {
  const updates = [];
  const needsReview = [];
  for (const g of goals) {
    if (g.done || g.archived) continue;
    const from = g.lastShiftDate;
    if (!from) {
      // New goal or unknown baseline: anchor it today without moving.
      updates.push({ id: g.id, expectedRevision: g.revision, bucket: g.bucket, lastShiftDate: today, moved: false });
      continue;
    }
    const gap = diffDays(from, today);
    if (gap <= 0) continue; // already applied today (idempotent re-run) or clock skew
    if (gap > maxCatchUpDays) {
      needsReview.push({ id: g.id, reason: "catch_up_window_exceeded", lastShiftDate: from, gapDays: gap });
      continue;
    }
    let bucket = g.bucket;
    for (let i = 1; i <= gap; i++) bucket = shiftBucketForDay(bucket, addDays(from, i));
    updates.push({ id: g.id, expectedRevision: g.revision, bucket, lastShiftDate: today, moved: bucket !== g.bucket });
  }
  return { ruleVersion: PERIOD_SHIFT_RULE_VERSION, today, updates, needsReview };
}

/**
 * Legacy single-run transform, kept only as a test oracle for parity checks.
 * Not idempotent.
 */
export function legacyAutoShiftOnce(goals, dateIso) {
  const monday = weekdayOf(dateIso) === 1;
  const first = dateIso.endsWith("-01");
  let s = goals.map((x) => (x.bucket === "tomorrow" ? { ...x, bucket: "today" } : x));
  if (monday) {
    s = s.map((x) => (x.bucket === "this_week" ? { ...x, bucket: "today" } : x));
    s = s.map((x) => (x.bucket === "next_week" ? { ...x, bucket: "this_week" } : x));
  }
  if (first) {
    s = s.map((x) => (x.bucket === "this_month" ? { ...x, bucket: "this_week" } : x));
    s = s.map((x) => (x.bucket === "next_month" ? { ...x, bucket: "this_month" } : x));
  }
  return s;
}
