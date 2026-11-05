// Core write contract shared by every entry point (workbench UI, CLI, future
// Agents). Commands validate input, check policy, then call a storage port.
//
// The port decides HOW uniqueness and revision checks are guaranteed. The
// in-memory port provides them atomically; a Feishu Base port must prove an
// equivalent platform mechanism before it may claim `atomicCreate: true`
// (see docs/plan, section "core write consistency"). Commands never "check
// then write" themselves, because that leaves a race window.
//
// Receipt statuses:
//   committed  the write happened now
//   duplicate  same operationKey already committed; the original result is returned
//   conflict   expectedRevision is stale, or the block no longer matches the
//              `expected` snapshot the caller saw (e.g. edited by hand in the
//              table, which does not bump revision); current state is returned
//   rejected   validation or permission failure; nothing was written
//   unknown    the outcome could not be confirmed (e.g. response lost);
//              callers must reconcile(operationKey) instead of retrying blindly

import { canEditTimeBlock, canScheduleGoal, POLICY_VERSION } from "./policy.js";
import { BUCKETS } from "./period-shift.js";

export const COMMAND_CONTRACT_VERSION = "commands@1";
export const MAX_BLOCK_MS = 31 * 86_400_000;

export class OutcomeUnknownError extends Error {
  constructor(message = "outcome unknown") { super(message); this.name = "OutcomeUnknownError"; }
}

export function validateTimeRange({ startMs, endMs }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "invalid_time";
  if (endMs <= startMs) return "end_not_after_start";
  if (endMs - startMs > MAX_BLOCK_MS) return "too_long";
  return null;
}

export function validateTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) return "empty_title";
  if (t.length > 200) return "title_too_long";
  return null;
}

function receipt(status, extra = {}) {
  return { contract: COMMAND_CONTRACT_VERSION, policy: POLICY_VERSION, status, ...extra };
}

async function guard(port, operationKey, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OutcomeUnknownError) return receipt("unknown", { operationKey, reason: err.message });
    throw err;
  }
}

/**
 * Drag a goal (or pick one with the keyboard) into a time slot.
 * Creates exactly one time block per operationKey. Never archives, completes,
 * or changes the due date of the goal (see audit finding R-01 for the legacy
 * difference that needs a product decision).
 */
export async function scheduleGoal(port, actor, { goalId, startMs, endMs, operationKey, timezone }) {
  if (!operationKey) return receipt("rejected", { reason: "operation_key_required" });
  const timeError = validateTimeRange({ startMs, endMs });
  if (timeError) return receipt("rejected", { operationKey, reason: timeError });
  const goal = await port.getGoal(goalId);
  if (!goal || goal.archived) return receipt("rejected", { operationKey, reason: "goal_not_found_or_archived" });
  const project = goal.projectId ? await port.getProject(goal.projectId) : null;
  if (!canScheduleGoal(actor, goal, project)) return receipt("rejected", { operationKey, reason: "forbidden" });
  return guard(port, operationKey, async () => {
    const result = await port.createTimeBlockOnce(operationKey, {
      title: goal.title, goalId: goal.id, projectId: goal.projectId ?? null,
      ownerId: actor.userId, startMs, endMs, allDay: false,
      timezone: timezone || "Asia/Shanghai", state: "planned", source: actor.source || "workbench",
    });
    return receipt(result.created ? "committed" : "duplicate", { operationKey, block: result.block });
  });
}

/**
 * Quick-add a goal owned by the actor (workbench "新建目标"). One goal per
 * operationKey. Guests and unregistered viewers cannot create goals.
 */
export async function createGoal(port, actor, { title, bucket = "inbox", visibility = "project", operationKey }) {
  if (!operationKey) return receipt("rejected", { reason: "operation_key_required" });
  if (!actor?.userId || actor.role === "guest" || actor.registered === false) return receipt("rejected", { operationKey, reason: "forbidden" });
  const titleError = validateTitle(title);
  if (titleError) return receipt("rejected", { operationKey, reason: titleError });
  if (!BUCKETS.includes(bucket)) return receipt("rejected", { operationKey, reason: "invalid_bucket" });
  if (!["private", "project"].includes(visibility)) return receipt("rejected", { operationKey, reason: "invalid_visibility" });
  return guard(port, operationKey, async () => {
    const result = await port.createGoalOnce(operationKey, {
      title: String(title).trim(), ownerId: actor.userId, owner: actor.account || null,
      bucket, visibility, status: "not_started", archived: false,
    });
    return receipt(result.created ? "committed" : "duplicate", { operationKey, goal: result.goal });
  });
}

/**
 * Self-service join for a Base extension viewer who is not in the members
 * table yet. If the Base has no active admin, the first person to join becomes
 * admin; everyone else joins as member. Deactivated members cannot rejoin.
 */
export async function joinWorkspace(port, viewer) {
  if (!viewer?.userId) return receipt("rejected", { reason: "no_user" });
  if (viewer.registered) return receipt("duplicate", { role: viewer.role });
  if (viewer.canJoin === false) return receipt("rejected", { reason: "member_inactive" });
  const role = (await port.countActiveAdmins()) === 0 ? "admin" : "member";
  return guard(port, `join:${viewer.userId}`, async () => {
    const r = await port.addMemberOnce(viewer.userId, role);
    return receipt(r.created ? "committed" : "duplicate", { role: r.created ? role : undefined });
  });
}

/** Move an existing block (drag inside the calendar, or edit the times). */
// `expected` (optional): { startMs, endMs, state } as the caller last saw the
// block. The port reports a conflict if any given field differs, so an edit
// that did not bump revision is not silently overwritten.
export async function rescheduleBlock(port, actor, { blockId, startMs, endMs, expectedRevision, operationKey, expected }) {
  const timeError = validateTimeRange({ startMs, endMs });
  if (timeError) return receipt("rejected", { operationKey, reason: timeError });
  return updateBlock(port, actor, { blockId, expectedRevision, operationKey, expected, patch: { startMs, endMs } });
}

export async function cancelBlock(port, actor, { blockId, expectedRevision, operationKey, expected }) {
  return updateBlock(port, actor, { blockId, expectedRevision, operationKey, expected, patch: { state: "cancelled" } });
}

/** Marking a block done does NOT complete its goal (product decision pending, R-01). */
export async function completeBlock(port, actor, { blockId, expectedRevision, operationKey, expected }) {
  return updateBlock(port, actor, { blockId, expectedRevision, operationKey, expected, patch: { state: "done" } });
}

/** Fields of `expected` that differ from `block` (empty when it still matches). */
export function snapshotMismatch(block, expected) {
  if (!expected || !block) return [];
  return ["startMs", "endMs", "state"].filter((k) => k in expected && expected[k] !== block[k]);
}

async function updateBlock(port, actor, { blockId, expectedRevision, operationKey, expected, patch }) {
  if (!operationKey) return receipt("rejected", { reason: "operation_key_required" });
  if (!Number.isInteger(expectedRevision)) return receipt("rejected", { operationKey, reason: "expected_revision_required" });
  const block = await port.getTimeBlock(blockId);
  if (!block) return receipt("rejected", { operationKey, reason: "block_not_found" });
  if (!canEditTimeBlock(actor, block)) return receipt("rejected", { operationKey, reason: "forbidden" });
  if (block.state === "cancelled" && patch.state !== "cancelled") {
    return receipt("rejected", { operationKey, reason: "block_cancelled" });
  }
  return guard(port, operationKey, async () => {
    const result = await port.updateTimeBlockIfRevision(operationKey, blockId, expectedRevision, patch, expected);
    if (result.conflict) return receipt("conflict", { operationKey, current: result.block });
    return receipt(result.duplicate ? "duplicate" : "committed", { operationKey, block: result.block });
  });
}

/** After an `unknown` receipt: ask storage what actually happened. */
export async function reconcile(port, operationKey) {
  const found = await port.findOperation(operationKey);
  if (!found) return receipt("not_committed", { operationKey });
  return receipt("duplicate", { operationKey, block: found.block });
}
