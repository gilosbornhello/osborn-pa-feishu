// Local static server for the workbench prototype (development only).
// Serves the repository read-only on 127.0.0.1; it is not part of the product
// and is never deployed.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT || 4317);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") { res.writeHead(302, { location: "/packages/workbench/index.html" }); return res.end(); }
  const path = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!path.startsWith(root) || path.includes(`${root}local`) || path.includes("/.git")) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`workbench: http://127.0.0.1:${port}/`));
