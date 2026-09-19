CREATE TABLE "sync_session_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"observer_hardware_id" varchar(128) NOT NULL,
	"peer_hardware_id" varchar(128) NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"bump_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observer_hardware_id" varchar(128) NOT NULL,
	"source" varchar(80) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bump_events" ADD COLUMN "sync_session_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_session_members" ADD CONSTRAINT "sync_session_members_session_id_sync_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sync_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_session_members_session_peer_unique" ON "sync_session_members" USING btree ("session_id","peer_hardware_id");--> statement-breakpoint
CREATE INDEX "sync_session_members_session_idx" ON "sync_session_members" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sync_sessions_started_at_idx" ON "sync_sessions" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "bump_events" ADD CONSTRAINT "bump_events_sync_session_id_sync_sessions_id_fk" FOREIGN KEY ("sync_session_id") REFERENCES "public"."sync_sessions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Older accepted events predate explicit USB session IDs. Keep them visible
-- as one honestly-labelled branch per observer rather than inventing session
-- boundaries from timestamps.
WITH legacy_sessions AS (
  INSERT INTO "sync_sessions" ("observer_hardware_id", "source", "started_at")
  SELECT COALESCE("observer_id", "hardware_id_a"), 'legacy-import', MIN("reported_at")
  FROM "bump_events"
  WHERE "status" = 'accepted'
  GROUP BY COALESCE("observer_id", "hardware_id_a")
  RETURNING "id", "observer_hardware_id"
)
INSERT INTO "sync_session_members" (
  "session_id", "observer_hardware_id", "peer_hardware_id", "first_seen_at", "last_seen_at", "bump_count"
)
SELECT
  s."id",
  s."observer_hardware_id",
  e."hardware_id_b",
  MIN(e."reported_at"),
  MAX(e."reported_at"),
  COUNT(*)::integer
FROM "bump_events" AS e
JOIN legacy_sessions AS s ON s."observer_hardware_id" = COALESCE(e."observer_id", e."hardware_id_a")
WHERE e."status" = 'accepted'
GROUP BY s."id", s."observer_hardware_id", e."hardware_id_b";
--> statement-breakpoint
UPDATE "bump_events" AS e
SET "sync_session_id" = s."id"
FROM "sync_sessions" AS s
WHERE s."source" = 'legacy-import'
  AND s."observer_hardware_id" = COALESCE(e."observer_id", e."hardware_id_a")
  AND e."status" = 'accepted';
