// Synthetic demo data only. Names are fictional; no real people or records.
import { addDays } from "../../rules/src/time.js";
import { slotToRange } from "./slots.js";

export const ACTORS = Object.freeze({
  alice: { userId: "u_alice", label: "林晓（成员）", role: "member", projectIds: ["p_launch", "p_ops"] },
  bob: { userId: "u_bob", label: "周航（成员）", role: "member", projectIds: ["p_launch"] },
  lead: { userId: "u_lead", label: "陈一（项目负责人）", role: "project_admin", projectIds: ["p_launch", "p_ops"], adminProjectIds: ["p_launch"] },
  guest: { userId: "u_guest", label: "访客", role: "guest" },
  admin: { userId: "u_admin", label: "实例管理员", role: "admin" },
});

export function buildSeed(monday, tz) {
  const goal = (id, title, extra) => ({
    id, title, ownerId: "u_alice", visibility: "project", bucket: "this_week",
    importanceManual: 50, urgencyManual: 35, sampleKey: "demo-v1", ...extra,
  });
  const block = (id, goalId, title, ownerId, day, slot, minutes = 60) => {
    const { startMs } = slotToRange(addDays(monday, day), slot, tz);
    return { id, goalId, title, ownerId, startMs, endMs: startMs + minutes * 60_000, allDay: false, timezone: tz, state: "planned", operationKey: `seed-${id}`, sampleKey: "demo-v1" };
  };
  return {
    projects: [
      { id: "p_launch", title: "合成项目：新品试点" },
      { id: "p_ops", title: "合成项目：内部流程改进" },
    ],
    goals: [
      goal("g1", "完成试点方案初稿", { projectId: "p_launch", bucket: "today", importanceManual: 85, urgencyManual: 70 }),
      goal("g2", "约三位种子用户访谈", { projectId: "p_launch", bucket: "this_week", importanceManual: 70, urgencyManual: 45 }),
      goal("g3", "整理周复盘模板", { projectId: "p_ops", bucket: "next_week", importanceManual: 40, urgencyManual: 30 }),
      goal("g4", "个人：读完一本书", { visibility: "private", bucket: "this_month", importanceManual: 60, urgencyManual: 10 }),
      goal("g5", "评审定价假设", { projectId: "p_launch", ownerId: "u_bob", bucket: "today", importanceManual: 75, urgencyManual: 55 }),
      goal("g6", "清理过期任务", { bucket: "inbox", importanceManual: 30, urgencyManual: 60 }),
    ],
    timeBlocks: [
      block("tb_1", "g2", "约三位种子用户访谈", "u_alice", 1, 6, 90),
      block("tb_2", "g5", "评审定价假设", "u_bob", 1, 6, 60),
    ],
    operations: [["seed-tb_1", "tb_1"], ["seed-tb_2", "tb_2"]],
  };
}
