import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  scoreProject, scoreGoal, deriveTier, deadlinePressure, compareGoals, compareProjects,
} from "../src/priority.js";
import { legacyGoalPriorityFromNote } from "../src/legacy-import.js";

const golden = JSON.parse(readFileSync(new URL("../../../fixtures/scoring-golden.json", import.meta.url)));
const now = Date.parse(golden.now);

function assertSubset(actual, expected, id) {
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(actual[k], v, `${id}: ${k} expected ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`);
  }
}

for (const c of golden.goals) {
  test(`goal ${c.id}`, () => assertSubset(scoreGoal(c.input), c.expect, c.id));
}

for (const c of golden.projects) {
  test(`project ${c.id}`, () => assertSubset(scoreProject(c.input, now, golden.timezone), c.expect, c.id));
}

test("tier boundaries outside the urgent quadrant", () => {
  for (const b of golden.tierBoundaries) {
    assert.equal(deriveTier(b.score, "important_not_urgent"), b.expect, `score ${b.score}`);
  }
});

for (const m of golden.midnight) {
  test(`midnight ${m.id}`, () => {
    assert.equal(deadlinePressure(m.dueDate, Date.parse(m.now), golden.timezone), m.expectPressure);
  });
}

test("goal score never includes project pressure", () => {
  const a = scoreGoal({ importanceManual: 80, urgencyManual: 20 });
  const b = scoreGoal({ importanceManual: 80, urgencyManual: 20, dueDate: "2026-11-02", stakeholders: [{ sentiment: "blocked" }] });
  assert.deepEqual(a, b);
});

test("A14 goal ordering: tier, score, importance, zh title", () => {
  const goals = [
    { title: "乙", ...scoreGoal({ importanceManual: 60, urgencyManual: 40 }) },
    { title: "甲", ...scoreGoal({ importanceManual: 60, urgencyManual: 40 }) },
    { title: "紧急", ...scoreGoal({ importanceManual: 50, urgencyManual: 50 }) },
    { title: "高分", ...scoreGoal({ importanceManual: 70, urgencyManual: 45 }) },
  ].sort(compareGoals);
  assert.deepEqual(goals.map((g) => g.title), ["紧急", "高分", "甲", "乙"]);
});

test("project ordering has no tier key (legacy): a pinned P0 with low score sorts by score", () => {
  const items = [
    { title: "pinned", ...scoreProject({ importanceManual: 10, urgencyManual: 10, pinnedTier: "P0" }, now) },
    { title: "high", ...scoreProject({ importanceManual: 90, urgencyManual: 30 }, now) },
  ].sort(compareProjects);
  assert.deepEqual(items.map((i) => i.title), ["high", "pinned"]);
});

test("legacy goal note import keeps the marker-with-missing-field quirk", () => {
  assert.deepEqual(legacyGoalPriorityFromNote("plain note"), { importanceManual: 50, urgencyManual: 35, source: "default_no_marker" });
  assert.deepEqual(legacyGoalPriorityFromNote("x\n<!-- osborn:goal-priority {bad} -->"), { importanceManual: 50, urgencyManual: 35, source: "default_bad_json" });
  assert.deepEqual(legacyGoalPriorityFromNote('<!-- osborn:goal-priority {"importanceManual":80} -->'), { importanceManual: 80, urgencyManual: 0, source: "marker" });
  assert.deepEqual(legacyGoalPriorityFromNote('<!-- osborn:goal-priority {"importance":70,"urgency":55} -->'), { importanceManual: 70, urgencyManual: 55, source: "marker" });
});
