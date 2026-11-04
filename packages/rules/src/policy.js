// access-policy@1 — the product's recommended permission semantics, used by
// every write path (UI, CLI, Agent) before touching storage.
//
// This is the business policy, NOT proof that Feishu enforces it. A Base
// adapter must additionally be backed by platform permissions (advanced
// permissions / app roles) so that direct table access cannot bypass it.
// "private" means hidden from members and guests; instance admins can still
// read it (audit finding P-02: a single Base cannot promise admin-blindness).

export const POLICY_VERSION = "access-policy@1";

export function canReadGoal(actor, goal, project) {
  if (!actor || !goal) return false;
  if (actor.role === "admin") return true;
  if (isPersonOnGoal(actor, goal)) return true;
  if (goal.visibility === "private") return false;
  if (!goal.projectId) return false;
  if (actor.role === "guest") return Boolean(project?.guestReadable && goal.guestShared);
  return (actor.projectIds || []).includes(goal.projectId);
}

export function canScheduleGoal(actor, goal, project) {
  if (!canReadGoal(actor, goal, project)) return false;
  if (actor.role === "guest") return false;
  if (actor.role === "admin") return true;
  if (isPersonOnGoal(actor, goal)) return true;
  return actor.role === "project_admin" && (actor.adminProjectIds || []).includes(goal.projectId);
}

export function canEditTimeBlock(actor, block) {
  if (!actor || !block) return false;
  if (actor.role === "guest") return false;
  if (actor.role === "admin") return true;
  return block.ownerId === actor.userId;
}

/** Busy/free view of someone else's block: interval only, no title or goal. */
/** Others see only busy/free; a cancelled block is free time, so they get null. */
export function redactBlockForViewer(actor, block) {
  if (canEditTimeBlock(actor, block) || actor?.role === "admin") return block;
  if (block.state === "cancelled") return null;
  return { id: block.id, ownerId: block.ownerId, startMs: block.startMs, endMs: block.endMs, allDay: block.allDay, busy: true };
}

function isPersonOnGoal(actor, goal) {
  return goal.ownerId === actor.userId || (goal.assigneeIds || []).includes(actor.userId);
}
