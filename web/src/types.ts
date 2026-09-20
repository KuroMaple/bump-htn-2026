export interface GraphNode {
  id: string;
  kind: "badge" | "session";
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
  sessions: Array<{
    id: string;
    label: string;
    startedAt: string;
    contactCount: number;
  }>;
  visibleThroughSessionId: string | null;
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
  attendeeId: number | null;
  claimId: string | null;
  profileVersion: number | null;
  provisionedAt: string | null;
  contact: {
    email: string | null;
    phone: string | null;
    linkedin: string | null;
    discord: string | null;
  };
}

export interface AttendeeSearchResult {
  id: string;
  officialName: string;
  displayName: string;
  role: string | null;
  company: string | null;
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
    // Full badge-provisioned profile. Served only behind the private token.
    profile: {
      badgeId: string;
      attendeeId: number | null;
      claimId: string | null;
      profileVersion: number | null;
      email: string | null;
      phone: string | null;
      linkedin: string | null;
      discord: string | null;
      provisionedAt: string | null;
    };
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
