#!/usr/bin/env node
// Write the synthetic demo seed into an installed instance, then read it back
// and check every value round-trips (including datetimes in the Base timezone).
// Rows are keyed by business_id and skipped if present, so reruns write nothing.
//
//   node tools/seed-instance.mjs --record local/instances/<name>.json [--as user]
//
// Every person field is set to the signed-in lark-cli user: this tenant has
// no separate test accounts yet, so all synthetic owners collapse to one.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { addDays, wallParts, weekdayOf, toLocalDate } from "../packages/rules/src/time.js";
import { buildSeed } from "../packages/workbench/src/seed.js";

const { values: opt } = parseArgs({ options: { record: { type: "string" }, as: { type: "string", default: "user" } } });
if (!opt.record?.startsWith("local/")) throw new Error("--record must point under local/");
const rec = JSON.parse(readFileSync(opt.record, "utf8"));
const tz = rec.timezone;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args, as = opt.as) {
  let out;
  try {
    out = execFileSync("lark-cli", [...args, "--as", as], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = e.stdout || e.stderr || String(e);
  }
  const json = JSON.parse(out.slice(out.indexOf("{")));
  if (!json.ok) throw new Error(`lark-cli ${args.slice(0, 2).join(" ")} failed: ${json.error?.code} ${json.error?.message}`);
  return json.data;
}

function rows(tableId) {
  const all = [];
  for (let offset = 0; ; offset += 200) {
    const d = cli(["base", "+record-list", "--base-token", rec.baseToken, "--table-id", tableId, "--limit", "200", "--offset", String(offset), "--format", "json"]);
    (d.data ?? []).forEach((cells, i) => all.push({ recordId: d.record_id_list[i], ...Object.fromEntries(d.fields.map((n, j) => [n, cells[j]])) }));
    if (!d.has_more) return all;
  }
}

const wall = (ms) => {
  const p = wallParts(ms, tz);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.date} ${pad(p.hour)}:${pad(p.minute)}:00`;
};

const openId = JSON.parse(execFileSync("lark-cli", ["auth", "status"], { encoding: "utf8" })).identities.user.openId;
if (!openId) throw new Error("no signed-in lark-cli user");
const person = [{ id: openId }];

const today = toLocalDate(Date.now(), tz);
const monday = addDays(today, 1 - (weekdayOf(today) || 7));
const seed = buildSeed(monday, tz);
const T = (logical) => rec.tables[logical].tableId;

const created = { members: 0, projects: 0, goals: 0, time_blocks: 0 };
const expected = [];

async function ensure(logical, businessId, fields, existing) {
  const hit = existing.find((r) => r.business_id === businessId);
  if (hit) return hit.recordId;
  const d = cli(["base", "+record-upsert", "--base-token", rec.baseToken, "--table-id", T(logical), "--json", JSON.stringify({ business_id: businessId, ...fields })]);
  created[logical]++;
  await sleep(300);
  const id = d.record?.record_id ?? d.record?.id ?? d.record?.record_id_list?.[0] ?? d.record_id;
  if (id) return id;
  // Response shape not recognised: take the id from a read-back instead.
  const row = rows(T(logical)).find((r) => r.business_id === businessId);
  if (!row) throw new Error(`${logical}/${businessId} not found after create (response keys: ${Object.keys(d.record ?? d)})`);
  return row.recordId;
}

const members = rows(T("members"));
await ensure("members", "m_owner", { display_label: "安装人（合成成员）", account: person, product_role: "admin", active: true }, members);

const projectIds = {};
const projects = rows(T("projects"));
for (const p of seed.projects) {
  projectIds[p.id] = await ensure("projects", p.id, { title: p.title, owner: person, lifecycle: "in_progress", attention_state: "active", importance_manual: 50, urgency_manual: 35, revision: 1 }, projects);
}

const goalIds = {};
const goals = rows(T("goals"));
for (const g of seed.goals) {
  const fields = {
    title: g.title, entity_kind: "task", accountable_owner: person, visibility: g.visibility, status: "not_started", bucket: g.bucket,
    importance_manual: g.importanceManual, urgency_manual: g.urgencyManual, archived: false, sample_key: g.sampleKey, revision: 1,
    last_shift_date: `${today} 00:00:00`,
  };
  if (g.projectId) fields.project = [{ id: projectIds[g.projectId] }];
  goalIds[g.id] = await ensure("goals", g.id, fields, goals);
  expected.push({ table: "goals", id: g.id, field: "bucket", value: g.bucket });
}

const blocks = rows(T("time_blocks"));
for (const b of seed.timeBlocks) {
  await ensure("time_blocks", b.id, {
    title: b.title, goal: [{ id: goalIds[b.goalId] }], owner: person, start_at: wall(b.startMs), end_at: wall(b.endMs),
    all_day: false, timezone: tz, state: b.state, operation_key: b.operationKey, source: "import", revision: 1, sample_key: b.sampleKey,
  }, blocks);
  expected.push({ table: "time_blocks", id: b.id, field: "start_at", value: wall(b.startMs), ms: b.startMs });
  expected.push({ table: "time_blocks", id: b.id, field: "end_at", value: wall(b.endMs), ms: b.endMs });
}

// Read back and compare.
const back = { goals: rows(T("goals")), time_blocks: rows(T("time_blocks")) };
const mismatches = [];
for (const e of expected) {
  const row = back[e.table].find((r) => r.business_id === e.id);
  const got = row?.[e.field];
  const norm = Array.isArray(got) ? got[0] : got;
  // Datetimes are written as wall time in the Base timezone and read back as
  // ISO with offset; compare instants, not strings.
  const same = e.ms !== undefined ? Date.parse(norm) === e.ms : String(norm) === e.value;
  if (!same) mismatches.push({ ...e, got });
}
const linkOk = back.time_blocks.every((r) => !r.business_id?.startsWith("tb_") || (Array.isArray(r.goal) && r.goal.length === 1));
const dupOps = back.time_blocks.length - new Set(back.time_blocks.map((r) => r.operation_key)).size;

rec.seed = { sampleKey: "demo-v1", weekOf: monday, lastRunAt: new Date().toISOString() };
writeFileSync(opt.record, `${JSON.stringify(rec, null, 2)}\n`);
console.log(JSON.stringify({
  created, weekOf: monday,
  counts: { goals: back.goals.length, time_blocks: back.time_blocks.length },
  roundTrip: { checked: expected.length, mismatches },
  timeBlockGoalLinks: linkOk, duplicateOperationKeys: dupOps,
  sampleBlock: back.time_blocks.find((r) => r.business_id === "tb_1") && { start_at: back.time_blocks.find((r) => r.business_id === "tb_1").start_at, goal: back.time_blocks.find((r) => r.business_id === "tb_1").goal },
}, null, 2));
