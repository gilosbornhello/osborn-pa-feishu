// Minimal bundler for this repo's own ES modules (no dependencies).
// 妙搭 serves scripts through signed CDN redirects, so a module's relative
// `import` resolves to an unsigned URL and fails; the hosted page therefore
// needs one self-contained script.
//
// Supported, and enforced: single-line `import { a, b as c } from "./x.js"`
// with relative specifiers, and `export function|async function|const|let|class name`.
// Anything else throws, so a new syntax form cannot slip through silently.

import { readFileSync } from "node:fs";

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["'];?\s*$/;
const EXPORT_RE = /^export\s+(?:async\s+function\*?|function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/;

export function bundle(entryUrl) {
  const order = [];
  const ids = new Map();
  const visit = (url, stack) => {
    const key = url.href;
    if (ids.has(key)) return;
    if (stack.includes(key)) throw new Error(`import cycle: ${[...stack, key].join(" -> ")}`);
    const lines = readFileSync(url, "utf8").split("\n");
    const deps = [];
    const exports = [];
    const body = lines.map((line) => {
      if (/^\s*import\b/.test(line) && !/^\s*import\(/.test(line)) {
        const m = line.match(IMPORT_RE);
        if (!m) throw new Error(`unsupported import in ${url.pathname}: ${line}`);
        const dep = new URL(m[2], url);
        deps.push(dep);
        const names = m[1].split(",").map((s) => s.trim()).filter(Boolean)
          .map((s) => s.replace(/^([\w$]+)\s+as\s+([\w$]+)$/, "$1: $2"));
        return { dep, names };
      }
      if (/^\s*export\b/.test(line)) {
        const m = line.match(EXPORT_RE);
        if (!m) throw new Error(`unsupported export in ${url.pathname}: ${line}`);
        exports.push(m[1]);
        return line.replace(/^export\s+/, "");
      }
      return line;
    });
    for (const dep of deps) visit(dep, [...stack, key]);
    ids.set(key, `__m${ids.size}`);
    order.push({ key, body, exports, path: url.pathname });
  };
  visit(entryUrl, []);

  const chunks = order.map(({ key, body, exports, path }) => {
    const code = body.map((l) => (typeof l === "string" ? l : `const { ${l.names.join(", ")} } = ${ids.get(l.dep.href)};`)).join("\n");
    const name = path.split("/").slice(-3).join("/");
    return `// ---- ${name}\nconst ${ids.get(key)} = (() => {\n${code}\nreturn { ${exports.join(", ")} };\n})();`;
  });
  return `// Bundled by tools/bundle-esm.mjs — do not edit.\n${chunks.join("\n\n")}\n`;
}
