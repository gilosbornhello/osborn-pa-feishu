// Storage port backed by the current Base, through the Base JS SDK, as the
// viewing user. Same interface as rules/src/memory-port.js.
//
// Declared guarantees (the SDK has no idempotent create and no conditional
// update, see docs/plan §10 and decision D-3):
//   atomicCreate: false       two clients racing on one operation_key can both
//                             insert; reads collapse them to one canonical row
//                             (lowest record id) and the losing writer is told
//                             "duplicate", so every reader converges.
//   conditionalUpdate: false  read-compare-write-readback. A stale revision is
//                             rejected before writing; a concurrent writer
//                             detected on read-back is reported as conflict.
//                             A writer that overwrites in the gap between
//                             another's write and read-back is not detected.
//
// Physical names: tables use the manifest labels, fields use the logical names
// (see packages/installer/src/plan.js). Domain ids are Base record ids.

import { OutcomeUnknownError } from "../../rules/src/commands.js";
import { wallParts } from "../../rules/src/time.js";

export const TABLES = { members: "成员", projects: "项目", goals: "目标任务", timeBlocks: "时间安排" };
export const CAPABILITIES = Object.freeze({ atomicCreate: false, conditionalUpdate: false });

// ---- cell codec (pure) ----

export function readText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((s) => (s && typeof s === "object" ? s.text ?? "" : String(s))).join("");
  return String(v);
}
export const writeText = (s) => [{ type: "text", text: String(s ?? "") }];
export const readSelect = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v.text ?? null : Array.isArray(v) ? v[0]?.text ?? null : null);
export const readUsers = (v) => (Array.isArray(v) ? v.filter((u) => u && u.id) : []);
export const readLinkIds = (v) => (v && typeof v === "object" ? v.recordIds || v.record_ids || [] : []);
export const writeLink = (tableId, ids) => ({ text: "", type: "text", recordIds: ids, tableId });
export const readNumber = (v) => (typeof v === "number" ? v : v == null || v === "" ? null : Number(v));
export const readTimestamp = (v) => (typeof v === "number" ? v : null);
export const readDate = (v, tz) => (typeof v === "number" ? wallParts(v, tz).date : null);

/** Lowest record id wins, so every client picks the same row. */
export function canonicalByOperation(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const cur = byKey.get(r.operationKey);
    if (!cur || r.id < cur.id) byKey.set(r.operationKey, r);
  }
  return byKey;
}

// ---- port ----

export function createBaseSdkPort(base, { tz = "Asia/Shanghai", faults: initialFaults } = {}) {
  const faults = { loseNextResponse: false, failNextBeforeCommit: false, ...initialFaults };
  let schema = null;

  async function loadSchema() {
    if (schema) return schema;
    const out = {};
    for (const [key, name] of Object.entries(TABLES)) {
      const table = await base.getTableByName(name);
      const metas = await table.getFieldMetaList();
      out[key] = { table, id: table.id, fields: new Map(metas.map((m) => [m.name, m])) };
    }
    return (schema = out);
  }

  async function scan(key) {
    const s = await loadSchema();
    const { table, fields } = s[key];
    const byId = new Map([...fields.values()].map((m) => [m.id, m.name]));
    const rows = [];
    let pageToken;
    do {
      const res = await table.getRecords({ pageSize: 200, pageToken });
      for (const r of res.records) {
        const named = {};
        for (const [fid, v] of Object.entries(r.fields || {})) if (byId.has(fid)) named[byId.get(fid)] = v;
        rows.push({ recordId: r.recordId, cells: named });
      }
      pageToken = res.hasMore ? res.pageToken : undefined;
    } while (pageToken);
    return rows;
  }

  function encode(key, values) {
    const { fields } = schema[key];
    const out = {};
    for (const [name, v] of Object.entries(values)) {
      const meta = fields.get(name);
      if (!meta) throw new Error(`field missing in Base: ${TABLES[key]}.${name}`);
      out[meta.id] = v;
    }
    return { fields: out };
  }

  function selectValue(key, name, text) {
    const opt = (schema[key].fields.get(name)?.property?.options || []).find((o) => o.name === text);
    if (!opt) throw new Error(`select option missing: ${TABLES[key]}.${name}=${text}`);
    return { id: opt.id, text: opt.name };
  }

  const toGoal = ({ recordId, cells: c }) => ({
    id: recordId,
    businessId: readText(c.business_id),
    title: readText(c.title),
    ownerId: readUsers(c.accountable_owner)[0]?.id ?? null,
    assigneeIds: readUsers(c.assignees).map((u) => u.id),
    projectId: readLinkIds(c.project)[0] ?? null,
    visibility: readSelect(c.visibility) || "project",
    status: readSelect(c.status) || "not_started",
    bucket: readSelect(c.bucket) || "inbox",
    dueDate: readDate(c.due_date, tz),
    archived: c.archived === true,
    importanceManual: readNumber(c.importance_manual) ?? undefined,
    urgencyManual: readNumber(c.urgency_manual) ?? undefined,
    revision: readNumber(c.revision) ?? 1,
  });
  const toProject = ({ recordId, cells: c }) => ({
    id: recordId,
    title: readText(c.title),
    ownerId: readUsers(c.owner)[0]?.id ?? null,
    attentionState: readSelect(c.attention_state) || "active",
    revision: readNumber(c.revision) ?? 1,
  });
  const toBlock = ({ recordId, cells: c }) => ({
    id: recordId,
    businessId: readText(c.business_id),
    title: readText(c.title),
    goalId: readLinkIds(c.goal)[0] ?? null,
    ownerId: readUsers(c.owner)[0]?.id ?? null,
    owner: readUsers(c.owner)[0] ?? null,
    startMs: readTimestamp(c.start_at),
    endMs: readTimestamp(c.end_at),
    allDay: c.all_day === true,
    timezone: readText(c.timezone) || tz,
    state: readSelect(c.state) || "planned",
    source: readSelect(c.source),
    operationKey: readText(c.operation_key),
    lastOperationKey: readText(c.last_operation_key),
    revision: readNumber(c.revision) ?? 1,
  });

  /** All blocks with duplicates (same operation_key) collapsed to the canonical row. */
  async function blocks() {
    const all = (await scan("timeBlocks")).map(toBlock).filter((b) => Number.isFinite(b.startMs) && Number.isFinite(b.endMs));
    const canon = canonicalByOperation(all.filter((b) => b.operationKey));
    return all.filter((b) => !b.operationKey || canon.get(b.operationKey) === b);
  }
  const blocksByOperation = async (key) => (await scan("timeBlocks")).map(toBlock).filter((b) => b.operationKey === key);

  function maybeFailBeforeCommit() {
    if (faults.failNextBeforeCommit) {
      faults.failNextBeforeCommit = false;
      throw new OutcomeUnknownError("request failed before commit");
    }
  }
  function maybeLoseResponse(result) {
    if (faults.loseNextResponse) {
      faults.loseNextResponse = false;
      throw new OutcomeUnknownError("response lost after commit");
    }
    return result;
  }
  // A thrown SDK call may or may not have been applied.
  async function sdkWrite(fn) {
    try { return await fn(); } catch (err) { throw new OutcomeUnknownError(`sdk write failed: ${err?.message || err}`); }
  }

  return {
    kind: "base-sdk",
    capabilities: CAPABILITIES,
    faults,
    loadSchema,

    /**
     * Resolve the viewing user against the members table. F0 has no project
     * membership table, so projectIds are the projects the user owns.
     */
    async resolveActor(userId) {
      const members = await scan("members");
      const row = members.find((m) => readUsers(m.cells.account).some((u) => u.id === userId));
      if (!row || row.cells.active === false) return { userId, role: "guest", label: "未登记成员（只读）", registered: false };
      const account = readUsers(row.cells.account).find((u) => u.id === userId);
      const projects = (await scan("projects")).map(toProject);
      const own = projects.filter((p) => p.ownerId === userId).map((p) => p.id);
      return {
        userId, account, registered: true,
        label: readText(row.cells.display_label) || account.name || "我",
        role: readSelect(row.cells.product_role) || "member",
        projectIds: own, adminProjectIds: own,
      };
    },

    async getGoal(id) { return (await scan("goals")).map(toGoal).find((g) => g.id === id); },
    async getProject(id) { return (await scan("projects")).map(toProject).find((p) => p.id === id); },
    async listGoals() { return (await scan("goals")).map(toGoal); },
    async getTimeBlock(id) { return (await scan("timeBlocks")).map(toBlock).find((b) => b.id === id); },
    async listTimeBlocks({ fromMs = -Infinity, toMs = Infinity } = {}) {
      return (await blocks()).filter((b) => b.endMs > fromMs && b.startMs < toMs);
    },

    /** Raw rows for one operation key, duplicates included (diagnostics only). */
    rowsForOperation: blocksByOperation,

    async findOperation(operationKey) {
      const rows = (await scan("timeBlocks")).map(toBlock);
      const created = canonicalByOperation(rows.filter((b) => b.operationKey === operationKey)).get(operationKey);
      const updated = rows.find((b) => b.lastOperationKey === operationKey);
      const block = created || updated;
      return block ? { block } : null;
    },

    async createTimeBlockOnce(operationKey, row) {
      maybeFailBeforeCommit();
      await loadSchema();
      const existing = canonicalByOperation(await blocksByOperation(operationKey)).get(operationKey);
      if (existing) return maybeLoseResponse({ created: false, block: existing });
      const owner = row.owner || { id: row.ownerId };
      const values = {
        title: writeText(row.title),
        business_id: writeText(`tb:${operationKey}`),
        owner: [owner],
        start_at: row.startMs,
        end_at: row.endMs,
        all_day: Boolean(row.allDay),
        timezone: writeText(row.timezone || tz),
        state: selectValue("timeBlocks", "state", row.state || "planned"),
        operation_key: writeText(operationKey),
        revision: 1,
      };
      if (row.goalId) values.goal = writeLink(schema.goals.id, [row.goalId]);
      if (row.source && schema.timeBlocks.fields.get("source")?.property?.options?.some((o) => o.name === row.source)) {
        values.source = selectValue("timeBlocks", "source", row.source);
      }
      const recordId = await sdkWrite(() => schema.timeBlocks.table.addRecord(encode("timeBlocks", values)));
      // Read back: another client may have inserted the same key concurrently.
      const canon = canonicalByOperation(await blocksByOperation(operationKey)).get(operationKey);
      if (!canon) throw new OutcomeUnknownError("created record not found on read-back");
      return maybeLoseResponse({ created: canon.id === recordId, block: canon });
    },

    async updateTimeBlockIfRevision(operationKey, id, expectedRevision, patch) {
      maybeFailBeforeCommit();
      await loadSchema();
      const current = (await scan("timeBlocks")).map(toBlock).find((b) => b.id === id);
      if (!current) throw new Error(`time block not found: ${id}`);
      if (current.lastOperationKey === operationKey) return maybeLoseResponse({ duplicate: true, block: current });
      if (current.revision !== expectedRevision) return { conflict: true, block: current };
      const values = { revision: current.revision + 1, last_operation_key: writeText(operationKey) };
      if ("startMs" in patch) values.start_at = patch.startMs;
      if ("endMs" in patch) values.end_at = patch.endMs;
      if ("state" in patch) values.state = selectValue("timeBlocks", "state", patch.state);
      if ("title" in patch) values.title = writeText(patch.title);
      await sdkWrite(() => schema.timeBlocks.table.setRecord(id, encode("timeBlocks", values)));
      const after = (await scan("timeBlocks")).map(toBlock).find((b) => b.id === id);
      if (!after || after.lastOperationKey !== operationKey) return { conflict: true, block: after };
      return maybeLoseResponse({ duplicate: false, block: after });
    },
  };
}
