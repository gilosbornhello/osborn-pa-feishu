import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundle } from "../bundle-esm.mjs";

const entry = new URL("../../packages/workbench/src/app.js", import.meta.url);

test("workbench bundle has no import/export statements left", () => {
  const out = bundle(entry);
  assert.ok(!/^\s*(import|export)\s/m.test(out));
  assert.match(out, /rules\/src\/time\.js/);
});

test("bundled rules modules behave like the originals", async () => {
  const out = bundle(new URL("../../packages/rules/src/priority.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  const file = join(dir, "b.mjs");
  const last = out.match(/const (__m\d+) = \(\(\) => \{(?![\s\S]*const __m\d+ = )/)[1];
  writeFileSync(file, `${out}\nexport default ${last};\n`);
  const bundled = (await import(pathToFileURL(file).href)).default;
  const original = await import("../../packages/rules/src/priority.js");
  const now = Date.parse("2026-11-02T10:00:00+08:00");
  const p = { importanceManual: 80, urgencyManual: 40, dueDate: "2026-11-05" };
  assert.deepEqual(bundled.scoreProject(p, now, "Asia/Shanghai"), original.scoreProject(p, now, "Asia/Shanghai"));
});

test("unsupported syntax fails loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  writeFileSync(join(dir, "a.js"), 'export default 1;\n');
  assert.throws(() => bundle(pathToFileURL(join(dir, "a.js"))), /unsupported export/);
  writeFileSync(join(dir, "b.js"), 'import x from "./a.js";\n');
  assert.throws(() => bundle(pathToFileURL(join(dir, "b.js"))), /unsupported import/);
});
