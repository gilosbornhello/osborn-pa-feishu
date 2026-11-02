import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOccurrences, planGeneration, splitSeries, validateSeries, occurrenceKey } from "../src/recurrence.js";

const weekly = {
  seriesId: "s1", generation: 1, frequency: "weekly", interval: 1, timezone: "Asia/Shanghai",
  startLocal: "2026-11-02T23:00", allDay: false, durationMinutes: 120, endMode: "rolling",
};

test("timed weekly series crossing midnight keeps duration and Shanghai wall time", () => {
  const occ = generateOccurrences(weekly, { fromDate: "2026-11-01", toDate: "2026-11-30" });
  assert.equal(occ.length, 5);
  assert.equal(occ[0].startMs, Date.parse("2026-11-02T23:00:00+08:00"));
  assert.equal(occ[0].endMs, Date.parse("2026-11-03T01:00:00+08:00"));
  assert.deepEqual(occ.map((o) => o.originalDate), ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
});

test("window starting mid-series aligns to the series cadence", () => {
  const occ = generateOccurrences(weekly, { fromDate: "2026-11-05", toDate: "2026-11-20" });
  assert.deepEqual(occ.map((o) => o.originalDate), ["2026-11-09", "2026-11-16"]);
});

test("re-running the generator never duplicates; cancelled occurrences never come back", () => {
  const window = { fromDate: "2026-11-01", toDate: "2026-11-30" };
  const all = generateOccurrences(weekly, window);
  const cancelledKey = all[1].occurrenceKey;
  const exceptions = new Map([[cancelledKey, { type: "cancelled" }]]);
  const stored = all.filter((o) => o.occurrenceKey !== cancelledKey).map((o) => o.occurrenceKey);
  assert.deepEqual(planGeneration(weekly, window, stored, exceptions), []);
  // wipe future rows, rebuild from series + exceptions only
  const rebuilt = planGeneration(weekly, window, [], exceptions);
  assert.equal(rebuilt.length, 4);
  assert.ok(!rebuilt.some((o) => o.occurrenceKey === cancelledKey));
});

test("a moved occurrence keeps its original key", () => {
  const key = occurrenceKey(weekly, "2026-11-09");
  const moved = { type: "moved", startMs: Date.parse("2026-11-10T09:00:00+08:00"), endMs: Date.parse("2026-11-10T11:00:00+08:00") };
  const occ = generateOccurrences(weekly, { fromDate: "2026-11-09", toDate: "2026-11-09" }, new Map([[key, moved]]));
  assert.equal(occ[0].occurrenceKey, key);
  assert.equal(occ[0].exception, "moved");
  assert.equal(occ[0].startMs, moved.startMs);
});

test("end date is inclusive; all-day series span days", () => {
  const s = { seriesId: "d", frequency: "daily", interval: 1, timezone: "Asia/Shanghai", startLocal: "2026-11-02", allDay: true, allDaySpanDays: 2, endMode: "date", until: "2026-11-04" };
  const occ = generateOccurrences(s, { fromDate: "2026-11-01", toDate: "2026-11-30" });
  assert.deepEqual(occ.map((o) => [o.date, o.endDate]), [["2026-11-02", "2026-11-03"], ["2026-11-03", "2026-11-04"], ["2026-11-04", "2026-11-05"]]);
});

test("validation rejects mixed timed/all-day fields and interval > 1", () => {
  assert.ok(validateSeries({ ...weekly, allDaySpanDays: 1 }).length > 0);
  assert.ok(validateSeries({ ...weekly, interval: 2 }).length > 0);
  assert.ok(validateSeries({ ...weekly, durationMinutes: 0 }).length > 0);
});

test("edit this-and-following: old generation retires at cut-off, history untouched, exceptions carried", () => {
  const window = { fromDate: "2026-11-01", toDate: "2026-11-30" };
  const stored = generateOccurrences(weekly, window).map((o, i) => ({
    ...o, state: i === 0 ? "done" : "planned", exception: i === 3 ? "cancelled" : null,
  }));
  const { retired, next, supersede, carryExceptions, conflicts } = splitSeries(weekly, "2026-11-16", { durationMinutes: 60 }, stored);
  assert.equal(next.generation, 2);
  assert.equal(next.startLocal, "2026-11-16T23:00");
  assert.deepEqual(generateOccurrences(retired, window).map((o) => o.originalDate), ["2026-11-02", "2026-11-09"]);
  assert.deepEqual(supersede, [occurrenceKey(weekly, "2026-11-16"), occurrenceKey(weekly, "2026-11-23"), occurrenceKey(weekly, "2026-11-30")]);
  assert.deepEqual(carryExceptions, [{ from: occurrenceKey(weekly, "2026-11-23"), to: occurrenceKey(next, "2026-11-23"), type: "cancelled" }]);
  assert.deepEqual(conflicts, []);
  const nextOcc = generateOccurrences(next, window);
  assert.equal(nextOcc[0].endMs - nextOcc[0].startMs, 60 * 60_000);
});

test("cadence change with existing exceptions surfaces a conflict instead of guessing", () => {
  const stored = [{ ...generateOccurrences(weekly, { fromDate: "2026-11-23", toDate: "2026-11-23" })[0], state: "planned", exception: "cancelled" }];
  const { conflicts } = splitSeries(weekly, "2026-11-16", { frequency: "daily" }, stored);
  assert.equal(conflicts.length, 1);
});
