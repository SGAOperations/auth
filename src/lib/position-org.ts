// Pure graph helpers for the position org chart. Client-safe: no database, no
// server-only. The position service and the manager picker both use them, and
// the `position_manager_valid` trigger repeats the cycle rule in Postgres.

export type ManagerNode = { id: string; managerPositionId: string | null };

/**
 * True when making `managerId` the manager of `positionId` would loop: the
 * manager is the position itself, or walking up from the manager reaches the
 * position. The walk stops at a missing node or one it has already visited, so
 * a loop that already exists elsewhere cannot hang it.
 */
export function wouldCreateCycle<T extends ManagerNode>(
  nodes: readonly T[],
  positionId: string,
  managerId: string,
): boolean {
  if (managerId === positionId) return true;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  let current = byId.get(managerId);
  for (let step = 0; current && step <= nodes.length; step++) {
    if (current.id === positionId) return true;
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    current = current.managerPositionId
      ? byId.get(current.managerPositionId)
      : undefined;
  }
  return false;
}

/**
 * The nodes from the immediate manager up to the root, in that order. It stops
 * at a manager missing from `nodes` (deleted) and on a revisit. A root has an
 * empty chain.
 */
export function managerChain<T extends ManagerNode>(
  nodes: readonly T[],
  positionId: string,
): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chain: T[] = [];
  const visited = new Set<string>([positionId]);
  let next = byId.get(positionId)?.managerPositionId ?? null;
  while (next && !visited.has(next)) {
    const manager = byId.get(next);
    if (!manager) break;
    visited.add(manager.id);
    chain.push(manager);
    next = manager.managerPositionId;
  }
  return chain;
}

/** Every direct and indirect report of `positionId`. */
export function descendantsOf(
  nodes: readonly ManagerNode[],
  positionId: string,
): Set<string> {
  const reportsByManager = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.managerPositionId) continue;
    const reports = reportsByManager.get(node.managerPositionId) ?? [];
    reports.push(node.id);
    reportsByManager.set(node.managerPositionId, reports);
  }

  const found = new Set<string>();
  const pending = [positionId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) break;
    for (const reportId of reportsByManager.get(id) ?? []) {
      if (reportId === positionId || found.has(reportId)) continue;
      found.add(reportId);
      pending.push(reportId);
    }
  }
  return found;
}
