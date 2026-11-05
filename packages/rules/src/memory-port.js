// Reference storage port for tests and the local workbench prototype.
// Implements the guarantees a production port must prove:
//   - createTimeBlockOnce is atomic per operationKey
//   - updateTimeBlockIfRevision is an atomic compare-and-set
// Fault injection reproduces the failure modes the plan must handle.
// Optional `store` ({ load(), save(snapshot) }) makes the port share state
// with other ports (e.g. browser tabs over localStorage): every call reloads
// first and every write saves in the same synchronous step as its check, so
// a stale tab gets a conflict instead of overwriting newer data.

import { OutcomeUnknownError, snapshotMismatch } from "./commands.js";

export function createMemoryPort(seed = {}, options = {}) {
  let goals, projects, blocks, operations, seq;
  const load = (s) => {
    goals = new Map((s.goals || []).map((g) => [g.id, { revision: 1, ...g }]));
    projects = new Map((s.projects || []).map((p) => [p.id, { revision: 1, ...p }]));
    blocks = new Map((s.timeBlocks || []).map((b) => [b.id, { revision: 1, ...b }]));
    operations = new Map(s.operations || []); // operationKey -> blockId
    seq = Math.max(blocks.size, ...[...blocks.keys()].map((id) => Number(id.split("_")[1]) || 0));
  };
  const { store } = options;
  load((store && store.load()) || seed);
  const refresh = () => { const s = store && store.load(); if (s) load(s); };
  const save = () => { if (store) store.save(snapshot()); };
  const faults = { loseNextResponse: false, failNextBeforeCommit: false, nonAtomicCreate: Boolean(options.nonAtomicCreate), latencyMs: 0, ...options.faults };
  const log = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (x) => (x ? structuredClone(x) : x);

  function maybeFailBeforeCommit() {
    if (faults.failNextBeforeCommit) {
      faults.failNextBeforeCommit = false;
      throw new OutcomeUnknownError("request failed before commit");
    }
  }

  function snapshot() {
    return {
      projects: [...projects.values()].map(clone),
      goals: [...goals.values()].map(clone),
      timeBlocks: [...blocks.values()].map(clone),
      operations: [...operations.entries()],
    };
  }
  save();

  async function maybeLoseResponse(result) {
    if (faults.loseNextResponse) {
      faults.loseNextResponse = false;
      throw new OutcomeUnknownError("response lost after commit");
    }
    return result;
  }

  return {
    faults, log, snapshot,
    async getGoal(id) { refresh(); return clone(goals.get(id)); },
    async getProject(id) { refresh(); return clone(projects.get(id)); },
    async getTimeBlock(id) { refresh(); return clone(blocks.get(id)); },
    async listGoals() { refresh(); return [...goals.values()].map(clone); },
    async listTimeBlocks({ fromMs = -Infinity, toMs = Infinity } = {}) {
      refresh();
      return [...blocks.values()].filter((b) => b.endMs > fromMs && b.startMs < toMs).map(clone);
    },
    async findOperation(operationKey) {
      refresh();
      const id = operations.get(operationKey);
      return id ? { block: clone(blocks.get(id)) } : null;
    },
    async createTimeBlockOnce(operationKey, row) {
      maybeFailBeforeCommit();
      refresh();
      if (faults.nonAtomicCreate) {
        // Simulates "query then insert" on a store without unique constraints.
        const seen = operations.has(operationKey);
        await sleep(faults.latencyMs || 5);
        if (seen) return maybeLoseResponse({ created: false, block: clone(blocks.get(operations.get(operationKey))) });
      } else if (operations.has(operationKey)) {
        return maybeLoseResponse({ created: false, block: clone(blocks.get(operations.get(operationKey))) });
      }
      const id = `tb_${++seq}`;
      const block = { id, ...row, operationKey, revision: 1 };
      blocks.set(id, block);
      operations.set(operationKey, id);
      save();
      log.push({ op: "create", operationKey, id });
      if (faults.latencyMs && !faults.nonAtomicCreate) await sleep(faults.latencyMs);
      return maybeLoseResponse({ created: true, block: clone(block) });
    },
    async updateTimeBlockIfRevision(operationKey, id, expectedRevision, patch, expected) {
      maybeFailBeforeCommit();
      refresh();
      if (operations.has(operationKey)) {
        return maybeLoseResponse({ duplicate: true, block: clone(blocks.get(id)) });
      }
      const current = blocks.get(id);
      if (current.revision !== expectedRevision || snapshotMismatch(current, expected).length) return { conflict: true, block: clone(current) };
      const next = { ...current, ...patch, revision: current.revision + 1 };
      blocks.set(id, next);
      operations.set(operationKey, id);
      save();
      log.push({ op: "update", operationKey, id, patch });
      return maybeLoseResponse({ duplicate: false, block: clone(next) });
    },
    async createGoalOnce(operationKey, row) {
      maybeFailBeforeCommit();
      refresh();
      const businessId = `g:${operationKey}`;
      const existing = [...goals.values()].find((g) => g.businessId === businessId);
      if (existing) return maybeLoseResponse({ created: false, goal: clone(existing) });
      const { owner, ...rest } = row;
      let id;
      do id = `goal_${++seq}`; while (goals.has(id));
      const goal = { id, businessId, ...rest, revision: 1 };
      goals.set(goal.id, goal);
      save();
      log.push({ op: "createGoal", operationKey, id: goal.id });
      return maybeLoseResponse({ created: true, goal: clone(goal) });
    },
    async patchGoal(id, patch) {
      refresh();
      const g = goals.get(id);
      goals.set(id, { ...g, ...patch, revision: g.revision + 1 });
      save();
    },
  };
}
