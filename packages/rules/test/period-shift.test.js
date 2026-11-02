import { test } from "node:test";
import assert from "node:assert/strict";
import { planPeriodShift, shiftBucketForDay, legacyAutoShiftOnce, BUCKETS } from "../src/period-shift.js";
import { addDays } from "../src/time.js";

const g = (id, bucket, lastShiftDate, extra = {}) => ({ id, bucket, lastShiftDate, revision: 1, ...extra });

test("ordinary Tuesday: only tomorrow moves", () => {
  for (const b of BUCKETS) {
    assert.equal(shiftBucketForDay(b, "2026-11-03"), b === "tomorrow" ? "today" : b);
  }
});

test("Monday 2026-11-02: this_week→today, next_week→this_week (one hop)", () => {
  assert.equal(shiftBucketForDay("this_week", "2026-11-02"), "today");
  assert.equal(shiftBucketForDay("next_week", "2026-11-02"), "this_week");
  assert.equal(shiftBucketForDay("this_month", "2026-11-02"), "this_month");
});

test("Monday that is also the 1st (2026-06-01): this_month waits in this_week", () => {
  assert.equal(shiftBucketForDay("this_month", "2026-06-01"), "this_week");
  assert.equal(shiftBucketForDay("next_month", "2026-06-01"), "this_month");
  assert.equal(shiftBucketForDay("this_week", "2026-06-01"), "today");
  assert.equal(shiftBucketForDay("next_week", "2026-06-01"), "this_week");
});

test("single-day result matches the legacy transform for every bucket on special days", () => {
  for (const day of ["2026-11-02", "2026-06-01", "2026-11-03", "2026-02-01", "2026-12-01"]) {
    const goals = BUCKETS.map((b) => ({ id: b, bucket: b }));
    const legacy = legacyAutoShiftOnce(goals, day);
    for (const l of legacy) assert.equal(shiftBucketForDay(l.id, day), l.bucket, `${day} ${l.id}`);
  }
});

test("idempotent: re-running on the same day changes nothing (legacy double-shifted)", () => {
  const goals = [g("a", "next_week", "2026-11-01")];
  const first = planPeriodShift(goals, "2026-11-02");
  assert.equal(first.updates[0].bucket, "this_week");
  const after = [{ ...goals[0], bucket: first.updates[0].bucket, lastShiftDate: "2026-11-02", revision: 2 }];
  assert.equal(planPeriodShift(after, "2026-11-02").updates.length, 0);
  // legacy run twice on the same Monday pushes next_week all the way to today:
  const twice = legacyAutoShiftOnce(legacyAutoShiftOnce([{ bucket: "next_week" }], "2026-11-02"), "2026-11-02");
  assert.equal(twice[0].bucket, "today");
});

test("catch-up after a 3-day outage replays each day in order", () => {
  // last applied Friday 2026-10-30; today Monday 2026-11-02
  const plan = planPeriodShift([g("a", "next_week", "2026-10-30"), g("b", "tomorrow", "2026-10-30")], "2026-11-02");
  const byId = Object.fromEntries(plan.updates.map((u) => [u.id, u]));
  assert.equal(byId.a.bucket, "this_week");
  assert.equal(byId.b.bucket, "today");
  let bucket = "next_week";
  for (let i = 1; i <= 3; i++) bucket = legacyAutoShiftOnce([{ bucket }], addDays("2026-10-30", i))[0].bucket;
  assert.equal(bucket, byId.a.bucket);
});

test("outage longer than 31 days needs human review instead of guessing", () => {
  const plan = planPeriodShift([g("a", "next_month", "2026-09-01")], "2026-11-02");
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.needsReview[0].reason, "catch_up_window_exceeded");
});

test("done/archived goals are not moved; new goals are anchored without moving", () => {
  const plan = planPeriodShift([
    g("done", "tomorrow", "2026-11-01", { done: true }),
    g("arch", "tomorrow", "2026-11-01", { archived: true }),
    g("new", "tomorrow", null),
  ], "2026-11-02");
  assert.deepEqual(plan.updates.map((u) => [u.id, u.bucket, u.moved]), [["new", "tomorrow", false]]);
});

test("every update carries the revision it was planned from (stale writes can be rejected)", () => {
  const plan = planPeriodShift([g("a", "tomorrow", "2026-11-01", { revision: 7 })], "2026-11-02");
  assert.equal(plan.updates[0].expectedRevision, 7);
});
