import { test } from "node:test";
import assert from "node:assert/strict";
import { planInstall } from "../src/plan.js";
import { loadManifest } from "../../schema/manifest-hash.mjs";

const manifest = loadManifest();

// Simulate applying a plan to an in-memory Base, the way the CLI would.
function apply(current, steps) {
  const tables = structuredClone(current.tables);
  for (const s of steps) {
    if (s.op === "create_table") tables.push({ name: s.table, fields: [{ name: s.primary.name, type: s.primary.type }] });
    if (s.op === "create_field") tables.find((t) => t.name === s.table).fields.push({ name: s.field.name, type: s.field.type });
  }
  return { tables };
}

test("F0 fresh install creates the five F0 tables, then fields, links last", () => {
  const { steps, conflicts } = planInstall(manifest, "F0");
  const tables = steps.filter((s) => s.op === "create_table").map((s) => s.table);
  assert.deepEqual(tables, ["实例设置", "成员", "项目", "目标任务", "时间安排"]);
  assert.deepEqual(conflicts, []);
  const firstLink = steps.findIndex((s) => s.field?.type === "link");
  assert.ok(firstLink > 0);
  assert.ok(steps.slice(firstLink).every((s) => s.field?.type === "link"), "all links after plain fields");
});

test("F0 skips F1-only fields and defers formulas and out-of-profile links", () => {
  const { steps, deferred } = planInstall(manifest, "F0");
  const names = steps.filter((s) => s.table === "时间安排" && s.field).map((s) => s.field.name);
  assert.ok(names.includes("operation_key"));
  assert.ok(!names.includes("occurrence_key"), "F1 field");
  assert.ok(!names.includes("series"), "F1 link");
  const goalNames = steps.filter((s) => s.table === "目标任务" && s.field).map((s) => s.field.name);
  assert.ok(!goalNames.includes("kr_target"), "F1-O field");
  assert.deepEqual(deferred.map((d) => d.field).sort(), ["priority_score", "quadrant", "tier"]);
});

test("planning again after applying is empty (re-runnable)", () => {
  const first = planInstall(manifest, "F0");
  const after = apply({ tables: [] }, first.steps);
  assert.deepEqual(planInstall(manifest, "F0", after).steps, []);
});

test("interrupted install resumes with only the missing writes", () => {
  const first = planInstall(manifest, "F0");
  const half = apply({ tables: [] }, first.steps.slice(0, 20));
  const rest = planInstall(manifest, "F0", half).steps;
  assert.equal(rest.length, first.steps.length - 20);
  assert.deepEqual(planInstall(manifest, "F0", apply(half, rest)).steps, []);
});

test("a same-named field of another type is a conflict, never retyped", () => {
  const first = planInstall(manifest, "F0");
  const base = apply({ tables: [] }, first.steps);
  base.tables.find((t) => t.name === "时间安排").fields.find((f) => f.name === "revision").type = "text";
  const { steps, conflicts } = planInstall(manifest, "F0", base);
  assert.deepEqual(steps, []);
  assert.deepEqual(conflicts, [{ table: "时间安排", field: "revision", expected: "number", actual: "text" }]);
});

test("unrelated tables already in the Base are left alone", () => {
  const { steps } = planInstall(manifest, "F0", { tables: [{ name: "数据表", fields: [{ name: "文本", type: "text" }] }] });
  assert.ok(steps.every((s) => s.table !== "数据表"));
});

test("field specs use date-only format for date fields and single-select", () => {
  const { steps } = planInstall(manifest, "F0");
  const f = (table, name) => steps.find((s) => s.table === table && s.field?.name === name).field;
  assert.equal(f("目标任务", "due_date").style.format, "yyyy-MM-dd");
  assert.equal(f("时间安排", "start_at").style.format, "yyyy-MM-dd HH:mm");
  assert.equal(f("目标任务", "status").multiple, false);
  assert.equal(f("目标任务", "assignees").multiple, true);
  assert.equal(f("目标任务", "parent_goal").link_table, "目标任务");
});
