// Reference storage port for tests and the local workbench prototype.
// Implements the guarantees a production port must prove:
//   - createTimeBlockOnce is atomic per operationKey
//   - updateTimeBlockIfRevision is an atomic compare-and-set
// Fault injection reproduces the failure modes the plan must handle.

import { OutcomeUnknownError } from "./commands.js";

export function createMemoryPort(seed = {}, options = {}) {
  const goals = new Map((seed.goals || []).map((g) => [g.id, { revision: 1, ...g }]));
  const projects = new Map((seed.projects || []).map((p) => [p.id, { revision: 1, ...p }]));
  const blocks = new Map((seed.timeBlocks || []).map((b) => [b.id, { revision: 1, ...b }]));
  const operations = new Map(seed.operations || []); // operationKey -> blockId
  let seq = blocks.size;
  const faults = { loseNextResponse: false, nonAtomicCreate: Boolean(options.nonAtomicCreate), latencyMs: 0, ...options.faults };
  const log = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (x) => (x ? structuredClone(x) : x);

  async function maybeLoseResponse(result) {
    if (faults.loseNextResponse) {
      faults.loseNextResponse = false;
      throw new OutcomeUnknownError("response lost after commit");
    }
    return result;
  }

  return {
    faults, log,
    snapshot() {
      return {
        projects: [...projects.values()].map(clone),
        goals: [...goals.values()].map(clone),
        timeBlocks: [...blocks.values()].map(clone),
        operations: [...operations.entries()],
      };
    },
    async getGoal(id) { return clone(goals.get(id)); },
    async getProject(id) { return clone(projects.get(id)); },
    async getTimeBlock(id) { return clone(blocks.get(id)); },
    async listGoals() { return [...goals.values()].map(clone); },
    async listTimeBlocks({ fromMs = -Infinity, toMs = Infinity } = {}) {
      return [...blocks.values()].filter((b) => b.endMs > fromMs && b.startMs < toMs).map(clone);
    },
    async findOperation(operationKey) {
      const id = operations.get(operationKey);
      return id ? { block: clone(blocks.get(id)) } : null;
    },
    async createTimeBlockOnce(operationKey, row) {
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
      log.push({ op: "create", operationKey, id });
      if (faults.latencyMs && !faults.nonAtomicCreate) await sleep(faults.latencyMs);
      return maybeLoseResponse({ created: true, block: clone(block) });
    },
    async updateTimeBlockIfRevision(operationKey, id, expectedRevision, patch) {
      if (operations.has(operationKey)) {
        return maybeLoseResponse({ duplicate: true, block: clone(blocks.get(id)) });
      }
      const current = blocks.get(id);
      if (current.revision !== expectedRevision) return { conflict: true, block: clone(current) };
      const next = { ...current, ...patch, revision: current.revision + 1 };
      blocks.set(id, next);
      operations.set(operationKey, id);
      log.push({ op: "update", operationKey, id, patch });
      return maybeLoseResponse({ duplicate: false, block: clone(next) });
    },
    async patchGoal(id, patch) {
      const g = goals.get(id);
      goals.set(id, { ...g, ...patch, revision: g.revision + 1 });
    },
  };
}
