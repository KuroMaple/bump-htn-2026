import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { makeAlias } from "./aliases.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { badges, bumpEvents, connections, historicalBadges, historicalConnections } from "./db/schema.js";
import { publish } from "./events.js";
import type { BadgeInput, BumpInput } from "./schemas.js";

function displayName(badge: typeof badges.$inferSelect) {
  return badge.projectorIdentity === "real_name" ? badge.name : badge.publicAlias;
}

export async function getGraph() {
  const visibleBadges = await db
    .select()
    .from(badges)
    .where(and(eq(badges.active, true), ne(badges.projectorIdentity, "hidden")))
    .orderBy(badges.createdAt);

  const visibleIds = visibleBadges.map((badge) => badge.id);
  const allConnections = visibleIds.length
    ? await db
        .select()
        .from(connections)
        .where(and(inArray(connections.badgeAId, visibleIds), inArray(connections.badgeBId, visibleIds)))
        .orderBy(connections.firstSeenAt)
    : [];

  return {
    generatedAt: new Date().toISOString(),
    nodes: visibleBadges.map((badge) => ({
      id: badge.id,
      displayName: displayName(badge),
      role: badge.role,
      company: badge.company,
      visualSeed: badge.visualSeed,
      joinedAt: badge.createdAt.toISOString(),
    })),
    edges: allConnections.map((connection) => ({
      id: connection.id,
      sourceId: connection.badgeAId,
      targetId: connection.badgeBId,
      firstSeenAt: connection.firstSeenAt.toISOString(),
      lastSeenAt: connection.lastSeenAt.toISOString(),
      bumpCount: connection.bumpCount,
    })),
  };
}

export async function getHistoricalGraph() {
  const visibleBadges = await db.select().from(historicalBadges).orderBy(historicalBadges.firstSeenAt);
  const visibleIds = visibleBadges.map((badge) => badge.id);
  const allConnections = visibleIds.length
    ? await db
        .select()
        .from(historicalConnections)
        .where(and(inArray(historicalConnections.badgeAId, visibleIds), inArray(historicalConnections.badgeBId, visibleIds)))
        .orderBy(historicalConnections.firstSeenAt)
    : [];

  return {
    generatedAt: new Date().toISOString(),
    nodes: visibleBadges.map((badge) => ({
      id: badge.id,
      displayName: badge.displayName,
      role: badge.role,
      company: badge.company,
      visualSeed: badge.visualSeed,
      joinedAt: badge.firstSeenAt.toISOString(),
    })),
    edges: allConnections.map((connection) => ({
      id: connection.id,
      sourceId: connection.badgeAId,
      targetId: connection.badgeBId,
      firstSeenAt: connection.firstSeenAt.toISOString(),
      lastSeenAt: connection.lastSeenAt.toISOString(),
      bumpCount: connection.bumpCount,
    })),
  };
}

type GraphWriter = Pick<typeof db, "insert" | "select" | "update">;

async function archiveBadge(writer: GraphWriter, badge: typeof badges.$inferSelect) {
  const [existing] = await writer
    .select()
    .from(historicalBadges)
    .where(eq(historicalBadges.hardwareId, badge.hardwareId))
    .limit(1);
  if (existing) return existing;
  const [archived] = await writer
    .insert(historicalBadges)
    .values({
      id: badge.id,
      hardwareId: badge.hardwareId,
      displayName: displayName(badge),
      role: badge.role,
      company: badge.company,
      visualSeed: badge.visualSeed,
      firstSeenAt: badge.createdAt,
    })
    .returning();
  return archived!;
}

async function archiveAcceptedBump(
  writer: GraphWriter,
  badgeA: typeof badges.$inferSelect,
  badgeB: typeof badges.$inferSelect,
  occurredAt: Date,
) {
  const historicalA = await archiveBadge(writer, badgeA);
  const historicalB = await archiveBadge(writer, badgeB);
  const [first, second] = historicalA.id < historicalB.id
    ? [historicalA, historicalB]
    : [historicalB, historicalA];
  const [existing] = await writer
    .select()
    .from(historicalConnections)
    .where(and(eq(historicalConnections.badgeAId, first.id), eq(historicalConnections.badgeBId, second.id)))
    .limit(1);
  if (existing) {
    await writer
      .update(historicalConnections)
      .set({ lastSeenAt: occurredAt, bumpCount: existing.bumpCount + 1 })
      .where(eq(historicalConnections.id, existing.id));
    return;
  }
  await writer.insert(historicalConnections).values({
    badgeAId: first.id,
    badgeBId: second.id,
    firstSeenAt: occurredAt,
    lastSeenAt: occurredAt,
  });
}

/* Contact card for one node, fetched when a tile is clicked on the projector.
 * Deliberately a per-node lookup rather than folding contact details into
 * /api/graph, so the whole room's contact list is not served in one request.
 * Badges set to "hidden" are excluded entirely. */
export async function getNodeDetail(id: string) {
  const badge = await db.query.badges.findFirst({
    where: and(eq(badges.id, id), eq(badges.active, true)),
  });
  if (!badge || badge.projectorIdentity === "hidden") return null;

  return {
    id: badge.id,
    displayName: badge.name,
    publicAlias: badge.publicAlias,
    role: badge.role,
    company: badge.company,
    bio: badge.bio,
    visualSeed: badge.visualSeed,
    attendeeId: badge.attendeeId,
    claimId: badge.claimId,
    profileVersion: badge.profileVersion,
    provisionedAt: badge.provisionedAt?.toISOString() ?? null,
    contact: {
      email: badge.email,
      phone: badge.phone,
      linkedin: badge.linkedin,
      discord: badge.discord,
    },
  };
}

export async function getBadgePage(token: string) {
  const badge = await db.query.badges.findFirst({
    where: and(eq(badges.privateToken, token), eq(badges.active, true)),
  });
  if (!badge) return null;

  const directEdges = await db
    .select()
    .from(connections)
    .where(or(eq(connections.badgeAId, badge.id), eq(connections.badgeBId, badge.id)))
    .orderBy(desc(connections.lastSeenAt));
  const directIds = directEdges.map((edge) =>
    edge.badgeAId === badge.id ? edge.badgeBId : edge.badgeAId,
  );
  const directBadges = directIds.length
    ? await db.select().from(badges).where(inArray(badges.id, directIds))
    : [];
  const directMap = new Map(directBadges.map((item) => [item.id, item]));

  const secondDegreeEdges = directIds.length
    ? await db
        .select()
        .from(connections)
        .where(
          or(inArray(connections.badgeAId, directIds), inArray(connections.badgeBId, directIds)),
        )
    : [];
  const excluded = new Set([badge.id, ...directIds]);
  const secondDegreeIds = new Set<string>();
  for (const edge of secondDegreeEdges) {
    if (!excluded.has(edge.badgeAId)) secondDegreeIds.add(edge.badgeAId);
    if (!excluded.has(edge.badgeBId)) secondDegreeIds.add(edge.badgeBId);
  }

  return {
    badge: {
      displayName: badge.name,
      publicName: displayName(badge),
      publicAlias: badge.publicAlias,
      role: badge.role,
      company: badge.company,
      bio: badge.bio,
      visualSeed: badge.visualSeed,
      projectorIdentity: badge.projectorIdentity,
      // Full profile — only served here, behind the badge's private token.
      profile: {
        badgeId: badge.hardwareId,
        attendeeId: badge.attendeeId,
        claimId: badge.claimId,
        profileVersion: badge.profileVersion,
        email: badge.email,
        phone: badge.phone,
        linkedin: badge.linkedin,
        discord: badge.discord,
        provisionedAt: badge.provisionedAt ? badge.provisionedAt.toISOString() : null,
      },
    },
    connections: directEdges.flatMap((edge) => {
      const connectionId = edge.badgeAId === badge.id ? edge.badgeBId : edge.badgeAId;
      const connectionBadge = directMap.get(connectionId);
      if (!connectionBadge) return [];
      return [{
        id: connectionBadge.id,
        displayName: displayName(connectionBadge),
        role: connectionBadge.role,
        company: connectionBadge.company,
        visualSeed: connectionBadge.visualSeed,
        connectedAt: edge.firstSeenAt.toISOString(),
      }];
    }),
    secondDegreeCount: secondDegreeIds.size,
  };
}

export async function registerBadge(input: BadgeInput) {
  const visualSeed = randomBytes(16).toString("hex");
  // Map the badge's broadcast profile onto columns. Every field is optional;
  // undefined is normalised to null so a re-register can clear a stale value.
  const profile = {
    role: input.role || null,
    company: input.company || null,
    bio: input.bio || null,
    attendeeId: input.attendeeId ?? null,
    profileVersion: input.profileVersion ?? null,
    claimId: input.claimId || null,
    email: input.email || null,
    phone: input.phone || null,
    linkedin: input.linkedin || null,
    discord: input.discord || null,
    provisionedAt: input.provisionedUnix ? new Date(input.provisionedUnix * 1000) : null,
  };
  const [badge] = await db
    .insert(badges)
    .values({
      hardwareId: input.hardwareId,
      name: input.name,
      projectorIdentity: input.projectorIdentity,
      ...profile,
      visualSeed,
      publicAlias: makeAlias(visualSeed),
      privateToken: randomBytes(24).toString("base64url"),
    })
    .onConflictDoUpdate({
      target: badges.hardwareId,
      set: {
        name: input.name,
        projectorIdentity: input.projectorIdentity,
        ...profile,
        updatedAt: new Date(),
      },
    })
    .returning();
  publish({ type: "graph:refresh" });
  return badge;
}

/* Reset the board between runs.
 *
 * "edges" keeps the roster and wipes connections plus the raw bump event log.
 * "all" additionally drops every badge except `keep` — the root/observer
 * badge, which must survive or the next bump has no counterpart and the star
 * graph can never rebuild.
 *
 * bump_events must go in both cases: it holds the event_id dedup keys, so
 * leaving it would make a replayed encounter come back as duplicate_event and
 * the edge would never reappear. */
export async function clearGraph(scope: "edges" | "all", keep: string[] = []) {
  const keepIds = keep.filter(Boolean);
  const cleared = await db.transaction(async (tx) => {
    /* The gateway ingests continuously. Without this lock, a bump committed
     * between the connections delete and the badges delete inserts a row
     * referencing a badge being removed, and the foreign key aborts the whole
     * clear. Writers block briefly; readers such as /api/graph are unaffected. */
    await tx.execute(
      sql`lock table ${bumpEvents}, ${connections}, ${badges} in share row exclusive mode`,
    );

    const removedEvents = await tx.delete(bumpEvents).returning({ id: bumpEvents.id });
    const removedEdges = await tx.delete(connections).returning({ id: connections.id });
    let removedBadges: Array<{ id: string }> = [];
    if (scope === "all") {
      removedBadges = keepIds.length
        ? await tx
            .delete(badges)
            .where(notInArray(badges.hardwareId, keepIds))
            .returning({ id: badges.id })
        : await tx.delete(badges).returning({ id: badges.id });
    }
    return {
      scope,
      kept: keepIds,
      bumpEvents: removedEvents.length,
      connections: removedEdges.length,
      badges: removedBadges.length,
    };
  });

  publish({ type: "graph:refresh" });
  return cleared;
}

export async function listBadges() {
  return db.select().from(badges).orderBy(badges.name);
}

export async function processBump(input: BumpInput) {
  const reportedAt = new Date(input.timestamp);
  const result = await db.transaction(async (tx) => {
    const [rawEvent] = await tx
      .insert(bumpEvents)
      .values({
        eventId: input.event_id,
        hardwareIdA: input.badge_id_a,
        hardwareIdB: input.badge_id_b,
        observerId: input.observer_id ?? null,
        source: input.source,
        reportedAt,
        signalStrength: input.signal_strength ?? null,
      })
      .onConflictDoNothing({ target: bumpEvents.eventId })
      .returning();

    if (!rawEvent) return { status: "duplicate_event" as const };

    const matchingBadges = await tx
      .select()
      .from(badges)
      .where(
        and(
          inArray(badges.hardwareId, [input.badge_id_a, input.badge_id_b]),
          eq(badges.active, true),
        ),
      );
    const badgeA = matchingBadges.find((badge) => badge.hardwareId === input.badge_id_a);
    const badgeB = matchingBadges.find((badge) => badge.hardwareId === input.badge_id_b);

    if (!badgeA || !badgeB) {
      const missing = [!badgeA ? input.badge_id_a : null, !badgeB ? input.badge_id_b : null]
        .filter(Boolean)
        .join(", ");
      await tx
        .update(bumpEvents)
        .set({ status: "unknown_badge", reason: `Unknown badge: ${missing}` })
        .where(eq(bumpEvents.id, rawEvent.id));
      return { status: "unknown_badge" as const, missing };
    }

    const [first, second] = badgeA.id < badgeB.id ? [badgeA, badgeB] : [badgeB, badgeA];
    const existing = await tx.query.connections.findFirst({
      where: and(
        eq(connections.badgeAId, first.id),
        eq(connections.badgeBId, second.id),
      ),
    });
    const windowMilliseconds = config.DEDUPE_WINDOW_SECONDS * 1000;

    if (existing && reportedAt.getTime() - existing.lastSeenAt.getTime() < windowMilliseconds) {
      await tx
        .update(bumpEvents)
        .set({ status: "duplicate_window", reason: `${config.DEDUPE_WINDOW_SECONDS}s window` })
        .where(eq(bumpEvents.id, rawEvent.id));
      return { status: "duplicate_window" as const, connectionId: existing.id };
    }

    const strongest = input.signal_strength == null
      ? existing?.strongestSignalStrength ?? null
      : Math.max(input.signal_strength, existing?.strongestSignalStrength ?? -Infinity);
    const [connection] = await tx
      .insert(connections)
      .values({
        badgeAId: first.id,
        badgeBId: second.id,
        firstSeenAt: reportedAt,
        lastSeenAt: reportedAt,
        latestSignalStrength: input.signal_strength ?? null,
        strongestSignalStrength: Number.isFinite(strongest ?? NaN) ? strongest : null,
      })
      .onConflictDoUpdate({
        target: [connections.badgeAId, connections.badgeBId],
        set: {
          lastSeenAt: reportedAt,
          bumpCount: (existing?.bumpCount ?? 0) + 1,
          latestSignalStrength: input.signal_strength ?? null,
          strongestSignalStrength: Number.isFinite(strongest ?? NaN) ? strongest : null,
          updatedAt: new Date(),
        },
      })
      .returning();

    await archiveAcceptedBump(tx, badgeA, badgeB, reportedAt);

    await tx
      .update(bumpEvents)
      .set({ status: "accepted" })
      .where(eq(bumpEvents.id, rawEvent.id));

    return {
      status: "accepted" as const,
      connection: {
        id: connection!.id,
        sourceId: connection!.badgeAId,
        targetId: connection!.badgeBId,
        occurredAt: reportedAt.toISOString(),
      },
    };
  });

  if (result.status === "accepted") {
    publish({ type: "bump:accepted", connection: result.connection });
  }
  return result;
}
