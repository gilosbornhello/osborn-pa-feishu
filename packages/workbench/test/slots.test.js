import { test } from "node:test";
import assert from "node:assert/strict";
import { weekDays, slotToRange, blockPlacement, moveRange, slotsPerDay, GRID } from "../src/slots.js";

const tz = "Asia/Shanghai";

test("week is Monday-based", () => {
  assert.deepEqual(weekDays("2026-11-04"), ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
  assert.equal(weekDays("2026-11-08")[0], "2026-11-02");
});

test("slot 4 on 2026-11-03 is 09:00–10:00 Shanghai", () => {
  const r = slotToRange("2026-11-03", 4, tz);
  assert.equal(r.startMs, Date.parse("2026-11-03T09:00:00+08:00"));
  assert.equal(r.endMs, Date.parse("2026-11-03T10:00:00+08:00"));
  assert.equal(slotsPerDay(), 30);
});

test("placement maps back to the same day and offset", () => {
  const days = weekDays("2026-11-03");
  const p = blockPlacement(slotToRange("2026-11-03", 4, tz), days, tz);
  assert.equal(p.dayIndex, 1);
  assert.equal(p.top, (4 * GRID.slotMinutes) / ((GRID.endHour - GRID.startHour) * 60));
  assert.equal(p.crossesMidnight, false);
  assert.equal(blockPlacement(slotToRange("2026-11-10", 4, tz), days, tz), null);
});

test("cross-midnight block is flagged and clipped to the grid", () => {
  const days = weekDays("2026-11-03");
  const block = { startMs: Date.parse("2026-11-03T21:00:00+08:00"), endMs: Date.parse("2026-11-04T01:00:00+08:00") };
  const p = blockPlacement(block, days, tz);
  assert.equal(p.crossesMidnight, true);
  assert.ok(p.top + p.height <= 1 + 1e-9);
});

test("moving keeps the duration", () => {
  const block = { startMs: Date.parse("2026-11-03T09:00:00+08:00"), endMs: Date.parse("2026-11-03T10:30:00+08:00") };
  const m = moveRange(block, "2026-11-05", 10, tz);
  assert.equal(m.startMs, Date.parse("2026-11-05T12:00:00+08:00"));
  assert.equal(m.endMs - m.startMs, 90 * 60_000);
});
