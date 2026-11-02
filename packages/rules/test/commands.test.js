import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleGoal, rescheduleBlock, cancelBlock, completeBlock, reconcile } from "../src/commands.js";
import { createMemoryPort } from "../src/memory-port.js";
import { redactBlockForViewer } from "../src/policy.js";

const T = (s) => Date.parse(`2026-11-03T${s}:00+08:00`);
const seed = () => ({
  projects: [{ id: "p1", title: "合成项目甲" }],
  goals: [
    { id: "g1", title: "写方案初稿", ownerId: "u_alice", projectId: "p1", visibility: "project" },
    { id: "g2", title: "私人目标", ownerId: "u_alice", visibility: "private" },
    { id: "g3", title: "已归档", ownerId: "u_alice", archived: true },
  ],
});
const alice = { userId: "u_alice", role: "member", projectIds: ["p1"] };
const bob = { userId: "u_bob", role: "member", projectIds: ["p1"] };
const guest = { userId: "u_guest", role: "guest" };
const admin = { userId: "u_admin", role: "admin" };

test("Q06: drag goal to 09:00 then again to 11:00 → two blocks, goal untouched", async () => {
  const port = createMemoryPort(seed());
  const a = await scheduleGoal(port, alice, { goalId: "g1", startMs: T("09:00"), endMs: T("10:00"), operationKey: "op-1" });
  const b = await scheduleGoal(port, alice, { goalId: "g1", startMs: T("11:00"), endMs: T("12:00"), operationKey: "op-2" });
  assert.equal(a.status, "committed");
  assert.equal(b.status, "committed");
  assert.equal((await port.listTimeBlocks()).length, 2);
  const goal = await port.getGoal("g1");
  assert.equal(goal.archived, undefined);
  assert.equal(goal.revision, 1, "scheduling must not modify the goal record");
});

test("double drop / retry with the same operationKey creates one block", async () => {
  const port = createMemoryPort(seed());
  const args = { goalId: "g1", startMs: T("09:00"), endMs: T("10:00"), operationKey: "op-dup" };
  const [r1, r2] = await Promise.all([scheduleGoal(port, alice, args), scheduleGoal(port, alice, args)]);
  assert.deepEqual([r1.status, r2.status].sort(), ["committed", "duplicate"]);
  assert.equal((await port.listTimeBlocks()).length, 1);
});

test("negative control: a non-atomic 'query then insert' store duplicates under concurrency", async () => {
  const port = createMemoryPort(seed(), { nonAtomicCreate: true });
  const args = { goalId: "g1", startMs: T("09:00"), endMs: T("10:00"), operationKey: "op-race" };
  await Promise.all([scheduleGoal(port, alice, args), scheduleGoal(port, alice, args)]);
  assert.equal((await port.listTimeBlocks()).length, 2, "this is why a Base port must prove an atomic mechanism");
});

test("Q07: response lost after commit → unknown, reconcile finds it, retry does not duplicate", async () => {
  const port = createMemoryPort(seed());
  port.faults.loseNextResponse = true;
  const args = { goalId: "g1", startMs: T("09:00"), endMs: T("10:00"), operationKey: "op-lost" };
  const r = await scheduleGoal(port, alice, args);
  assert.equal(r.status, "unknown");
  const rec = await reconcile(port, "op-lost");
  assert.equal(rec.status, "duplicate");
  const retry = await scheduleGoal(port, alice, args);
  assert.equal(retry.status, "duplicate");
  assert.equal((await port.listTimeBlocks()).length, 1);
});

test("Q08: two tabs edit the same revision → second gets conflict, newer value kept", async () => {
  const port = createMemoryPort(seed());
  const { block } = await scheduleGoal(port, alice, { goalId: "g1", startMs: T("09:00"), endMs: T("10:00"), operationKey: "op-c" });
  const move = await rescheduleBlock(port, alice, { blockId: block.id, startMs: T("14:00"), endMs: T("15:00"), expectedRevision: 1, operationKey: "op-move" });
  const cancel = await cancelBlock(port, alice, { blockId: block.id, expectedRevision: 1, operationKey: "op-cancel" });
  assert.equal(move.status, "committed");
  assert.equal(cancel.status, "conflict");
  assert.equal(cancel.current.startMs, T("14:00"));
  assert.equal((await port.getTimeBlock(block.id)).state, "planned");
});

test("cancelling one of two blocks leaves the other; completing a block does not complete the goal", async () => {
  const port = createMemoryPort(seed());
  const a = await scheduleGoal(port, alice, { goalId: "g1", startMs: T("09:00"), endMs: T("10:00"), operationKey: "k1" });
  const b = await scheduleGoal(port, alice, { goalId: "g1", startMs: T("11:00"), endMs: T("12:00"), operationKey: "k2" });
  await cancelBlock(port, alice, { blockId: a.block.id, expectedRevision: 1, operationKey: "k3" });
  await completeBlock(port, alice, { blockId: b.block.id, expectedRevision: 1, operationKey: "k4" });
  assert.equal((await port.getTimeBlock(a.block.id)).state, "cancelled");
  assert.equal((await port.getTimeBlock(b.block.id)).state, "done");
  assert.equal((await port.getGoal("g1")).done, undefined);
});

test("validation: end must be after start; empty operation key rejected; archived goal rejected", async () => {
  const port = createMemoryPort(seed());
  assert.equal((await scheduleGoal(port, alice, { goalId: "g1", startMs: T("10:00"), endMs: T("09:00"), operationKey: "x" })).reason, "end_not_after_start");
  assert.equal((await scheduleGoal(port, alice, { goalId: "g1", startMs: T("09:00"), endMs: T("10:00") })).reason, "operation_key_required");
  assert.equal((await scheduleGoal(port, alice, { goalId: "g3", startMs: T("09:00"), endMs: T("10:00"), operationKey: "y" })).reason, "goal_not_found_or_archived");
  assert.equal((await port.listTimeBlocks()).length, 0);
});

test("permissions: other member cannot schedule a private goal or edit Alice's block; guest cannot write", async () => {
  const port = createMemoryPort(seed());
  assert.equal((await scheduleGoal(port, bob, { goalId: "g2", startMs: T("09:00"), endMs: T("10:00"), operationKey: "b1" })).reason, "forbidden");
  assert.equal((await scheduleGoal(port, guest, { goalId: "g1", startMs: T("09:00"), endMs: T("10:00"), operationKey: "gu" })).reason, "forbidden");
  const { block } = await scheduleGoal(port, alice, { goalId: "g1", startMs: T("09:00"), endMs: T("10:00"), operationKey: "a1" });
  assert.equal((await cancelBlock(port, bob, { blockId: block.id, expectedRevision: 1, operationKey: "b2" })).reason, "forbidden");
  assert.equal((await cancelBlock(port, admin, { blockId: block.id, expectedRevision: 1, operationKey: "ad" })).status, "committed");
});

test("busy/free redaction hides title and goal from non-owners", () => {
  const block = { id: "tb", ownerId: "u_alice", title: "机密", goalId: "g2", startMs: 1, endMs: 2, allDay: false };
  assert.deepEqual(redactBlockForViewer(bob, block), { id: "tb", ownerId: "u_alice", startMs: 1, endMs: 2, allDay: false, busy: true });
  assert.equal(redactBlockForViewer(alice, block).title, "机密");
});
