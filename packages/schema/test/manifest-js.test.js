import { test } from "node:test";
import assert from "node:assert/strict";
import { MANIFEST } from "../manifest.js";
import { loadManifest } from "../manifest-hash.mjs";

test("manifest.js matches manifest.json (run tools/gen-manifest-js.mjs after editing the JSON)", () => {
  assert.deepEqual(MANIFEST, loadManifest());
});
