// F0 platform probe: does Base OpenAPI `client_token` make record creation idempotent,
// including under concurrent retries? Uses lark-cli (credentials stay inside lark-cli).
//
// Usage: node tools/probe-client-token.mjs <base_token> [--as bot|user]
// Run ONLY against a Base created for this probe, containing synthetic data.
// Prints a JSON summary; write it under local/evidence/ (git-ignored).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);
const [baseToken, , asArg] = process.argv.slice(2);
const as = asArg || "bot";
if (!baseToken) { console.error("usage: probe-client-token.mjs <base_token> [--as bot|user]"); process.exit(2); }

async function api(method, path, { params, data } = {}) {
  const args = ["api", method, path, "--as", as];
  if (params) args.push("--params", JSON.stringify(params));
  if (data) args.push("--data", JSON.stringify(data));
  try {
    const { stdout } = await run("lark-cli", args, { maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    for (const stream of [err.stdout, err.stderr]) {
      try { return JSON.parse(stream); } catch { /* try next */ }
    }
    return { ok: false, error: { message: String(err.stderr || err.message).slice(0, 200) } };
  }
}
const brief = (r) => (r.ok ? { ok: true } : { ok: false, code: r.error?.code, message: r.error?.message?.slice(0, 160) });

async function countByKey(tableId, key) {
  const r = await api("GET", `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`, { params: { page_size: 500 } });
  if (!r.ok) return `error:${r.error?.code}`;
  return (r.data?.items || []).filter((i) => JSON.stringify(i.fields?.operation_key ?? "").includes(key)).length;
}

const out = { probe: "client_token-idempotency", at: new Date().toISOString(), identity: as, results: {} };

const table = await api("POST", `/open-apis/bitable/v1/apps/${baseToken}/tables`, {
  data: { table: { name: `f0_probe_${Date.now()}`, default_view_name: "all", fields: [
    { field_name: "title", type: 1 }, { field_name: "operation_key", type: 1 }, { field_name: "revision", type: 2 },
  ] } },
});
out.results.createTable = brief(table);
const tableId = table.data?.table_id;
if (!tableId) { console.log(JSON.stringify(out, null, 2)); process.exit(1); }

const fields = (key, title = "合成：拖入安排") => ({ fields: { title, operation_key: key, revision: 1 } });

// 1. Sequential retry with the same client_token
{
  const key = `seq-${randomUUID()}`; const token = randomUUID();
  const path = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`;
  const a = await api("POST", path, { params: { client_token: token }, data: fields(key) });
  const b = await api("POST", path, { params: { client_token: token }, data: fields(key) });
  out.results.sequentialRetry = { first: brief(a), second: brief(b), sameRecordId: a.data?.record?.record_id === b.data?.record?.record_id, rowsWithKey: await countByKey(tableId, key) };
}
// 2. Same client_token, different payload
{
  const key = `payload-${randomUUID()}`; const token = randomUUID();
  const path = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`;
  const a = await api("POST", path, { params: { client_token: token }, data: fields(key) });
  const b = await api("POST", path, { params: { client_token: token }, data: fields(key, "合成：不同内容") });
  out.results.sameTokenDifferentPayload = { first: brief(a), second: brief(b), rowsWithKey: await countByKey(tableId, key) };
}
// 3. Five concurrent requests with the same client_token
{
  const key = `conc-${randomUUID()}`; const token = randomUUID();
  const path = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`;
  const rs = await Promise.all(Array.from({ length: 5 }, () => api("POST", path, { params: { client_token: token }, data: fields(key) })));
  const retries = [];
  for (let i = 0; i < 4; i++) retries.push(await api("POST", path, { params: { client_token: token }, data: fields(key) }));
  const ids = [...rs, ...retries].map((r) => r.data?.record?.record_id).filter(Boolean);
  out.results.concurrentSameToken = { responses: rs.map(brief), sequentialRetriesAfterThrottle: retries.map(brief), distinctRecordIds: new Set(ids).size, rowsWithKey: await countByKey(tableId, key) };
}
// 4. Negative control: five concurrent requests WITHOUT client_token
{
  const key = `noToken-${randomUUID()}`;
  const path = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`;
  const rs = await Promise.all(Array.from({ length: 5 }, () => api("POST", path, { data: fields(key) })));
  out.results.concurrentNoToken = { responses: rs.map(brief), distinctRecordIds: new Set(rs.map((r) => r.data?.record?.record_id).filter(Boolean)).size, rowsWithKey: await countByKey(tableId, key) };
}
// 5. batch_create retried with the same client_token
{
  const key = `batch-${randomUUID()}`; const token = randomUUID();
  const path = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_create`;
  const body = { records: [fields(key), fields(key)] };
  const a = await api("POST", path, { params: { client_token: token }, data: body });
  const b = await api("POST", path, { params: { client_token: token }, data: body });
  const idsA = (a.data?.records || []).map((r) => r.record_id); const idsB = (b.data?.records || []).map((r) => r.record_id);
  out.results.batchRetry = { first: brief(a), second: brief(b), firstIds: idsA.length, sameIds: idsA.length > 0 && JSON.stringify(idsA) === JSON.stringify(idsB), rowsWithKey: await countByKey(tableId, key) };
}
// 6. Update has no revision check: two writers with the same "expected revision" both succeed
{
  const key = `cas-${randomUUID()}`;
  const path = `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`;
  const c = await api("POST", path, { data: fields(key) });
  const id = c.data?.record?.record_id;
  const [u1, u2] = await Promise.all([
    api("PUT", `${path}/${id}`, { data: { fields: { title: "合成：A 改期", revision: 2 } } }),
    api("PUT", `${path}/${id}`, { data: { fields: { title: "合成：B 取消", revision: 2 } } }),
  ]);
  const g = await api("GET", `${path}/${id}`);
  out.results.updateNoCas = { u1: brief(u1), u2: brief(u2), finalTitle: g.data?.record?.fields?.title, finalRevision: g.data?.record?.fields?.revision };
}
console.log(JSON.stringify(out, null, 2));
