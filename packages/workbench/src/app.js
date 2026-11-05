// Workbench prototype. Three distinct interactions, never substituted for one another:
//   1. drag a goal from the right panel into a calendar slot   → scheduleGoal (source: workbench_drag)
//   2. drag an existing block inside the calendar               → rescheduleBlock
//   3. click "安排…" and fill in a time                         → scheduleGoal (source: workbench_form)
// Storage, chosen by the address:
//   default        in-memory reference port backed by localStorage (synthetic
//                  data; tabs share one store, a stale tab gets a conflict).
//   ?data=base     the current Base through the Base JS SDK, as the viewing
//                  user (only inside a Base plugin). Never falls back to the
//                  local store if the SDK is unavailable.

import { createMemoryPort } from "../../rules/src/memory-port.js";
import { scheduleGoal, rescheduleBlock, cancelBlock, completeBlock, reconcile, createGoal, joinWorkspace } from "../../rules/src/commands.js";
import { canReadGoal, redactBlockForViewer } from "../../rules/src/policy.js";
import { scoreGoal, compareGoals } from "../../rules/src/priority.js";
import { BUCKETS } from "../../rules/src/period-shift.js";
import { addDays, wallParts, wallToInstant } from "../../rules/src/time.js";
import { GRID, weekDays, slotsPerDay, slotToRange, blockPlacement, moveRange } from "./slots.js";
import { ACTORS, buildSeed } from "./seed.js";
import { createBaseSdkPort, withTimeout, loadBitable, embeddedBitable } from "./base-sdk-port.js";
import { planBaseSetup, applyBaseSetup } from "./base-setup.js";
import { MANIFEST } from "../../schema/manifest.js";

const TZ = "Asia/Shanghai";
const STORE_KEY = "osborn-pa-workbench:v1";
const GOAL_MIME = "application/x-osborn-goal";
const BLOCK_MIME = "application/x-osborn-block";
const BUCKET_LABELS = { inbox: "Inbox", today: "今日", tomorrow: "明日", this_week: "本周", next_week: "下周", this_month: "本月", next_month: "下月", this_year: "今年", lifetime: "长期" };
const STATUS_LABELS = { committed: "已保存", duplicate: "已存在（未重复创建）", conflict: "版本冲突，未覆盖", rejected: "被拒绝", unknown: "结果待确认", not_committed: "确认未保存" };

const today = wallParts(Date.now(), TZ).date;
let viewMonday = weekDays(today)[0];
let actorKey = "alice";
let goalView = "board";
const pendingDrops = new Map(); // operationKey -> {goalId, startMs, endMs, title}

const store = {
  load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { return null; } },
  save(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } },
};
// Inside the table-view extension there is no query string: always Base mode.
const MODE = embeddedBitable() || new URLSearchParams(location.search).get("data") === "base" ? "base" : "local";
let port = MODE === "local" ? createMemoryPort(buildSeed(weekDays(today)[0], TZ), { store, faults: { latencyMs: 250 } }) : null;
let baseActor = null; // resolved viewing user in base mode

const $ = (sel) => document.querySelector(sel);
const actor = () => ({ ...(baseActor || ACTORS[actorKey]), source: "workbench" });
const fmtTime = (ms) => { const p = wallParts(ms, TZ); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };
const newKey = (prefix) => `${prefix}:${crypto.randomUUID()}`;
// Receipts use the same timezone as the calendar, not the browser's.
const fmtClock = (ms) => { const p = wallParts(ms, TZ); return [p.hour, p.minute, p.second].map((n) => String(n).padStart(2, "0")).join(":"); };
const snapshotOf = (b) => ({ startMs: b.startMs, endMs: b.endMs, state: b.state });

function logReceipt(label, r, retry) {
  // retry() re-sends the same operation key and resolves to a receipt.
  const li = document.createElement("li");
  li.className = `st-${r.status}`;
  li.dataset.status = r.status;
  li.textContent = `${fmtClock(Date.now())} ${label} → ${STATUS_LABELS[r.status] || r.status}${r.reason ? `（${r.reason}）` : ""} · key=${(r.operationKey || "").slice(0, 18)}…`;
  if (r.status === "unknown") {
    const rec = document.createElement("button");
    rec.textContent = "对账";
    const again = document.createElement("button");
    again.textContent = "用同一键重试";
    const settle = (x) => { if (x.status !== "unknown") { rec.disabled = again.disabled = true; } };
    rec.onclick = async () => {
      const x = await reconcile(port, r.operationKey);
      logReceipt("对账", x);
      settle(x);
      if (x.status !== "unknown") pendingDrops.delete(r.operationKey);
      render();
    };
    again.onclick = async () => settle(await retry());
    li.append(rec, again);
  }
  $("#log").prepend(li);
}

// Runs one command with the fault checkboxes armed for it alone: whatever the
// outcome (even a rejection before storage), the faults are cleared afterwards
// so they never leak into a later, unrelated save. exec() must reuse its key.
async function runCommand(label, exec) {
  port.faults.loseNextResponse = $("#lose").checked;
  port.faults.failNextBeforeCommit = $("#failBefore").checked;
  $("#lose").checked = $("#failBefore").checked = false;
  let r;
  try { r = await exec(); } finally { port.faults.loseNextResponse = port.faults.failNextBeforeCommit = false; }
  logReceipt(label, r, () => runCommand(label, exec));
  render();
  return r;
}

async function runSchedule(goal, range, operationKey, source) {
  pendingDrops.set(operationKey, { goalId: goal.id, ...range, title: goal.title });
  render();
  return runCommand(`${source === "workbench_drag" ? "拖入" : "表单安排"}「${goal.title}」${fmtTime(range.startMs)}`, async () => {
    const r = await scheduleGoal(port, { ...actor(), source }, { goalId: goal.id, ...range, operationKey, timezone: TZ });
    if (r.status !== "unknown") pendingDrops.delete(operationKey);
    return r;
  });
}

// Quick-add: the goal is owned by the current viewer. Hidden for read-only viewers.
function canCreateGoals() {
  const a = actor();
  return Boolean(a.userId) && a.role !== "guest" && a.registered !== false;
}
function setupNewGoal() {
  const f = $("#newGoal");
  for (const b of BUCKETS) f.bucket.append(new Option(BUCKET_LABELS[b], b));
  f.bucket.value = "today";
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = f.title.value.trim();
    if (!title) return;
    const operationKey = newKey("goal");
    const input = { title, bucket: f.bucket.value, visibility: f.private.checked ? "private" : "project", operationKey };
    $("#newGoalSubmit").disabled = true;
    try {
      const r = await runCommand(`新建目标「${title}」`, () => createGoal(port, actor(), input));
      if (r.status === "committed" || r.status === "duplicate") { f.title.value = ""; f.private.checked = false; }
    } finally { $("#newGoalSubmit").disabled = false; }
  });
}

// Narrow widths only (the toggle is hidden by CSS otherwise): fold the goals
// panel so the calendar gets the full height. Dragging a goal needs it open.
function setGoalsCollapsed(collapsed) {
  const btn = $("#goalsToggle");
  $(".layout").classList.toggle("goalsCollapsed", collapsed);
  $("#goalBody").hidden = collapsed;
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.textContent = collapsed ? "展开目标" : "收起目标";
}
function setupGoalsToggle() {
  $("#goalsToggle").onclick = () => setGoalsCollapsed(!$("#goalBody").hidden);
}

function renderGoals(goals) {
  const visible = goals.filter((g) => !g.archived && canReadGoal(actor(), g, null))
    .map((g) => ({ ...g, ...scoreGoal(g) }));
  const list = $("#goalList");
  list.replaceChildren();
  const card = (g) => {
    const el = document.createElement("div");
    el.className = "goal";
    el.draggable = true;
    el.dataset.goalId = g.id;
    el.innerHTML = `<div><div class="title"></div><div class="meta"><span class="tier">${g.tier}</span> 分 ${g.score} · ${BUCKET_LABELS[g.bucket] || g.bucket}${g.visibility === "private" ? " · 私有" : ""}</div></div>`;
    el.querySelector(".title").textContent = g.title; // titles are data, never markup
    const btn = document.createElement("button");
    btn.textContent = "安排…";
    btn.onclick = () => openForm(g);
    el.append(btn);
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(GOAL_MIME, g.id);
      e.dataTransfer.setData("text/plain", g.title);
      e.dataTransfer.effectAllowed = "copy";
    });
    return el;
  };
  if (goalView === "board") {
    for (const b of BUCKETS) {
      const items = visible.filter((g) => (g.bucket || "inbox") === b).sort(compareGoals);
      if (!items.length) continue;
      const sec = document.createElement("div");
      sec.className = "bucket";
      sec.innerHTML = `<h4>${BUCKET_LABELS[b]}</h4>`;
      items.forEach((g) => sec.append(card(g)));
      list.append(sec);
    }
  } else {
    visible.sort(compareGoals).forEach((g) => list.append(card(g)));
  }
  $("#newGoal").hidden = !canCreateGoals();
  if (!visible.length) {
    list.textContent = canCreateGoals()
      ? "还没有你能看到的目标。在上面输入一个目标名称并点“添加”，它就会出现在这里，然后可以拖进日历。"
      : "当前身份没有可见目标（不是加载失败）。";
  }
}

function renderCalendar(blocks) {
  const days = weekDays(viewMonday);
  $("#range").textContent = `${days[0].slice(5)} – ${days[6].slice(5)}`;
  const grid = $("#grid");
  grid.replaceChildren();
  grid.append(Object.assign(document.createElement("div"), { className: "dayHead" }));
  const wd = ["一", "二", "三", "四", "五", "六", "日"];
  days.forEach((d, i) => grid.append(Object.assign(document.createElement("div"), { className: `dayHead${d === today ? " today" : ""}`, textContent: `周${wd[i]} ${d.slice(5)}` })));
  const n = slotsPerDay();
  const hours = document.createElement("div");
  hours.className = "hours";
  hours.style.height = `${n * 22}px`;
  for (let h = GRID.startHour; h <= GRID.endHour; h++) {
    const l = document.createElement("div");
    l.className = "hourLabel";
    l.style.top = `${((h - GRID.startHour) * 60 / GRID.slotMinutes) * 22}px`;
    l.textContent = `${h}:00`;
    hours.append(l);
  }
  grid.append(hours);
  const me = actor();
  days.forEach((date) => {
    const col = document.createElement("div");
    col.className = "day";
    col.dataset.date = date;
    for (let i = 0; i < n; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      slot.dataset.date = date;
      slot.dataset.slot = String(i);
      slot.addEventListener("dragover", (e) => {
        const t = e.dataTransfer.types;
        if (t.includes(GOAL_MIME) || t.includes(BLOCK_MIME)) { e.preventDefault(); slot.classList.add("over"); }
      });
      slot.addEventListener("dragleave", () => slot.classList.remove("over"));
      slot.addEventListener("drop", (e) => onDrop(e, date, i));
      col.append(slot);
    }
    grid.append(col);
  });
  const cols = grid.querySelectorAll(".day");
  const all = [...blocks, ...[...pendingDrops.entries()].map(([k, p]) => ({ id: k, pending: true, ownerId: me.userId, state: "planned", ...p }))];
  const placed = all
    .map((raw) => raw.pending ? raw : redactBlockForViewer(me, raw))
    .filter(Boolean)
    .map((b) => ({ b, p: blockPlacement(b, days, TZ) }))
    .filter((x) => x.p)
    .sort((x, y) => x.b.startMs - y.b.startMs);
  const lanesByDay = new Map(); // dayIndex -> array of lane end times
  for (const x of placed) {
    const lanes = lanesByDay.get(x.p.dayIndex) || [];
    let lane = lanes.findIndex((end) => end <= x.b.startMs);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = x.b.endMs;
    lanesByDay.set(x.p.dayIndex, lanes);
    x.lane = lane;
  }
  for (const { b, p, lane } of placed) {
    const laneCount = lanesByDay.get(p.dayIndex).length;
    const el = document.createElement("div");
    el.className = `block${b.busy ? " busy" : ""}${b.pending ? " pending" : ""} ${b.state || ""}`;
    el.style.top = `${p.top * 100}%`;
    el.style.height = `${Math.max(p.height * 100, 2)}%`;
    el.style.left = `calc(${(lane / laneCount) * 100}% + 2px)`;
    el.style.width = `calc(${100 / laneCount}% - 4px)`;
    el.style.right = "auto";
    el.dataset.blockId = b.id;
    const title = document.createElement("span");
    title.textContent = b.busy ? "忙碌" : b.pending ? `保存中：${b.title}` : b.title;
    const small = document.createElement("small");
    small.textContent = `${fmtTime(b.startMs)}–${fmtTime(b.endMs)}${p.crossesMidnight ? " (+1)" : ""}${b.state === "done" ? " · 已完成" : ""}`;
    el.append(title, small);
    if (!b.busy && !b.pending && b.state !== "cancelled") {
      el.draggable = true;
      el.addEventListener("dragstart", (e) => { e.dataTransfer.setData(BLOCK_MIME, b.id); e.dataTransfer.effectAllowed = "move"; });
      el.addEventListener("click", (e) => openBlockMenu(e, b));
    }
    cols[p.dayIndex].append(el);
  }
}

async function onDrop(e, date, slotIndex) {
  e.preventDefault();
  e.currentTarget.classList.remove("over");
  const goalId = e.dataTransfer.getData(GOAL_MIME);
  const blockId = e.dataTransfer.getData(BLOCK_MIME);
  if (goalId) {
    const goal = await port.getGoal(goalId);
    if (!goal) return logReceipt("拖入", { status: "rejected", reason: "goal_not_found" });
    await runSchedule(goal, slotToRange(date, slotIndex, TZ), newKey("drag"), "workbench_drag");
  } else if (blockId) {
    const block = await port.getTimeBlock(blockId);
    const range = moveRange(block, date, slotIndex, TZ);
    const args = { blockId, ...range, expectedRevision: block.revision, expected: snapshotOf(block), operationKey: newKey("move") };
    await runCommand(`改期「${block.title}」→ ${date.slice(5)} ${fmtTime(range.startMs)}`, () => rescheduleBlock(port, actor(), args));
  }
}

const blockVersion = (b) => `${b.revision}|${b.startMs}|${b.endMs}|${b.state}`;
// A menu opened on a block that has since moved, changed or disappeared is stale: close it.
function closeStaleMenu(blocks) {
  const pop = document.querySelector(".popover[data-block-id]");
  if (!pop) return;
  const b = blocks.find((x) => x.id === pop.dataset.blockId);
  if (!b || blockVersion(b) !== pop.dataset.version) pop.remove();
}

function openBlockMenu(e, b) {
  document.querySelector(".popover")?.remove();
  const pop = document.createElement("div");
  pop.className = "popover";
  pop.dataset.blockId = b.id;
  pop.dataset.version = blockVersion(b);
  pop.style.left = `${e.clientX}px`;
  pop.style.top = `${e.clientY}px`;
  const act = (label, fn, prefix) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = async () => {
      pop.remove();
      const args = { blockId: b.id, expectedRevision: b.revision, expected: snapshotOf(b), operationKey: newKey(prefix) };
      await runCommand(`${label}「${b.title}」`, () => fn(port, actor(), args));
    };
    pop.append(btn);
  };
  act("完成", completeBlock, "done");
  act("取消安排", cancelBlock, "cancel");
  const close = document.createElement("button");
  close.textContent = "关闭";
  close.onclick = () => pop.remove();
  pop.append(close);
  document.body.append(pop);
}

let formState = null;
function openForm(goal) {
  // The operation key is minted when the form opens, so a double submit reuses it.
  formState = { goal, operationKey: newKey("form") };
  const f = $("#scheduleForm");
  $("#formTitle").textContent = `安排：${goal.title}`;
  f.date.value = today;
  f.start.value = "09:00";
  f.end.value = "10:00";
  $("#formError").textContent = "";
  $("#form").showModal();
}
$("#scheduleForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok" || !formState) return;
  e.preventDefault();
  const f = e.target;
  const range = { startMs: wallToInstant(`${f.date.value}T${f.start.value}`, TZ), endMs: wallToInstant(`${f.date.value}T${f.end.value}`, TZ) };
  const r = await runSchedule(formState.goal, range, formState.operationKey, "workbench_form");
  if (r.status === "rejected") { $("#formError").textContent = `未保存：${r.reason}`; return; }
  $("#form").close();
  viewMonday = weekDays(f.date.value)[0];
  formState = null;
  render();
});

async function render() {
  if (!port) return;
  const [goals, blocks] = await Promise.all([port.listGoals(), port.listTimeBlocks()]);
  renderGoals(goals);
  renderCalendar(blocks);
  closeStaleMenu(blocks);
}

async function connectBase() {
  $("#dataTag").textContent = "连接当前多维表格…";
  let bitable;
  try {
    bitable = await loadBitable(8000);
  } catch (e) {
    throw new Error(`无法加载 Base SDK：${e.message}`);
  }
  // First run in this Base: offer to create the tables instead of failing.
  const plan = await withTimeout(planBaseSetup(bitable.base, MANIFEST), 30000, "检查数据表结构");
  if (plan.steps.length || plan.conflicts.length) { showSetup(bitable.base, plan); return false; }
  const p = createBaseSdkPort(bitable.base, { tz: TZ, callTimeoutMs: 8000, onStep: ({ what, ok }) => { if (ok) $("#dataTag").textContent = `连接中：${what} ✓`; } });
  await p.loadSchema();
  const userId = await withTimeout(bitable.bridge.getUserId(), 8000, "读取当前用户 getUserId");
  baseActor = await p.resolveActor(userId);
  port = p;
  const s = await p.loadSchema();
  let timer = null;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(render, 300); };
  for (const t of [s.timeBlocks.table, s.goals.table]) {
    try { t.onRecordAdd(refresh); t.onRecordModify(refresh); t.onRecordDelete?.(refresh); } catch { /* events optional */ }
  }
  $("#dataTag").textContent = `当前多维表格 · ${baseActor.label}`;
  // Technical note for admins/debugging only, not shown to everyday users.
  $("#dataTag").title = "写入保证：无原子创建／无条件更新（去重收敛＋写后读回）";
  if (!baseActor.registered) await showJoin(p);
  return true;
}

function showSetup(base, plan) {
  $("#dataTag").textContent = "当前多维表格 · 需要初始化";
  $(".layout").hidden = true;
  $(".log").hidden = true;
  $("#setup").hidden = false;
  const tables = plan.steps.filter((x) => x.op === "create_table").map((x) => x.table);
  const fields = plan.steps.filter((x) => x.op === "create_field").length;
  $("#setupDetail").textContent = plan.conflicts.length
    ? `已有字段类型不符，不能自动处理：${plan.conflicts.map((c) => `${c.table}.${c.field}`).join("、")}。请改名或删除这些字段后刷新。`
    : `将新建 ${tables.length} 张表${tables.length ? `（${tables.join("、")}）` : ""}，补 ${fields} 个字段。`;
  $("#setupRun").disabled = plan.conflicts.length > 0;
  $("#setupRun").onclick = async () => {
    $("#setupRun").disabled = true;
    try {
      const after = await applyBaseSetup(base, MANIFEST, { onStep: ({ done, total, label }) => { $("#setupStatus").textContent = `${done}/${total} ${label}`; } });
      if (after.steps.length) throw new Error(`还有 ${after.steps.length} 步未完成`);
      $("#setupStatus").textContent = "已完成，正在打开工作台…";
      location.reload();
    } catch (e) {
      $("#setupStatus").textContent = `创建失败：${e.message}。可能是没有这个多维表格的管理权限；已创建的部分会保留，再点一次会接着创建。`;
      $("#setupRun").disabled = false;
    }
  };
}

async function showJoin(p) {
  const bar = $("#join");
  if (baseActor.canJoin === false) {
    $("#joinText").textContent = "你在成员表里的账号已停用，目前只能查看。需要使用请联系管理员。";
    $("#joinRun").hidden = true;
    bar.hidden = false;
    return;
  }
  const first = (await p.countActiveAdmins()) === 0;
  $("#joinText").textContent = first
    ? "这个工作台还没有管理员。你是第一个使用的人，加入后将成为管理员。"
    : "你还没加入这个工作台，目前只能查看。加入后可以新建目标、排时间。";
  $("#joinRun").textContent = first ? "加入并成为管理员" : "加入";
  $("#joinRun").onclick = async () => {
    $("#joinRun").disabled = true;
    $("#joinStatus").textContent = "正在加入…";
    const r = await joinWorkspace(p, baseActor);
    if (r.status === "committed" || r.status === "duplicate") { $("#joinStatus").textContent = "已加入，正在刷新…"; location.reload(); return; }
    $("#joinStatus").textContent = `加入失败（${r.reason || r.status}）。请刷新后重试。`;
    $("#joinRun").disabled = false;
  };
  bar.hidden = false;
}

async function init() {
  const sel = $("#actor");
  if (MODE === "base") {
    document.body.classList.add("mode-base");
    for (const id of ["#otherTab", "#reset"]) $(id).hidden = true;
    $(".faults").hidden = true; // shown again below for Base admins only
    // Table-view host only: the self-test ships in the same package (selftest.html).
    if (embeddedBitable()) {
      // Two clicks instead of confirm(): modal dialogs may be blocked in the host iframe.
      let armed = false;
      $("#selftest").onclick = () => {
        if (armed) { location.href = "./selftest.html"; return; }
        armed = true;
        $("#selftest").textContent = "会新建 1 条测试记录并标为已取消；只在测试 Base 用。再点一次开始";
      };
    }
    sel.disabled = true;
    try {
      // Outside a Base plugin the SDK loads but its calls never answer.
      // Each SDK call has its own 8 s timeout naming the call; this is only a backstop.
      const ready = await withTimeout(connectBase(), 90000, "连接多维表格");
      if (!ready) return; // waiting for first-run setup
      sel.append(new Option(baseActor.label, "base"));
      // Self-test writes a record: offer it to Base admins only.
      // Fault injection and the self-test are diagnostics: Base admins only.
      // Only builds that opt in (the in-house table view) carry diagnostics;
      // the marketplace sidebar build never shows them.
      const isAdmin = baseActor.registered && baseActor.role === "admin";
      const diagnostics = globalThis.__osbornDiagnostics === true || !embeddedBitable();
      $(".faults").hidden = !(isAdmin && diagnostics);
      if (embeddedBitable() && isAdmin && diagnostics) $("#selftest").hidden = false;
    } catch (e) {
      $("#dataTag").textContent = "未连接";
      $("#goalList").textContent = `${e.message}。工作台不会改用本地样例数据。请在多维表格插件中打开本页。`;
      return;
    }
  } else {
    for (const [k, a] of Object.entries(ACTORS)) sel.append(new Option(a.label, k));
    sel.onchange = () => { actorKey = sel.value; render(); };
  }
  $("#prev").onclick = () => { viewMonday = addDays(viewMonday, -7); render(); };
  $("#next").onclick = () => { viewMonday = addDays(viewMonday, 7); render(); };
  $("#reload").onclick = () => location.reload();
  $("#reset").onclick = () => { localStorage.removeItem(STORE_KEY); location.reload(); };
  $("#otherTab").onclick = async () => {
    const [first] = (await port.listTimeBlocks()).filter((b) => b.state !== "cancelled").sort((a, b) => a.startMs - b.startMs);
    if (!first) return;
    await port.updateTimeBlockIfRevision(newKey("othertab"), first.id, first.revision, { title: `${first.title}（他处已改）` });
    logReceipt("另一标签页修改（未刷新本页）", { status: "committed", operationKey: "othertab" });
    // Intentionally do not re-render: this tab now holds a stale revision.
  };
  // Another real tab wrote to the shared store: show its data (this tab's
  // writes would hit a revision conflict anyway, never overwrite it).
  window.addEventListener("storage", (e) => { if (e.key === STORE_KEY) render(); });
  setupGoalsToggle();
  document.querySelectorAll(".tabs [role=tab]").forEach((t) => {
    t.onclick = () => {
      setGoalsCollapsed(false);
      goalView = t.dataset.view;
      document.querySelectorAll(".tabs [role=tab]").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
      render();
    };
  });
  setupNewGoal();
  render();
}
init();
