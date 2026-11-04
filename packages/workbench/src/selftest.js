// Write self-test for the Base SDK port. Run it only as a plugin of a TEST
// Base with synthetic data: it creates one time block on a goal you own,
// moves it, then leaves it cancelled. Nothing is deleted.

import { createBaseSdkPort, withTimeout } from "./base-sdk-port.js";
import { scheduleGoal, rescheduleBlock, cancelBlock, reconcile } from "../../rules/src/commands.js";
import { canScheduleGoal } from "../../rules/src/policy.js";
import { addDays, wallParts, wallToInstant } from "../../rules/src/time.js";

const SDK_URL = "https://cdn.jsdelivr.net/npm/@lark-base-open/js-sdk@1.0.2/+esm";
const TZ = "Asia/Shanghai";
const rows = document.querySelector("#rows");
const results = [];

function row(step, expected, actual, ok) {
  results.push({ step, expected, actual, ok });
  const tr = document.createElement("tr");
  for (const v of [step, expected, actual]) tr.append(Object.assign(document.createElement("td"), { textContent: v }));
  tr.append(Object.assign(document.createElement("td"), { textContent: ok ? "通过" : "失败", className: ok ? "ok" : "bad" }));
  rows.append(tr);
  return ok;
}
async function run() {
  let embedded;
  try { embedded = window.top !== window; } catch { embedded = true; }
  row("运行环境", "在多维表格插件（iframe）内", `${embedded ? "在 iframe 内" : "不在 iframe 内（直接打开的网页）"} · 来源 ${document.referrer ? new URL(document.referrer).hostname.replace(/^[^.]+/, "*") : "无"}`, embedded);
  const t0 = Date.now();
  const { bitable } = await withTimeout(import(SDK_URL), 15000, "加载 SDK");
  row("加载 SDK", "加载成功", `${Date.now() - t0} ms`, true);
  // Every schema call is timed separately and gets its own row.
  const port = createBaseSdkPort(bitable.base, {
    tz: TZ, callTimeoutMs: 15000,
    onStep: ({ what, ok, ms, error }) => row(what, "有响应", ok ? `${ms} ms` : error, ok),
  });
  await port.loadSchema();

  const userId = await withTimeout(bitable.bridge.getUserId(), 15000, "读取当前用户 getUserId");
  const actor = { ...(await port.resolveActor(userId)), source: "workbench_drag" };
  if (!row("识别当前用户", "在成员表中登记，角色不是访客", `${actor.label} · ${actor.role} · id 前缀 ${String(userId).slice(0, 3)}`, actor.registered && actor.role !== "guest")) {
    return row("停止", "—", "当前用户的 id 与成员表账号不匹配，无法继续写入测试", false);
  }

  const goal = (await port.listGoals()).find((g) => !g.archived && canScheduleGoal(actor, g, null));
  if (!row("找到可安排的目标", "至少一个自己负责的目标", goal ? goal.title : "无", Boolean(goal))) return;

  const day = addDays(wallParts(Date.now(), TZ).date, 1);
  const startMs = wallToInstant(`${day}T21:00`, TZ);
  const endMs = wallToInstant(`${day}T21:30`, TZ);
  const key = `selftest:${crypto.randomUUID()}`;

  const a = await scheduleGoal(port, actor, { goalId: goal.id, startMs, endMs, operationKey: key, timezone: TZ });
  row("新建时间块", "已保存（committed）", a.status + (a.reason ? ` ${a.reason}` : ""), a.status === "committed");
  if (!a.block) return;
  const back = await port.getTimeBlock(a.block.id);
  row("写后读回", "开始/结束/状态/关联目标/负责人/版本一致",
    back ? `${back.startMs === startMs && back.endMs === endMs ? "时间一致" : "时间不一致"} · ${back.state} · 目标${back.goalId === goal.id ? "一致" : "不一致"} · 负责人${back.ownerId === actor.userId ? "一致" : "不一致"} · rev ${back.revision}` : "读不到",
    Boolean(back && back.startMs === startMs && back.endMs === endMs && back.state === "planned" && back.goalId === goal.id && back.ownerId === actor.userId && back.revision === 1));

  const dup = await scheduleGoal(port, actor, { goalId: goal.id, startMs, endMs, operationKey: key, timezone: TZ });
  const sameKeyRows = (await port.rowsForOperation(key)).length;
  row("同键重试新建", "已存在（duplicate），仍只有 1 条", `${dup.status} · ${sameKeyRows} 条`, dup.status === "duplicate" && sameKeyRows === 1);

  const moveKey = `selftest-move:${crypto.randomUUID()}`;
  const moved = await rescheduleBlock(port, actor, { blockId: a.block.id, startMs: startMs + 1800_000, endMs: endMs + 1800_000, expectedRevision: 1, operationKey: moveKey });
  row("改期（版本 1）", "已保存，版本变为 2", `${moved.status} · rev ${moved.block?.revision}`, moved.status === "committed" && moved.block?.revision === 2);

  const movedAgain = await rescheduleBlock(port, actor, { blockId: a.block.id, startMs: startMs + 1800_000, endMs: endMs + 1800_000, expectedRevision: 1, operationKey: moveKey });
  row("同键重试改期", "已存在（duplicate）", movedAgain.status, movedAgain.status === "duplicate");

  const stale = await cancelBlock(port, actor, { blockId: a.block.id, expectedRevision: 1, operationKey: `selftest-cancel:${crypto.randomUUID()}` });
  const afterStale = await port.getTimeBlock(a.block.id);
  row("用旧版本取消", "版本冲突，记录未被改动", `${stale.status} · ${afterStale?.state} · rev ${afterStale?.revision}`, stale.status === "conflict" && afterStale?.state === "planned" && afterStale?.revision === 2);

  // Hand edit in the grid: times change, revision stays 2. A caller holding the
  // old snapshot must get a conflict instead of overwriting the edit.
  const seen = { startMs: afterStale.startMs, endMs: afterStale.endMs, state: afterStale.state };
  const s = await port.loadSchema();
  const fid = (name) => s.timeBlocks.fields.get(name).id;
  await s.timeBlocks.table.setRecord(a.block.id, { fields: { [fid("start_at")]: seen.startMs + 3600_000, [fid("end_at")]: seen.endMs + 3600_000 } });
  const handEdited = await port.getTimeBlock(a.block.id);
  const snap = await cancelBlock(port, actor, { blockId: a.block.id, expectedRevision: 2, expected: seen, operationKey: `selftest-snap:${crypto.randomUUID()}` });
  const afterSnap = await port.getTimeBlock(a.block.id);
  row("手工改表后用旧快照取消", "版本冲突，手工改动保留（版本号仍为 2）",
    `改表后 rev ${handEdited?.revision} · ${snap.status} · ${afterSnap?.state} · ${afterSnap?.startMs === seen.startMs + 3600_000 ? "时间为手工改后的值" : "时间不对"}`,
    handEdited?.revision === 2 && snap.status === "conflict" && afterSnap?.state === "planned" && afterSnap?.startMs === seen.startMs + 3600_000);

  const rec = await reconcile(port, key);
  const recMissing = await reconcile(port, `selftest-none:${crypto.randomUUID()}`);
  row("对账", "已写入的键 → 已存在；没写过的键 → 确认未保存", `${rec.status} / ${recMissing.status}`, rec.status === "duplicate" && recMissing.status === "not_committed");

  const done = await cancelBlock(port, actor, { blockId: a.block.id, expectedRevision: 2, operationKey: `selftest-cleanup:${crypto.randomUUID()}` });
  row("收尾：取消该测试块", "已保存，状态为已取消（不删除）", `${done.status} · ${done.block?.state}`, done.status === "committed" && done.block?.state === "cancelled");
}

run()
  .catch((e) => row("异常", "—", `${e.name}: ${e.message}`, false))
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    document.querySelector("#summary").textContent = `${results.length} 步，失败 ${failed} · ${new Date().toISOString()}`;
    document.querySelector("#copy").value = results.map((r) => `${r.ok ? "通过" : "失败"} | ${r.step} | ${r.actual}`).join("\n");
  });
