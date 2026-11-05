// Write self-test inside the table-view host (selftest.html in the same
// package, opened from the workbench menu). Test Bases only.
import { bitable } from "@lark-opdev/block-bitable-api";

globalThis.__osbornBitable = bitable;
const back = Object.assign(document.createElement("a"), { href: "./index.html", textContent: "← 返回工作台" });
back.style.cssText = "display:inline-block;margin-bottom:8px;color:inherit";
document.body.prepend(back);
import("../../../workbench/src/selftest.js");
