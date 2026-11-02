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
//   conflict   expectedRevision is stale; current state is returned
//   rejected   validation or permission failure; nothing was written
//   unknown    the outcome could not be confirmed (e.g. response lost);
//              callers must reconcile(operationKey) instead of retrying blindly

import { canEditTimeBlock, canScheduleGoal, POLICY_VERSION } from "./policy.js";

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

/** Move an existing block (drag inside the calendar, or edit the times). */
export async function rescheduleBlock(port, actor, { blockId, startMs, endMs, expectedRevision, operationKey }) {
  const timeError = validateTimeRange({ startMs, endMs });
  if (timeError) return receipt("rejected", { operationKey, reason: timeError });
  return updateBlock(port, actor, { blockId, expectedRevision, operationKey, patch: { startMs, endMs } });
}

export async function cancelBlock(port, actor, { blockId, expectedRevision, operationKey }) {
  return updateBlock(port, actor, { blockId, expectedRevision, operationKey, patch: { state: "cancelled" } });
}

/** Marking a block done does NOT complete its goal (product decision pending, R-01). */
export async function completeBlock(port, actor, { blockId, expectedRevision, operationKey }) {
  return updateBlock(port, actor, { blockId, expectedRevision, operationKey, patch: { state: "done" } });
}

async function updateBlock(port, actor, { blockId, expectedRevision, operationKey, patch }) {
  if (!operationKey) return receipt("rejected", { reason: "operation_key_required" });
  if (!Number.isInteger(expectedRevision)) return receipt("rejected", { operationKey, reason: "expected_revision_required" });
  const block = await port.getTimeBlock(blockId);
  if (!block) return receipt("rejected", { operationKey, reason: "block_not_found" });
  if (!canEditTimeBlock(actor, block)) return receipt("rejected", { operationKey, reason: "forbidden" });
  if (block.state === "cancelled" && patch.state !== "cancelled") {
    return receipt("rejected", { operationKey, reason: "block_cancelled" });
  }
  return guard(port, operationKey, async () => {
    const result = await port.updateTimeBlockIfRevision(operationKey, blockId, expectedRevision, patch);
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
