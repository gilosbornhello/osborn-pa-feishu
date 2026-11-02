// Parsers that reproduce legacy hidden-metadata semantics exactly. Used only by
// an optional, later history import — phase 1 installs never call these.

import { clamp100, GOAL_DEFAULTS } from "./priority.js";

const GOAL_PRIORITY_MARKER = /\n?<!--\s*osborn:goal-priority\s+({[\s\S]*?})\s*-->\n?/m;

/**
 * Legacy rule: no marker (or unparsable JSON) → defaults 50/35.
 * Marker present but a field missing → that field is 0, NOT the default.
 * Returns { importanceManual, urgencyManual, source } so the import can record
 * which branch applied.
 */
export function legacyGoalPriorityFromNote(note) {
  const match = String(note || "").match(GOAL_PRIORITY_MARKER);
  if (!match) return { ...GOAL_DEFAULTS, source: "default_no_marker" };
  let raw;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return { ...GOAL_DEFAULTS, source: "default_bad_json" };
  }
  return {
    importanceManual: clamp100(raw.importanceManual ?? raw.importance),
    urgencyManual: clamp100(raw.urgencyManual ?? raw.urgency),
    source: "marker",
  };
}

export function stripLegacyGoalPriority(note) {
  return String(note || "").replace(GOAL_PRIORITY_MARKER, "").trim();
}
