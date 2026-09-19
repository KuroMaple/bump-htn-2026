CREATE TABLE "historical_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hardware_id" varchar(128) NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"role" varchar(160),
	"company" varchar(160),
	"visual_seed" varchar(128) NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "historical_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"badge_a_id" uuid NOT NULL,
	"badge_b_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"bump_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "historical_connections" ADD CONSTRAINT "historical_connections_badge_a_id_historical_badges_id_fk" FOREIGN KEY ("badge_a_id") REFERENCES "public"."historical_badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_connections" ADD CONSTRAINT "historical_connections_badge_b_id_historical_badges_id_fk" FOREIGN KEY ("badge_b_id") REFERENCES "public"."historical_badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "historical_badges_hardware_id_unique" ON "historical_badges" USING btree ("hardware_id");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_connections_badge_pair_unique" ON "historical_connections" USING btree ("badge_a_id","badge_b_id");--> statement-breakpoint
CREATE INDEX "historical_connections_badge_a_idx" ON "historical_connections" USING btree ("badge_a_id");--> statement-breakpoint
CREATE INDEX "historical_connections_badge_b_idx" ON "historical_connections" USING btree ("badge_b_id");
--> statement-breakpoint
-- Seed the permanent board from exactly the graph currently visible on the
-- live projector. Later clears touch only live tables, never these copies.
INSERT INTO "historical_badges" ("id", "hardware_id", "display_name", "role", "company", "visual_seed", "first_seen_at")
SELECT
  "id",
  "hardware_id",
  CASE WHEN "projector_identity" = 'real_name' THEN "name" ELSE "public_alias" END,
  "role",
  "company",
  "visual_seed",
  "created_at"
FROM "badges"
WHERE "active" = true AND "projector_identity" <> 'hidden';
--> statement-breakpoint
INSERT INTO "historical_connections" ("id", "badge_a_id", "badge_b_id", "first_seen_at", "last_seen_at", "bump_count")
SELECT c."id", c."badge_a_id", c."badge_b_id", c."first_seen_at", c."last_seen_at", c."bump_count"
FROM "connections" AS c
INNER JOIN "historical_badges" AS a ON a."id" = c."badge_a_id"
INNER JOIN "historical_badges" AS b ON b."id" = c."badge_b_id";
