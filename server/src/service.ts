import { randomBytes } from "node:crypto";
import { and, desc, eq, ilike, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { makeAlias } from "./aliases.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { badges, bumpEvents, connections, historicalBadges, historicalConnections, syncSessionMembers, syncSessions } from "./db/schema.js";
import { publish } from "./events.js";
import type { BadgeInput, BumpInput, SyncSessionInput } from "./schemas.js";

function displayName(badge: typeof badges.$inferSelect) {
  return badge.projectorIdentity === "real_name" ? badge.name : badge.publicAlias;
}

type ProjectedBadge = {
  id: string;
  hardwareId: string;
  displayName: string;
  role: string | null;
  company: string | null;
  visualSeed: string;
  joinedAt: Date;
};

/* Timeline steps are clock hours in the event's local timezone, derived from
 * when each bump actually happened (bump_events.reported_at), not from when a
 * gateway happened to upload. Nothing is stored per step: the buckets fall out
 * of the timestamps on read, so a future bump lands in the right hour with no
 * extra bookkeeping and no rows to keep in sync.
 *
 * Badges have no RTC, so reported_at is the gateway's reconstructed wall clock.
 * An hour bucket is only as accurate as that reconstruction. */
const TIMELINE_ZONE = "America/Toronto";

/* Stable, sortable key for the local clock hour, e.g. "2026-09-19T14".
 * h23 rather than hour12:false: the latter renders midnight as 24 under some
 * ICU builds, which would sort a day's first hour last. */
const HOUR_KEY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMELINE_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});

function hourKey(at: Date) {
  const parts = HOUR_KEY_FORMAT.formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}`;
}

function hourLabel(key: string) {
  const hour = Number(key.slice(11, 13));
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 === 0 ? 12 : hour % 12} ${suffix}`;
}

function hourDateLabel(key: string) {
  const [year, month, day] = key.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.toLocaleDateString("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

type TimelineContact = {
  observerHardwareId: string;
  peerHardwareId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  bumpCount: number;
};

type TimelineStep = {
  key: string;
  startedAt: Date;
  contacts: TimelineContact[];
};

/* Fold accepted bumps into one entry per (observer, peer) per hour, so a pair
 * that bumps repeatedly inside an hour stays a single edge with a count. */
async function loadTimelineSteps(): Promise<TimelineStep[]> {
  const events = await db
    .select({
      observerHardwareId: bumpEvents.hardwareIdA,
      peerHardwareId: bumpEvents.hardwareIdB,
      reportedAt: bumpEvents.reportedAt,
    })
    .from(bumpEvents)
    .where(eq(bumpEvents.status, "accepted"))
    .orderBy(bumpEvents.reportedAt);

  const steps = new Map<string, { startedAt: Date; contacts: Map<string, TimelineContact> }>();
  for (const event of events) {
    const key = hourKey(event.reportedAt);
    let step = steps.get(key);
    if (!step) {
      step = { startedAt: event.reportedAt, contacts: new Map() };
      steps.set(key, step);
    }
    const pairKey = `${event.observerHardwareId}|${event.peerHardwareId}`;
    const contact = step.contacts.get(pairKey);
    if (contact) {
      contact.lastSeenAt = event.reportedAt;
      contact.bumpCount += 1;
    } else {
      step.contacts.set(pairKey, {
        observerHardwareId: event.observerHardwareId,
        peerHardwareId: event.peerHardwareId,
        firstSeenAt: event.reportedAt,
        lastSeenAt: event.reportedAt,
        bumpCount: 1,
      });
    }
  }

  return [...steps.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, step]) => ({ key, startedAt: step.startedAt, contacts: [...step.contacts.values()] }));
}

/* Project accepted contacts as root -> hour -> person. The hour node is a
 * visual branch marker, not a person, and therefore has no detail card. */
async function getTimelineGraph(visibleBadges: ProjectedBadge[], throughStepKey?: string) {
  const badgeByHardware = new Map(visibleBadges.map((badge) => [badge.hardwareId, badge]));
  const allSteps = await loadTimelineSteps();

  /* An hour only becomes a step once both ends of one of its bumps are on the
   * board; clearing the live graph can leave events whose badges are gone. */
  const steps = allSteps
    .map((step) => ({
      ...step,
      contacts: step.contacts.filter((contact) =>
        badgeByHardware.has(contact.observerHardwareId) && badgeByHardware.has(contact.peerHardwareId)),
    }))
    .filter((step) => step.contacts.length > 0);

  const throughIndex = throughStepKey
    ? steps.findIndex((step) => step.key === throughStepKey)
    : steps.length - 1;
  const activeSteps = throughIndex >= 0 ? steps.slice(0, throughIndex + 1) : steps;
  const contacts = activeSteps.flatMap((step) => step.contacts);
  const usedHardware = new Set<string>();
  for (const contact of contacts) {
    usedHardware.add(contact.observerHardwareId);
    usedHardware.add(contact.peerHardwareId);
  }
  const projectedBadges = visibleBadges.filter((badge) => usedHardware.has(badge.hardwareId));

  return {
    generatedAt: new Date().toISOString(),
    nodes: [
      ...projectedBadges.map((badge) => ({
        id: badge.id,
        kind: "badge" as const,
        displayName: badge.displayName,
        role: badge.role,
        company: badge.company,
        visualSeed: badge.visualSeed,
        joinedAt: badge.joinedAt.toISOString(),
      })),
      ...activeSteps.map((step) => ({
        id: `hour:${step.key}`,
        kind: "session" as const,
        displayName: hourLabel(step.key),
        role: `${step.contacts.length} contacts`,
        company: hourDateLabel(step.key),
        visualSeed: `hour-${step.key}`,
        joinedAt: step.startedAt.toISOString(),
      })),
    ],
    edges: [
      /* One root edge per badge that observed a bump in that hour. */
      ...activeSteps.flatMap((step) => {
        const observers = [...new Set(step.contacts.map((contact) => contact.observerHardwareId))];
        return observers.flatMap((hardwareId) => {
          const root = badgeByHardware.get(hardwareId);
          if (!root) return [];
          const observed = step.contacts.filter((contact) => contact.observerHardwareId === hardwareId);
          return [{
            id: `hour-root:${step.key}:${hardwareId}`,
            sourceId: root.id,
            targetId: `hour:${step.key}`,
            firstSeenAt: step.startedAt.toISOString(),
            lastSeenAt: step.startedAt.toISOString(),
            bumpCount: observed.length,
          }];
        });
      }),
      ...contacts.flatMap((contact) => {
        const peer = badgeByHardware.get(contact.peerHardwareId);
        if (!peer) return [];
        const key = hourKey(contact.firstSeenAt);
        return [{
          id: `hour-member:${key}:${contact.observerHardwareId}:${contact.peerHardwareId}`,
          sourceId: `hour:${key}`,
          targetId: peer.id,
          firstSeenAt: contact.firstSeenAt.toISOString(),
          lastSeenAt: contact.lastSeenAt.toISOString(),
          bumpCount: contact.bumpCount,
        }];
      }),
    ],
    sessions: steps.map((step) => ({
      id: step.key,
      label: hourLabel(step.key),
      startedAt: step.startedAt.toISOString(),
      contactCount: step.contacts.length,
    })),
    visibleThroughSessionId: activeSteps.at(-1)?.key ?? null,
  };
}

export async function getGraph(throughSessionId?: string) {
  const visibleBadges = await db
    .select()
    .from(badges)
    .where(and(eq(badges.active, true), ne(badges.projectorIdentity, "hidden")))
    .orderBy(badges.createdAt);

  return getTimelineGraph(visibleBadges.map((badge) => ({
    id: badge.id, hardwareId: badge.hardwareId, displayName: displayName(badge),
    role: badge.role, company: badge.company, visualSeed: badge.visualSeed, joinedAt: badge.createdAt,
  })), throughSessionId);
}

export async function getHistoricalGraph(throughSessionId?: string) {
  const visibleBadges = await db.select().from(historicalBadges).orderBy(historicalBadges.firstSeenAt);
  return getTimelineGraph(visibleBadges.map((badge) => ({
    id: badge.id, hardwareId: badge.hardwareId, displayName: badge.displayName,
    role: badge.role, company: badge.company, visualSeed: badge.visualSeed, joinedAt: badge.firstSeenAt,
  })), throughSessionId);
}

export async function searchNodes(query: string) {
  const pattern = `%${query}%`;
  const matches = await db
    .select()
    .from(badges)
    .where(and(
      eq(badges.active, true),
      ne(badges.projectorIdentity, "hidden"),
      or(ilike(badges.name, pattern), ilike(badges.publicAlias, pattern)),
    ))
    .orderBy(badges.name)
    .limit(8);

  return matches.map((badge) => ({
    id: badge.id,
    officialName: badge.name,
    displayName: displayName(badge),
    role: badge.role,
    company: badge.company,
  }));
}

export async function searchHistoricalNodes(query: string) {
  const pattern = `%${query}%`;
  const matches = await db
    .select()
    .from(historicalBadges)
    .where(or(ilike(historicalBadges.name, pattern), ilike(historicalBadges.displayName, pattern)))
    .orderBy(historicalBadges.name)
    .limit(8);

  return matches.map((badge) => ({
    id: badge.id,
    officialName: badge.name ?? badge.displayName,
    displayName: badge.displayName,
    role: badge.role,
    company: badge.company,
  }));
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
      publicAlias: badge.publicAlias,
      name: badge.name,
      role: badge.role,
      company: badge.company,
      bio: badge.bio,
      attendeeId: badge.attendeeId,
      profileVersion: badge.profileVersion,
      claimId: badge.claimId,
      email: badge.email,
      phone: badge.phone,
      linkedin: badge.linkedin,
      discord: badge.discord,
      provisionedAt: badge.provisionedAt,
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

/* Historical cards are served from the snapshot table, never the live badge
 * table. A clear can therefore remove the live demo round without making old
 * tiles uninspectable. */
export async function getHistoricalNodeDetail(id: string) {
  const badge = await db.query.historicalBadges.findFirst({
    where: eq(historicalBadges.id, id),
  });
  if (!badge) return null;

  return {
    id: badge.id,
    displayName: badge.name ?? badge.displayName,
    publicAlias: badge.publicAlias ?? badge.displayName,
    role: badge.role,
    company: badge.company,
    bio: badge.bio,
    visualSeed: badge.visualSeed,
    badgeId: badge.hardwareId,
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

export async function createSyncSession(input: SyncSessionInput) {
  const [session] = await db
    .insert(syncSessions)
    .values({ observerHardwareId: input.observer_id, source: input.source })
    .returning();
  return session!;
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
        syncSessionId: input.sync_session_id ?? null,
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

    if (input.sync_session_id) {
      await tx
        .insert(syncSessionMembers)
        .values({
          sessionId: input.sync_session_id,
          observerHardwareId: input.badge_id_a,
          peerHardwareId: input.badge_id_b,
          firstSeenAt: reportedAt,
          lastSeenAt: reportedAt,
        })
        .onConflictDoUpdate({
          target: [syncSessionMembers.sessionId, syncSessionMembers.peerHardwareId],
          set: {
            lastSeenAt: reportedAt,
            bumpCount: sql`${syncSessionMembers.bumpCount} + 1`,
          },
        });
    }

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
