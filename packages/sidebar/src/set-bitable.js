// Evaluated before the workbench module (see entry.js import order): hand it
// the bundled sidebar SDK so nothing is fetched from a CDN at runtime.
import { bitable } from "@lark-base-open/js-sdk";

globalThis.__osbornBitable = bitable;
