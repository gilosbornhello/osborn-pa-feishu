#!/usr/bin/env node
// Install (or resume / re-check) one product instance into a Feishu Base via
// lark-cli. Default is a dry run that only prints the plan.
//
//   node tools/install-instance.mjs --record local/instances/<name>.json --name "<Base name>" [--profile F0] [--execute] [--as user]
//
// The install record (Base token, table ids, manifest hash) is tenant data and
// must stay under local/ (git-ignored). It is written right after the Base is
// created, so a rerun resumes that Base instead of creating a second one.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadManifest, manifestHash } from "../packages/schema/manifest-hash.mjs";
import { planInstall, tablesForProfile } from "../packages/installer/src/plan.js";

const { values: opt } = parseArgs({
  options: {
    record: { type: "string" },
    name: { type: "string" },
    profile: { type: "string", default: "F0" },
    as: { type: "string", default: "user" },
    timezone: { type: "string", default: "Asia/Shanghai" },
    execute: { type: "boolean", default: false },
  },
});
if (!opt.record) throw new Error("--record is required");
if (!opt.record.startsWith("local/")) throw new Error("install record must live under local/ (git-ignored)");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args) {
  let out;
  try {
    out = execFileSync("lark-cli", [...args, "--as", opt.as], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = e.stdout || e.stderr || String(e);
  }
  const json = JSON.parse(out.slice(out.indexOf("{")));
  if (!json.ok) {
    const err = new Error(`lark-cli ${args.slice(0, 2).join(" ")} failed: ${json.error?.code} ${json.error?.message}`);
    err.code = json.error?.code;
    throw err;
  }
  return json.data;
}

function saveRecord(rec) {
  mkdirSync(dirname(opt.record), { recursive: true });
  writeFileSync(opt.record, `${JSON.stringify(rec, null, 2)}\n`);
}

function readBase(token) {
  const tables = cli(["base", "+table-list", "--base-token", token, "--limit", "100"]).tables;
  const out = [];
  for (const t of tables) { // +field-list must be serial
    const fields = cli(["base", "+field-list", "--base-token", token, "--table-id", t.id, "--limit", "200"]).fields;
    out.push({ id: t.id, name: t.name, fields: fields.map((f) => ({ id: f.id, name: f.name, type: f.type })) });
  }
  return { tables: out };
}

function listRecords(token, tableId) {
  return cli(["base", "+record-list", "--base-token", token, "--table-id", tableId, "--limit", "200", "--format", "json"]);
}

// +record-list returns column-major data; turn it into { fieldName: value } rows.
function recordRows(data) {
  if (Array.isArray(data.records)) return data.records.map((r) => r.fields ?? r);
  const names = data.fields ?? [];
  return (data.data ?? []).map((cells) => Object.fromEntries(names.map((n, i) => [n, cells[i]])));
}

const manifest = loadManifest();
const hash = manifestHash(manifest);
let rec = existsSync(opt.record) ? JSON.parse(readFileSync(opt.record, "utf8")) : null;

if (!rec) {
  if (!opt.execute) {
    const { steps, deferred } = planInstall(manifest, opt.profile);
    console.log(JSON.stringify({ dryRun: true, wouldCreateBase: opt.name ?? "(needs --name)", steps: steps.length, deferred, plan: steps }, null, 2));
    process.exit(0);
  }
  if (!opt.name) throw new Error("--name is required for a new instance");
  const created = cli(["base", "+base-create", "--name", opt.name, "--time-zone", opt.timezone]);
  const base = created.base ?? created;
  rec = {
    instanceId: randomUUID(),
    profile: opt.profile,
    baseToken: base.base_token ?? base.app_token ?? base.token,
    baseUrl: base.url ?? null,
    createdAs: opt.as,
    timezone: opt.timezone,
    installState: "base_created",
    createdAt: new Date().toISOString(),
  };
  if (!rec.baseToken) throw new Error(`could not find base token in response keys: ${Object.keys(base)}`);
  saveRecord(rec);
}

const before = readBase(rec.baseToken);
const { steps, deferred, conflicts } = planInstall(manifest, opt.profile, before);
if (!opt.execute) {
  console.log(JSON.stringify({ dryRun: true, base: "existing", steps: steps.length, deferred, conflicts, plan: steps }, null, 2));
  process.exit(0);
}
if (conflicts.length) {
  console.log(JSON.stringify({ stopped: "conflicts", conflicts }, null, 2));
  process.exit(2);
}

const log = [];
for (const s of steps) {
  if (s.op === "create_table") {
    cli(["base", "+table-create", "--base-token", rec.baseToken, "--name", s.table, "--fields", JSON.stringify([s.primary])]);
  } else {
    cli(["base", "+field-create", "--base-token", rec.baseToken, "--table-id", s.table, "--json", JSON.stringify(s.field)]);
  }
  log.push(`${s.op} ${s.table}${s.field ? `.${s.field.name}` : ""}`);
  await sleep(300);
}

// Verify by reading back, not by trusting the write responses.
const after = readBase(rec.baseToken);
const recheck = planInstall(manifest, opt.profile, after);
const byName = new Map(after.tables.map((t) => [t.name, t]));
rec.tables = Object.fromEntries(tablesForProfile(manifest, opt.profile).map((t) => {
  const phys = byName.get(t.label);
  return [t.logical, phys ? { tableId: phys.id, fields: Object.fromEntries(phys.fields.map((f) => [f.name, f.id])) } : null];
}));

// Seed instance_settings by key; existing keys are never overwritten.
const settings = manifest.tables.find((t) => t.logical === "instance_settings");
const settingsId = rec.tables.instance_settings?.tableId;
let seeded = 0;
if (settingsId && recheck.steps.length === 0) {
  const have = new Set(recordRows(listRecords(rec.baseToken, settingsId)).map((r) => r.key).filter(Boolean));
  for (const row of settings.seed) {
    if (have.has(row.key)) continue;
    const value = row.key === "instance_id" ? rec.instanceId : row.key === "timezone" ? rec.timezone : row.value;
    cli(["base", "+record-upsert", "--base-token", rec.baseToken, "--table-id", settingsId, "--json", JSON.stringify({ key: row.key, value })]);
    seeded++;
    await sleep(300);
  }
}

rec.manifestHash = hash;
rec.schemaVersion = manifest.schemaVersion;
rec.installState = recheck.steps.length === 0 && recheck.conflicts.length === 0 ? "schema_ready" : "partial";
rec.lastRunAt = new Date().toISOString();
saveRecord(rec);
console.log(JSON.stringify({
  installState: rec.installState,
  wrote: log.length,
  seededSettings: seeded,
  remainingSteps: recheck.steps.length,
  conflicts: recheck.conflicts,
  deferred,
  unrelatedTables: after.tables.filter((t) => !tablesForProfile(manifest, opt.profile).some((x) => x.label === t.name)).map((t) => t.name),
}, null, 2));
