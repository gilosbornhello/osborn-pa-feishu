import { test } from "node:test";
import assert from "node:assert/strict";
import { loadManifest, manifestHash, canonicalize } from "../manifest-hash.mjs";

const m = loadManifest();
const tables = new Map(m.tables.map((t) => [t.logical, t]));

test("logical table and field names are unique and snake_case", () => {
  assert.equal(tables.size, m.tables.length);
  for (const t of m.tables) {
    const names = t.fields.map((f) => f.logical);
    assert.equal(new Set(names).size, names.length, `duplicate field in ${t.logical}`);
    for (const n of [t.logical, ...names]) assert.match(n, /^[a-z][a-z0-9_]*$/);
    assert.equal(t.fields.filter((f) => f.primary).length, 1, `${t.logical} needs exactly one primary field`);
  }
});

test("every link targets a table in the manifest, and profiles only reference known tables", () => {
  for (const t of m.tables) for (const f of t.fields) if (f.type === "link") assert.ok(tables.has(f.target), `${t.logical}.${f.logical}`);
  for (const [p, list] of Object.entries(m.profiles)) for (const name of list) assert.ok(tables.has(name), `${p}:${name}`);
});

test("F0 profile carries the fields the vertical slice needs", () => {
  const need = {
    goals: ["business_id", "title", "accountable_owner", "visibility", "bucket", "importance_manual", "urgency_manual", "revision"],
    time_blocks: ["business_id", "goal", "owner", "start_at", "end_at", "state", "operation_key", "revision"],
  };
  for (const [t, fields] of Object.entries(need)) {
    const have = new Set(tables.get(t).fields.map((f) => f.logical));
    for (const f of fields) assert.ok(have.has(f), `${t}.${f}`);
  }
  assert.ok(tables.get("time_blocks").fields.find((f) => f.logical === "operation_key").unique_required);
});

test("manifest contains no tenant identifiers or credentials", () => {
  const text = JSON.stringify(m);
  assert.doesNotMatch(text, /\b(bas|tbl|fld|vew|wkf|blk|app|cli)[A-Za-z0-9]{8,}\b/);
  assert.doesNotMatch(text, /feishu\.cn\/(base|app|wiki)\//);
});

test("hash is stable under key reordering", () => {
  const shuffled = Object.fromEntries(Object.entries(m).reverse());
  assert.equal(manifestHash(shuffled), manifestHash(m));
  assert.equal(canonicalize({ b: 1, a: [2, { d: 1, c: 0 }] }), '{"a":[2,{"c":0,"d":1}],"b":1}');
});
