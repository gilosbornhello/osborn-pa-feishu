// Pure install planner: logical manifest + what already exists in a Base →
// the ordered, minimal list of writes. Running the plan and planning again
// must yield no steps (the installer is re-runnable). Never deletes or
// retypes anything; mismatches are reported as conflicts for a human.

const DATE_ONLY = "yyyy-MM-dd";
const DATE_TIME = "yyyy-MM-dd HH:mm";

export function tablesForProfile(manifest, profile) {
  const names = manifest.profiles[profile];
  if (!names) throw new Error(`unknown profile ${profile}`);
  return names.map((logical) => {
    const t = manifest.tables.find((x) => x.logical === logical);
    if (!t) throw new Error(`profile ${profile} names missing table ${logical}`);
    return t;
  });
}

export function fieldInProfile(field, profile) {
  return !field.profile || field.profile === profile;
}

// Logical field → lark-cli `+field-create` JSON. Returns null for fields the
// installer deliberately does not create yet (see `deferredReason`).
export function toFeishuField(field, tablesByLogical) {
  const base = { name: field.logical };
  switch (field.type) {
    case "text":
      return { ...base, type: "text" };
    case "number":
      return { ...base, type: "number", style: { type: "plain", precision: 0 } };
    case "checkbox":
      return { ...base, type: "checkbox" };
    case "user":
      return { ...base, type: "user", multiple: field.multiple === true };
    case "datetime":
      return { ...base, type: "datetime", style: { format: field.date_only ? DATE_ONLY : DATE_TIME } };
    case "select":
      return { ...base, type: "select", multiple: false, options: field.options.map((name) => ({ name })) };
    case "link": {
      const target = tablesByLogical.get(field.target);
      if (!target) return null;
      return { ...base, type: "link", link_table: target.label, bidirectional: false };
    }
    default:
      return null;
  }
}

export function deferredReason(field, tablesByLogical) {
  if (field.type === "formula") return `formula ${field.rule} not ported to Base yet`;
  if (field.type === "link" && !tablesByLogical.has(field.target)) return `link target ${field.target} not in profile`;
  return null;
}

// current: { tables: [{ name, fields: [{ name, type }] }] } as read from the Base.
export function planInstall(manifest, profile, current = { tables: [] }) {
  const tables = tablesForProfile(manifest, profile);
  const tablesByLogical = new Map(tables.map((t) => [t.logical, t]));
  const existing = new Map(current.tables.map((t) => [t.name, new Map(t.fields.map((f) => [f.name, f]))]));
  const createTables = [];
  const plainFields = [];
  const linkFields = [];
  const deferred = [];
  const conflicts = [];

  for (const table of tables) {
    const fields = table.fields.filter((f) => fieldInProfile(f, profile));
    const primary = fields.find((f) => f.primary);
    if (!primary || primary.type !== "text") throw new Error(`${table.logical}: primary field must be text`);
    const have = existing.get(table.label);
    if (!have) createTables.push({ op: "create_table", table: table.label, logical: table.logical, primary: toFeishuField(primary, tablesByLogical) });

    for (const field of fields) {
      if (field.primary && !have) continue;
      const reason = deferredReason(field, tablesByLogical);
      if (reason) { deferred.push({ table: table.label, field: field.logical, reason }); continue; }
      const spec = toFeishuField(field, tablesByLogical);
      const found = have?.get(field.logical);
      if (found) {
        if (found.type !== spec.type) conflicts.push({ table: table.label, field: field.logical, expected: spec.type, actual: found.type });
        continue;
      }
      (spec.type === "link" ? linkFields : plainFields).push({ op: "create_field", table: table.label, field: spec });
    }
  }
  // Link fields go last so every link target table already exists.
  return { steps: [...createTables, ...plainFields, ...linkFields], deferred, conflicts };
}
