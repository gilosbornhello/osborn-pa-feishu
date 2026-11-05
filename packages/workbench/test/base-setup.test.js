import { test } from "node:test";
import assert from "node:assert/strict";
import { planBaseSetup, applyBaseSetup, toSdkField } from "../src/base-setup.js";
import { createBaseSdkPort } from "../src/base-sdk-port.js";
import { joinWorkspace } from "../../rules/src/commands.js";
import { MANIFEST } from "../../schema/manifest.js";

// Minimal fake of the SDK surface used by setup: tables, fields, records.
function emptyBase() {
  let n = 0;
  const id = (p) => `${p}${++n}`;
  const tables = [];
  const makeTable = (name, fields) => {
    const t = {
      id: id("tbl"), name, metas: [], records: new Map(),
      async getFieldMetaList() { return structuredClone(t.metas); },
      async addField(cfg) {
        if (t.metas.some((m) => m.name === cfg.name)) throw new Error("FieldNameRepeated");
        const property = cfg.type === 3 ? { options: cfg.property.options.map((o) => ({ id: id("opt"), name: o.name })) } : (cfg.property || {});
        t.metas.push({ id: id("fld"), name: cfg.name, type: cfg.type, property });
        return t.metas.at(-1).id;
      },
      async getRecords({ pageSize = 200 } = {}) { return { total: t.records.size, hasMore: false, records: [...t.records].slice(0, pageSize).map(([recordId, f]) => ({ recordId, fields: structuredClone(f) })) }; },
      async addRecord({ fields }) { const r = id("rec"); t.records.set(r, structuredClone(fields)); return r; },
      async setRecord(r, { fields }) { t.records.set(r, { ...t.records.get(r), ...structuredClone(fields) }); return r; },
    };
    for (const f of fields) t.addField(f);
    tables.push(t);
    return t;
  };
  makeTable("数据表", [{ type: 1, name: "文本" }]);
  return {
    tables,
    base: {
      async getTableMetaList() { return tables.map((t) => ({ id: t.id, name: t.name })); },
      async getTableById(tid) { const t = tables.find((x) => x.id === tid); if (!t) throw new Error(`no table ${tid}`); return t; },
      async addTable({ name, fields }) {
        if (tables.some((t) => t.name === name)) throw new Error("TableNameRepeated");
        const t = makeTable(name, fields);
        return { tableId: t.id, index: tables.length - 1 };
      },
    },
  };
}

test("empty Base: setup creates the F0 tables and fields; planning again finds nothing", async () => {
  const f = emptyBase();
  const before = await planBaseSetup(f.base, MANIFEST);
  assert.ok(before.steps.length > 30);
  const progress = [];
  const after = await applyBaseSetup(f.base, MANIFEST, { onStep: (p) => progress.push(p), newId: () => "inst-1" });
  assert.equal(after.steps.length, 0);
  assert.deepEqual(after.conflicts, []);
  assert.equal(progress.at(-1).done, before.steps.length);
  assert.deepEqual(f.tables.map((t) => t.name), ["数据表", "实例设置", "成员", "项目", "目标任务", "时间安排"]);
  const blocks = f.tables.find((t) => t.name === "时间安排");
  const goals = f.tables.find((t) => t.name === "目标任务");
  assert.equal(blocks.metas.find((m) => m.name === "goal").property.tableId, goals.id);
  assert.equal(blocks.metas[0].name, "title", "primary field first");
  assert.equal(f.tables.find((t) => t.name === "实例设置").records.size, MANIFEST.tables.find((t) => t.logical === "instance_settings").seed.length);
  // The workbench port can read the new Base right away.
  const port = createBaseSdkPort(f.base);
  await port.loadSchema();
  const actor = await port.resolveActor("ou_new");
  assert.equal(actor.registered, false);
  assert.deepEqual(await port.listGoals(), []);
});

test("running setup twice does not duplicate seed rows or fields", async () => {
  const f = emptyBase();
  await applyBaseSetup(f.base, MANIFEST);
  const again = await applyBaseSetup(f.base, MANIFEST);
  assert.equal(again.steps.length, 0);
  assert.equal(f.tables.find((t) => t.name === "实例设置").records.size, 7);
});

test("an existing field with the wrong type stops setup before any write", async () => {
  const f = emptyBase();
  await f.base.addTable({ name: "成员", fields: [{ type: 1, name: "display_label" }, { type: 2, name: "account" }] });
  const tablesBefore = f.tables.length;
  await assert.rejects(applyBaseSetup(f.base, MANIFEST), /成员\.account/);
  assert.equal(f.tables.length, tablesBefore);
});

test("toSdkField maps planner specs to SDK field configs", () => {
  const ids = new Map([["目标任务", "tblG"]]);
  assert.deepEqual(toSdkField({ name: "goal", type: "link", link_table: "目标任务" }, ids), { type: 18, name: "goal", property: { tableId: "tblG", multiple: false } });
  assert.equal(toSdkField({ name: "d", type: "datetime", style: { format: "yyyy-MM-dd" } }, ids).property.dateFormat, "yyyy-MM-dd");
  assert.deepEqual(toSdkField({ name: "s", type: "select", options: [{ name: "a" }] }, ids).property, { options: [{ name: "a" }] });
});

test("join: first person becomes admin, the next joins as member, joining twice is a duplicate", async () => {
  const f = emptyBase();
  await applyBaseSetup(f.base, MANIFEST);
  const port = createBaseSdkPort(f.base);
  const a = await port.resolveActor("ou_a");
  assert.equal(a.canJoin, true);
  const ja = await joinWorkspace(port, a);
  assert.equal(ja.status, "committed");
  assert.equal(ja.role, "admin");
  const a2 = await port.resolveActor("ou_a");
  assert.equal(a2.registered, true);
  assert.equal(a2.role, "admin");
  assert.equal((await joinWorkspace(port, a2)).status, "duplicate");
  const jb = await joinWorkspace(port, await port.resolveActor("ou_b"));
  assert.equal(jb.role, "member");
  assert.equal((await port.resolveActor("ou_b")).role, "member");
  assert.equal(f.tables.find((t) => t.name === "成员").records.size, 2);
});

test("join: a deactivated member cannot rejoin", async () => {
  const f = emptyBase();
  await applyBaseSetup(f.base, MANIFEST);
  const port = createBaseSdkPort(f.base);
  await joinWorkspace(port, await port.resolveActor("ou_a"));
  const members = f.tables.find((t) => t.name === "成员");
  const activeId = members.metas.find((m) => m.name === "active").id;
  for (const [rid, rec] of members.records) members.records.set(rid, { ...rec, [activeId]: false });
  const again = await port.resolveActor("ou_a");
  assert.equal(again.canJoin, false);
  assert.equal((await joinWorkspace(port, again)).reason, "member_inactive");
});
