#!/usr/bin/env node
// Writes packages/schema/manifest.js from manifest.json so browser bundles
// (which cannot import JSON) carry the same manifest. A test keeps them equal.
import { readFileSync, writeFileSync } from "node:fs";

const json = JSON.parse(readFileSync(new URL("../packages/schema/manifest.json", import.meta.url), "utf8"));
writeFileSync(new URL("../packages/schema/manifest.js", import.meta.url),
  `// Generated from manifest.json by tools/gen-manifest-js.mjs. Do not edit.\nexport const MANIFEST = ${JSON.stringify(json, null, 2)};\n`);
console.log("wrote packages/schema/manifest.js");
