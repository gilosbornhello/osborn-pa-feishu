import { test } from "node:test";
import assert from "node:assert/strict";
import { createBaseSdkPort, canonicalByOperation, readText, readSelect } from "../src/base-sdk-port.js";
import { scheduleGoal, rescheduleBlock, cancelBlock, reconcile } from "../../rules/src/commands.js";

// Fake of the Base JS SDK subset the port uses, with the SDK's cell shapes:
// text = segments, select = {id,text}, user = [{id,name}], link = {recordIds,tableId}, datetime = ms.
function fakeBase() {
  let n = 0;
  const id = (p) => `${p}${String(++n).padStart(4, "0")}`;
  const tables = new Map();
  const table = (name, fields) => {
    const metas = fields.map(([fname, type, options]) => ({
      id: id("fld"), name: fname, type, property: options ? { options: options.map((o) => ({ id: id("opt"), name: o })) } : {},
    }));
    const t = {
      id: id("tbl"), name, metas, records: new Map(), hooks: {},
      async getFieldMetaList() { return structuredClone(metas); },
      async getRecords({ pageSize = 200, pageToken } = {}) {
        const all = [...t.records.entries()].map(([recordId, f]) => ({ recordId, fields: structuredClone(f) }));
        const start = pageToken ? all.findIndex((r) => r.recordId === pageToken) : 0;
        const page = all.slice(start, start + pageSize);
        const next = all[start + pageSize];
        return { total: all.length, hasMore: Boolean(next), pageToken: next?.recordId, records: page };
      },
      async addRecord({ fields: f }) {
        if (t.hooks.beforeAdd) await t.hooks.beforeAdd();
        const rid = t.hooks.nextId ? t.hooks.nextId() : id("rec");
        t.records.set(rid, structuredClone(f));
        return rid;
      },
      async setRecord(rid, { fields: f }) {
        if (t.hooks.beforeSet) await t.hooks.beforeSet(rid);
        t.records.set(rid, { ...t.records.get(rid), ...structuredClone(f) });
        return rid;
      },
    };
    tables.set(name, t);
    return t;
  };
  const fid = (t, name) => t.metas.find((m) => m.name === name).id;
  const opt = (t, name, text) => ({ id: t.metas.find((m) => m.name === name).property.options.find((o) => o.name === text).id, text });
  const txt = (s) => [{ type: "text", text: s }];

  const members = table("成员", [["display_label", 1], ["business_id", 1], ["account", 11], ["product_role", 3, ["admin", "project_admin", "member", "guest"]], ["active", 7]]);
  const projects = table("项目", [["title", 1], ["business_id", 1], ["owner", 11], ["attention_state", 3, ["active", "watch", "parked", "archived"]], ["revision", 2]]);
  const goals = table("目标任务", [["title", 1], ["business_id", 1], ["project", 18], ["accountable_owner", 11], ["assignees", 11], ["visibility", 3, ["private", "project"]], ["status", 3, ["not_started", "in_progress", "done", "stalled"]], ["bucket", 3, ["inbox", "today", "this_week"]], ["due_date", 5], ["archived", 7], ["importance_manual", 2], ["urgency_manual", 2], ["revision", 2]]);
  const blocks = table("时间安排", [["title", 1], ["business_id", 1], ["goal", 18], ["owner", 11], ["start_at", 5], ["end_at", 5], ["all_day", 7], ["timezone", 1], ["state", 3, ["planned", "done", "cancelled"]], ["operation_key", 1], ["last_operation_key", 1], ["source", 3, ["workbench_drag", "workbench_form", "import"]], ["revision", 2]]);
  table("数据表", [["文本", 1]]);

  const me = { id: "ou_me", name: "测试用户" };
  members.records.set("recM", { [fid(members, "display_label")]: txt("我"), [fid(members, "account")]: [me], [fid(members, "product_role")]: opt(members, "product_role", "member"), [fid(members, "active")]: true });
  projects.records.set("recP", { [fid(projects, "title")]: txt("合成项目"), [fid(projects, "owner")]: [me], [fid(projects, "attention_state")]: opt(projects, "attention_state", "active"), [fid(projects, "revision")]: 1 });
  goals.records.set("recG", {
    [fid(goals, "title")]: txt("合成目标"), [fid(goals, "project")]: { text: "合成项目", type: "text", recordIds: ["recP"], tableId: projects.id },
    [fid(goals, "accountable_owner")]: [me], [fid(goals, "visibility")]: opt(goals, "visibility", "project"),
    [fid(goals, "bucket")]: opt(goals, "bucket", "today"), [fid(goals, "archived")]: false,
    [fid(goals, "importance_manual")]: 80, [fid(goals, "urgency_manual")]: 40, [fid(goals, "revision")]: 1,
  });
  return {
    me, tables, fid, txt,
    base: { async getTableByName(name) { const t = tables.get(name); if (!t) throw new Error(`no table ${name}`); return t; } },
  };
}

const T = (s) => Date.parse(`2026-11-04T${s}:00+08:00`);
const setup = async () => {
  const f = fakeBase();
  const port = createBaseSdkPort(f.base);
  const actor = { ...(await port.resolveActor(f.me.id)), source: "workbench_drag" };
  return { f, port, actor, blocks: f.tables.get("时间安排") };
};

test("codec reads SDK cell shapes", () => {
  assert.equal(readText([{ type: "text", text: "甲" }, { type: "url", text: "乙", link: "x" }]), "甲乙");
  assert.equal(readText(null), "");
  assert.equal(readSelect({ id: "o1", text: "today" }), "today");
  assert.equal(readSelect(null), null);
});

test("resolves the viewing user from the members table; unknown users are read-only", async () => {
  const { f, port, actor } = await setup();
  assert.equal(actor.role, "member");
  assert.deepEqual(actor.projectIds, ["recP"]);
  assert.equal(actor.registered, true);
  const stranger = await port.resolveActor("ou_other");
  assert.equal(stranger.role, "guest");
  assert.equal(stranger.registered, false);
  assert.ok(f);
});

test("reads goals with links, owners, selects and numbers", async () => {
  const { port } = await setup();
  const [g] = await port.listGoals();
  assert.deepEqual(
    { id: g.id, title: g.title, ownerId: g.ownerId, projectId: g.projectId, visibility: g.visibility, bucket: g.bucket, importanceManual: g.importanceManual, archived: g.archived },
    { id: "recG", title: "合成目标", ownerId: "ou_me", projectId: "recP", visibility: "project", bucket: "today", importanceManual: 80, archived: false },
  );
});

test("drag a goal: one block written in SDK shapes, read back, goal untouched", async () => {
  const { f, port, actor, blocks } = await setup();
  const r = await scheduleGoal(port, actor, { goalId: "recG", startMs: T("09:00"), endMs: T("10:00"), operationKey: "drag:1" });
  assert.equal(r.status, "committed");
  assert.equal(blocks.records.size, 1);
  const [cells] = [...blocks.records.values()];
  assert.deepEqual(cells[f.fid(blocks, "title")], f.txt("合成目标"));
  assert.deepEqual(cells[f.fid(blocks, "owner")], [{ id: "ou_me" }]);
  assert.deepEqual(cells[f.fid(blocks, "goal")].recordIds, ["recG"]);
  assert.equal(cells[f.fid(blocks, "start_at")], T("09:00"));
  assert.equal(cells[f.fid(blocks, "state")].text, "planned");
  assert.equal(cells[f.fid(blocks, "source")].text, "workbench_drag");
  assert.equal(r.block.revision, 1);
  assert.equal((await port.getGoal("recG")).revision, 1);
});

test("same operation key again → duplicate, still one row", async () => {
  const { port, actor, blocks } = await setup();
  const args = { goalId: "recG", startMs: T("09:00"), endMs: T("10:00"), operationKey: "form:1" };
  await scheduleGoal(port, actor, args);
  assert.equal((await scheduleGoal(port, actor, args)).status, "duplicate");
  assert.equal(blocks.records.size, 1);
});

test("two clients race on one key: both rows exist, every reader sees one, loser told duplicate", async () => {
  const { port, actor, blocks, f } = await setup();
  const fieldOp = f.fid(blocks, "operation_key");
  const ids = ["rec0001", "rec9999"]; // the other client gets the lower id
  blocks.hooks.nextId = () => ids.shift();
  // The other client inserts the same key between our pre-check and our insert.
  blocks.hooks.beforeAdd = async () => {
    blocks.hooks.beforeAdd = null;
    blocks.records.set(ids.shift(), { [fieldOp]: f.txt("drag:race"), [f.fid(blocks, "start_at")]: T("09:00"), [f.fid(blocks, "end_at")]: T("10:00") });
  };
  const r = await scheduleGoal(port, actor, { goalId: "recG", startMs: T("09:00"), endMs: T("10:00"), operationKey: "drag:race" });
  assert.equal(r.status, "duplicate");
  assert.equal(r.block.id, "rec0001");
  assert.equal(blocks.records.size, 2, "atomicCreate=false: the platform allowed a second row");
  assert.equal((await port.listTimeBlocks()).length, 1, "reads converge to the canonical row");
});

test("reschedule with current revision commits and records last_operation_key", async () => {
  const { port, actor } = await setup();
  const { block } = await scheduleGoal(port, actor, { goalId: "recG", startMs: T("09:00"), endMs: T("10:00"), operationKey: "drag:2" });
  const r = await rescheduleBlock(port, actor, { blockId: block.id, startMs: T("11:00"), endMs: T("12:00"), expectedRevision: 1, operationKey: "move:1" });
  assert.equal(r.status, "committed");
  assert.equal(r.block.revision, 2);
  assert.equal(r.block.startMs, T("11:00"));
  const again = await rescheduleBlock(port, actor, { blockId: block.id, startMs: T("11:00"), endMs: T("12:00"), expectedRevision: 1, operationKey: "move:1" });
  assert.equal(again.status, "duplicate", "retrying the same update is recognised");
});

test("stale revision → conflict before writing; newer value kept", async () => {
  const { port, actor } = await setup();
  const { block } = await scheduleGoal(port, actor, { goalId: "recG", startMs: T("09:00"), endMs: T("10:00"), operationKey: "drag:3" });
  await rescheduleBlock(port, actor, { blockId: block.id, startMs: T("11:00"), endMs: T("12:00"), expectedRevision: 1, operationKey: "move:other" });
  const r = await cancelBlock(port, actor, { blockId: block.id, expectedRevision: 1, operationKey: "cancel:stale" });
  assert.equal(r.status, "conflict");
  const now = await port.getTimeBlock(block.id);
  assert.equal(now.state, "planned");
  assert.equal(now.startMs, T("11:00"));
});

test("concurrent writer detected on read-back → conflict", async () => {
  const { port, actor, blocks, f } = await setup();
  const { block } = await scheduleGoal(port, actor, { goalId: "recG", startMs: T("09:00"), endMs: T("10:00"), operationKey: "drag:4" });
  const orig = blocks.setRecord;
  blocks.setRecord = async (rid, v) => {
    await orig(rid, v);
    await orig(rid, { fields: { [f.fid(blocks, "last_operation_key")]: f.txt("move:theirs"), [f.fid(blocks, "revision")]: 2 } });
    return rid;
  };
  const r = await cancelBlock(port, actor, { blockId: block.id, expectedRevision: 1, operationKey: "cancel:mine" });
  assert.equal(r.status, "conflict");
});

test("faults: lost response reconciles to duplicate; failure before commit reconciles to not_committed", async () => {
  const { port, actor, blocks } = await setup();
  port.faults.loseNextResponse = true;
  const lost = await scheduleGoal(port, actor, { goalId: "recG", startMs: T("09:00"), endMs: T("10:00"), operationKey: "drag:lost" });
  assert.equal(lost.status, "unknown");
  assert.equal((await reconcile(port, "drag:lost")).status, "duplicate");
  port.faults.failNextBeforeCommit = true;
  const failed = await scheduleGoal(port, actor, { goalId: "recG", startMs: T("13:00"), endMs: T("14:00"), operationKey: "drag:fail" });
  assert.equal(failed.status, "unknown");
  assert.equal((await reconcile(port, "drag:fail")).status, "not_committed");
  assert.equal(blocks.records.size, 1);
});

test("an SDK error during a write is reported as unknown, not as failure", async () => {
  const { port, actor, blocks } = await setup();
  blocks.addRecord = async () => { throw new Error("network"); };
  const r = await scheduleGoal(port, actor, { goalId: "recG", startMs: T("09:00"), endMs: T("10:00"), operationKey: "drag:net" });
  assert.equal(r.status, "unknown");
  assert.match(r.reason, /network/);
});

test("canonical row is the lowest record id", () => {
  const m = canonicalByOperation([{ id: "rec5", operationKey: "k" }, { id: "rec2", operationKey: "k" }, { id: "rec9", operationKey: "j" }]);
  assert.equal(m.get("k").id, "rec2");
  assert.equal(m.get("j").id, "rec9");
});
