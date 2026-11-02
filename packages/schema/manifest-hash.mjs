// Canonical hash of the logical manifest. Two instances installed from the
// same manifest must report the same hash in their install record; evidence
// for a test run is only valid for the hash it was produced against.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function manifestHash(manifest) {
  return createHash("sha256").update(canonicalize(manifest)).digest("hex");
}

export function loadManifest() {
  return JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = loadManifest();
  console.log(JSON.stringify({ schemaVersion: m.schemaVersion, sha256: manifestHash(m) }));
}
