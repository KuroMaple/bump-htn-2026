export interface GraphNode {
  id: string;
  displayName: string;
  role: string | null;
  company: string | null;
  visualSeed: string;
  joinedAt: string;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  bumpCount: number;
}

export interface GraphSnapshot {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/* Per-node contact card, served by GET /api/nodes/:id when a tile is clicked. */
export interface NodeDetail {
  id: string;
  displayName: string;
  publicAlias: string;
  role: string | null;
  company: string | null;
  bio: string | null;
  visualSeed: string;
  badgeId: string;
  contact: {
    email: string | null;
    phone: string | null;
    linkedin: string | null;
    discord: string | null;
  };
}

export interface BadgePageData {
  badge: {
    displayName: string;
    publicName: string;
    publicAlias: string;
    role: string | null;
    company: string | null;
    bio: string | null;
    visualSeed: string;
    projectorIdentity: "alias" | "real_name" | "hidden";
  };
  connections: Array<{
    id: string;
    displayName: string;
    role: string | null;
    company: string | null;
    visualSeed: string;
    connectedAt: string;
  }>;
  secondDegreeCount: number;
}

export interface AdminBadge {
  id: string;
  hardwareId: string;
  privateToken: string;
  publicAlias: string;
  name: string;
  role: string | null;
  company: string | null;
  projectorIdentity: "alias" | "real_name" | "hidden";
  active: boolean;
}
