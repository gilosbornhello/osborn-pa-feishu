#!/usr/bin/env node
// Writes the files opdev and the webpack plugin expect (../app.json next to
// the block dir, block/block.json) from a local, git-ignored record, so real
// app and block identifiers never enter the repository.
// Usage: node prepare.mjs [record]   (default ../../local/instances/table-view.json)

import { readFileSync, writeFileSync } from "node:fs";

const recordPath = new URL(process.argv[2] ? `file://${process.argv[2]}` : "../../local/instances/table-view.json", import.meta.url);
const rec = JSON.parse(readFileSync(recordPath, "utf8"));
for (const k of ["appId", "blockTypeID", "projectName"]) if (!rec[k]) throw new Error(`record is missing ${k}`);
writeFileSync(new URL("./app.json", import.meta.url), JSON.stringify({ appId: rec.appId }, null, 2) + "\n");
const block = { manifestVersion: 1, blockTypeID: rec.blockTypeID, projectName: rec.projectName };
if (rec.debugBaseUrl) block.url = rec.debugBaseUrl; // dev only: the Base opened for debugging
writeFileSync(new URL("./block/block.json", import.meta.url), JSON.stringify(block, null, 2) + "\n");
console.log("wrote app.json and block/block.json");
