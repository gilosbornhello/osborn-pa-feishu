// First-run setup inside a Base extension: create the tables and fields the
// workbench needs, from the same manifest and planner the CLI installer uses.
// Re-runnable: planning again after applying yields no steps. Never deletes
// or retypes anything; a field with the wrong type stops setup as a conflict.

import { planInstall } from "../../installer/src/plan.js";

// Base JS SDK FieldType → planner type names.
const SDK_TYPES = { 1: "text", 2: "number", 3: "select", 4: "multi_select", 5: "datetime", 7: "checkbox", 11: "user", 18: "link", 21: "link", 20: "formula" };
export const PROFILE = "F0";

/** { tables: [{ id, name, fields: [{ name, type }] }] } as the planner expects. */
export async function readStructure(base) {
  const tables = [];
  for (const meta of await base.getTableMetaList()) {
    const table = await base.getTableById(meta.id);
    const fields = (await table.getFieldMetaList()).map((f) => ({ name: f.name, type: SDK_TYPES[f.type] || `sdk_${f.type}` }));
    tables.push({ id: meta.id, name: meta.name, fields });
  }
  return { tables };
}

/** Planner field spec (lark-cli shape) → Base JS SDK field config. */
export function toSdkField(spec, tableIds) {
  const name = spec.name;
  switch (spec.type) {
    case "text": return { type: 1, name };
    case "number": return { type: 2, name, property: { formatter: "0" } };
    case "checkbox": return { type: 7, name };
    case "user": return { type: 11, name, property: { multiple: spec.multiple === true } };
    case "datetime": return { type: 5, name, property: { dateFormat: spec.style?.format === "yyyy-MM-dd" ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm", displayTimeZone: false, autoFill: false } };
    case "select": return { type: 3, name, property: { options: spec.options.map((o) => ({ name: o.name })) } };
    case "link": {
      const tableId = tableIds.get(spec.link_table);
      if (!tableId) throw new Error(`link target table not found: ${spec.link_table}`);
      return { type: 18, name, property: { tableId, multiple: false } };
    }
    default: throw new Error(`unsupported field type: ${spec.type}`);
  }
}

export async function planBaseSetup(base, manifest, profile = PROFILE) {
  const current = await readStructure(base);
  return { current, ...planInstall(manifest, profile, current) };
}

/**
 * Apply the plan. onStep({ done, total, label }) reports progress.
 * Returns the re-check plan (steps should be empty).
 */
export async function applyBaseSetup(base, manifest, { profile = PROFILE, onStep, newId = () => crypto.randomUUID(), timezone = "Asia/Shanghai" } = {}) {
  const { current, steps, conflicts } = await planBaseSetup(base, manifest, profile);
  if (conflicts.length) {
    throw new Error(`已有字段类型不符，未做任何修改：${conflicts.map((c) => `${c.table}.${c.field}（应为 ${c.expected}，实为 ${c.actual}）`).join("；")}`);
  }
  const ids = new Map(current.tables.map((t) => [t.name, t.id]));
  const createdTables = new Set();
  let done = 0;
  for (const s of steps) {
    if (s.op === "create_table") {
      const r = await base.addTable({ name: s.table, fields: [toSdkField(s.primary, ids)] });
      ids.set(s.table, r.tableId);
      createdTables.add(s.table);
    } else {
      const table = await base.getTableById(ids.get(s.table));
      await table.addField(toSdkField(s.field, ids));
    }
    done += 1;
    onStep?.({ done, total: steps.length, label: s.op === "create_table" ? `新建数据表「${s.table}」` : `新建字段 ${s.table}.${s.field.name}` });
  }
  // Seed instance settings once, when this run created the settings table.
  const settings = manifest.tables.find((t) => t.logical === "instance_settings");
  if (settings && createdTables.has(settings.label)) {
    const table = await base.getTableById(ids.get(settings.label));
    const fid = new Map((await table.getFieldMetaList()).map((f) => [f.name, f.id]));
    const values = { instance_id: newId(), timezone, install_state: "schema_ready" };
    for (const row of settings.seed) {
      const value = values[row.key] ?? row.value;
      await table.addRecord({ fields: { [fid.get("key")]: [{ type: "text", text: row.key }], [fid.get("value")]: [{ type: "text", text: String(value) }] } });
    }
  }
  return planBaseSetup(base, manifest, profile);
}
