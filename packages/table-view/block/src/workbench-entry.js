// Table-view extension entry: hand the bundled Base SDK to the workbench,
// then start it. The workbench itself is unchanged (packages/workbench).
import { bitable } from "@lark-opdev/block-bitable-api";
import "../../../workbench/src/workbench.css";

globalThis.__osbornBitable = bitable;
import("../../../workbench/src/app.js");
