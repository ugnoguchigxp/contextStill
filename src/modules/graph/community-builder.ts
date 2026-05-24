import { createHash } from "node:crypto";

export type CommunityNodeInput = {
  id: string;
  weight: number;
};

export type CommunityEdgeInput = {
  source: string;
  target: string;
  weight: number;
};

export type CommunityAssignment = {
  communityId: string;
  communityRank: number;
  communitySize: number;
  communityKey: string;
  communityLabel: string;
};

export type CommunityComponent = {
  communityId: string;
  communityRank: number;
  communitySize: number;
  communityKey: string;
  members: string[];
};

export type CommunityBuildResult = {
  assignments: Map<string, CommunityAssignment>;
  components: CommunityComponent[];
  communityCount: number;
  largestCommunitySize: number;
  orphanNodeCount: number;
};

export function rawKnowledgeId(nodeId: string): string {
  return nodeId.replace(/^knowledge:/, "");
}

function hashCommunityMembers(memberNodeIds: string[]): string {
  const digestSource = memberNodeIds
    .map((id) => rawKnowledgeId(id))
    .sort()
    .join(",");
  return createHash("sha256").update(digestSource).digest("hex");
}

export function buildCommunityAssignments(params: {
  nodes: CommunityNodeInput[];
  edges: CommunityEdgeInput[];
  minEdgeWeight: number;
}): CommunityBuildResult {
  const ids = params.nodes.map((node) => node.id);
  if (ids.length === 0) {
    return {
      assignments: new Map(),
      components: [],
      communityCount: 0,
      largestCommunitySize: 0,
      orphanNodeCount: 0,
    };
  }

  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const knownIds = new Set(ids);
  const nodeWeightById = new Map(params.nodes.map((node) => [node.id, node.weight]));

  const find = (id: string): string => {
    let cursor = id;
    while ((parent.get(cursor) ?? cursor) !== cursor) {
      cursor = parent.get(cursor) ?? cursor;
    }
    let compress = id;
    while ((parent.get(compress) ?? compress) !== cursor) {
      const next = parent.get(compress) ?? compress;
      parent.set(compress, cursor);
      compress = next;
    }
    return cursor;
  };

  const union = (left: string, right: string) => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft === rootRight) return;
    const leftRank = rank.get(rootLeft) ?? 0;
    const rightRank = rank.get(rootRight) ?? 0;
    if (leftRank < rightRank) {
      parent.set(rootLeft, rootRight);
      return;
    }
    if (leftRank > rightRank) {
      parent.set(rootRight, rootLeft);
      return;
    }
    parent.set(rootRight, rootLeft);
    rank.set(rootLeft, leftRank + 1);
  };

  for (const edge of params.edges) {
    if (edge.weight < params.minEdgeWeight) continue;
    if (!knownIds.has(edge.source) || !knownIds.has(edge.target)) continue;
    union(edge.source, edge.target);
  }

  const componentMembers = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const members = componentMembers.get(root) ?? [];
    members.push(id);
    componentMembers.set(root, members);
  }

  const sortedComponentMembers = [...componentMembers.values()].map((members) =>
    [...members].sort((a, b) => rawKnowledgeId(a).localeCompare(rawKnowledgeId(b))),
  );
  sortedComponentMembers.sort((a, b) => {
    const sizeDiff = b.length - a.length;
    if (sizeDiff !== 0) return sizeDiff;
    const maxWeightA = Math.max(...a.map((id) => nodeWeightById.get(id) ?? 0));
    const maxWeightB = Math.max(...b.map((id) => nodeWeightById.get(id) ?? 0));
    const weightDiff = maxWeightB - maxWeightA;
    if (Math.abs(weightDiff) > Number.EPSILON) return weightDiff;
    const firstA = a[0] ?? "";
    const firstB = b[0] ?? "";
    return rawKnowledgeId(firstA).localeCompare(rawKnowledgeId(firstB));
  });

  const components: CommunityComponent[] = [];
  const assignments = new Map<string, CommunityAssignment>();
  let orphanNodeCount = 0;
  for (let index = 0; index < sortedComponentMembers.length; index += 1) {
    const members = sortedComponentMembers[index];
    if (!members) continue;
    const communityRank = index + 1;
    const communityId = `community:${communityRank}`;
    const communitySize = members.length;
    const communityKey = hashCommunityMembers(members);
    const communityLabel = communityId;
    components.push({
      communityId,
      communityRank,
      communitySize,
      communityKey,
      members,
    });
    if (communitySize === 1) orphanNodeCount += 1;
    for (const member of members) {
      assignments.set(member, {
        communityId,
        communityRank,
        communitySize,
        communityKey,
        communityLabel,
      });
    }
  }

  return {
    assignments,
    components,
    communityCount: components.length,
    largestCommunitySize: components[0]?.communitySize ?? 0,
    orphanNodeCount,
  };
}
