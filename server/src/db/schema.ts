import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const projectorIdentity = pgEnum("projector_identity", [
  "alias",
  "real_name",
  "hidden",
]);

export const bumpEventStatus = pgEnum("bump_event_status", [
  "received",
  "accepted",
  "duplicate_event",
  "duplicate_window",
  "unknown_badge",
  "invalid",
]);

export const badges = pgTable(
  "badges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hardwareId: varchar("hardware_id", { length: 128 }).notNull(),
    privateToken: varchar("private_token", { length: 128 }).notNull(),
    visualSeed: varchar("visual_seed", { length: 128 }).notNull(),
    publicAlias: varchar("public_alias", { length: 80 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    role: varchar("role", { length: 160 }),
    company: varchar("company", { length: 160 }),
    bio: text("bio"),
    // Full attendee profile as broadcast by the badge (Connect profile record).
    attendeeId: integer("attendee_id"),
    profileVersion: integer("profile_version"),
    claimId: varchar("claim_id", { length: 64 }),
    email: varchar("email", { length: 254 }),
    phone: varchar("phone", { length: 40 }),
    linkedin: varchar("linkedin", { length: 160 }),
    discord: varchar("discord", { length: 160 }),
    provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
    projectorIdentity: projectorIdentity("projector_identity").notNull().default("alias"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("badges_hardware_id_unique").on(table.hardwareId),
    uniqueIndex("badges_private_token_unique").on(table.privateToken),
  ],
);

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    badgeAId: uuid("badge_a_id").notNull().references(() => badges.id),
    badgeBId: uuid("badge_b_id").notNull().references(() => badges.id),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    bumpCount: integer("bump_count").notNull().default(1),
    latestSignalStrength: real("latest_signal_strength"),
    strongestSignalStrength: real("strongest_signal_strength"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("connections_badge_pair_unique").on(table.badgeAId, table.badgeBId),
    index("connections_badge_a_idx").on(table.badgeAId),
    index("connections_badge_b_idx").on(table.badgeBId),
  ],
);

/* The historical projector has its own graph. It is intentionally not linked
 * to the live `badges` / `connections` tables: clearing a demo round can
 * delete those rows without changing the permanent mosaic. The public display
 * fields are snapshotted when a person first enters the history graph. */
export const historicalBadges = pgTable(
  "historical_badges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hardwareId: varchar("hardware_id", { length: 128 }).notNull(),
    displayName: varchar("display_name", { length: 160 }).notNull(),
    role: varchar("role", { length: 160 }),
    company: varchar("company", { length: 160 }),
    visualSeed: varchar("visual_seed", { length: 128 }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("historical_badges_hardware_id_unique").on(table.hardwareId)],
);

export const historicalConnections = pgTable(
  "historical_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    badgeAId: uuid("badge_a_id").notNull().references(() => historicalBadges.id),
    badgeBId: uuid("badge_b_id").notNull().references(() => historicalBadges.id),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    bumpCount: integer("bump_count").notNull().default(1),
  },
  (table) => [
    uniqueIndex("historical_connections_badge_pair_unique").on(table.badgeAId, table.badgeBId),
    index("historical_connections_badge_a_idx").on(table.badgeAId),
    index("historical_connections_badge_b_idx").on(table.badgeBId),
  ],
);

export const bumpEvents = pgTable(
  "bump_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: varchar("event_id", { length: 160 }).notNull(),
    hardwareIdA: varchar("hardware_id_a", { length: 128 }).notNull(),
    hardwareIdB: varchar("hardware_id_b", { length: 128 }).notNull(),
    observerId: varchar("observer_id", { length: 128 }),
    source: varchar("source", { length: 80 }).notNull(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    signalStrength: real("signal_strength"),
    status: bumpEventStatus("status").notNull().default("received"),
    reason: text("reason"),
  },
  (table) => [
    uniqueIndex("bump_events_event_id_unique").on(table.eventId),
    index("bump_events_received_at_idx").on(table.receivedAt),
    index("bump_events_status_idx").on(table.status),
  ],
);
