// Two independent scoring rules, ported from the legacy Osborn PA algorithms.
//   project-priority@1  "要事为先" — project-level, dynamic urgency
//   goal-priority@1     "轻重缓急" — goal/task-level, manual inputs only
// They share helpers (clamp, quadrant, tier) but are never merged into one
// generic priority field. Every intermediate value is returned so the product
// can explain a score and so a Base formula implementation can be diffed
// against these functions field by field.

import { daysUntil, DEFAULT_TIMEZONE } from "./time.js";

export const PROJECT_RULE_VERSION = "project-priority@1";
export const GOAL_RULE_VERSION = "goal-priority@1";
export const GOAL_DEFAULTS = Object.freeze({ importanceManual: 50, urgencyManual: 35 });
export const QUADRANTS = Object.freeze([
  "important_urgent", "important_not_urgent", "not_important_urgent", "not_important_not_urgent",
]);
export const TIERS = Object.freeze(["P0", "P1", "P2", "P3"]);

/** Number-ish → integer 0..100; anything non-finite → 0 (legacy semantics). */
export function clamp100(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function deriveQuadrant(importance, urgency) {
  const important = clamp100(importance) >= 50;
  const urgent = clamp100(urgency) >= 50;
  if (important && urgent) return "important_urgent";
  if (important) return "important_not_urgent";
  if (urgent) return "not_important_urgent";
  return "not_important_not_urgent";
}

export function deriveTier(score, quadrant) {
  if (quadrant === "important_urgent" || score >= 82) return "P0";
  if (score >= 64) return "P1";
  if (score >= 42) return "P2";
  return "P3";
}

export function deadlinePressure(dueDate, now, tz = DEFAULT_TIMEZONE) {
  const days = daysUntil(dueDate, now, tz);
  if (days === null) return 0;
  if (days < 0) return 34;
  if (days === 0) return 30;
  if (days <= 3) return 24;
  if (days <= 7) return 16;
  if (days <= 14) return 9;
  if (days <= 30) return 4;
  return 0;
}

export function staleReviewPressure(nextReview, now, tz = DEFAULT_TIMEZONE) {
  const days = daysUntil(nextReview, now, tz);
  if (days === null || days >= 0) return 0;
  return Math.min(18, Math.abs(days) * 3);
}

/** Heat of a single stakeholder record (one row of the 相关人 table). */
export function stakeholderHeat(s, now, tz = DEFAULT_TIMEZONE) {
  const influence = clamp100(s.influence ?? 40);
  const sentiment = s.sentiment === "blocked" ? 16 : s.sentiment === "neutral" ? 6 : 0;
  const touch = daysUntil(s.nextTouchpoint, now, tz);
  const touchHeat = touch === null ? 0 : touch < 0 ? 12 : touch <= 2 ? 8 : 0;
  return Math.round((influence / 100) * 10) + sentiment + touchHeat;
}

const COOLDOWN = { parked: 10, archived: 25 };

/**
 * @param {object} p
 * @param {number} p.importanceManual
 * @param {number} p.urgencyManual
 * @param {string|number|null} p.dueDate        calendar date or epoch ms
 * @param {string|number|null} p.nextReview
 * @param {string} p.attentionState              active|watch|parked|archived
 * @param {Array}  p.stakeholders                [{influence, sentiment, nextTouchpoint}]
 * @param {string|null} p.pinnedQuadrant
 * @param {string|null} p.pinnedTier
 */
export function scoreProject(p, now, tz = DEFAULT_TIMEZONE) {
  const importance = clamp100(p.importanceManual);
  const urgency = clamp100(p.urgencyManual);
  const D = deadlinePressure(p.dueDate, now, tz);
  const R = staleReviewPressure(p.nextReview, now, tz);
  const heatPerPerson = (p.stakeholders || []).map((s) => stakeholderHeat(s, now, tz));
  const heatSum = heatPerPerson.reduce((a, b) => a + b, 0);
  const H = Math.min(28, heatSum);
  const K = COOLDOWN[p.attentionState] || 0;
  const dynamicUrgency = clamp100(urgency + D + R + H - K);
  const score = clamp100(0.62 * importance + 0.28 * dynamicUrgency + 0.1 * H);
  const derivedQuadrant = deriveQuadrant(importance, dynamicUrgency);
  const quadrant = p.pinnedQuadrant || derivedQuadrant;
  const tier = p.pinnedTier || deriveTier(score, quadrant);
  return {
    ruleVersion: PROJECT_RULE_VERSION,
    importance, urgency,
    deadlinePressure: D, staleReviewPressure: R,
    stakeholderHeatPerPerson: heatPerPerson, stakeholderHeatSum: heatSum, stakeholderHeat: H,
    cooldown: K, dynamicUrgency, score,
    derivedQuadrant, quadrant, quadrantPinned: Boolean(p.pinnedQuadrant),
    derivedTier: deriveTier(score, quadrant), tier, tierPinned: Boolean(p.pinnedTier),
  };
}

/** Goal score uses manual inputs only — no project pressure is mixed in. */
export function scoreGoal(g) {
  const importance = clamp100(g.importanceManual ?? GOAL_DEFAULTS.importanceManual);
  const urgency = clamp100(g.urgencyManual ?? GOAL_DEFAULTS.urgencyManual);
  const score = clamp100(0.62 * importance + 0.38 * urgency);
  const quadrant = deriveQuadrant(importance, urgency);
  return { ruleVersion: GOAL_RULE_VERSION, importance, urgency, score, quadrant, tier: deriveTier(score, quadrant) };
}

const TIER_RANK = { P0: 4, P1: 3, P2: 2, P3: 1 };
const collator = new Intl.Collator("zh-Hans-CN");

/** Goal ordering: tier, score, importance, title (zh collation). */
export function compareGoals(a, b) {
  return (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0)
    || b.score - a.score
    || b.importance - a.importance
    || collator.compare(String(a.title || ""), String(b.title || ""));
}

/** Project ordering (legacy differs from goals: no tier key): score, importance, title. */
export function compareProjects(a, b) {
  return b.score - a.score
    || b.importance - a.importance
    || collator.compare(String(a.title || ""), String(b.title || ""));
}
