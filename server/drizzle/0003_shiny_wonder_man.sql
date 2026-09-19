ALTER TABLE "historical_badges" ADD COLUMN "public_alias" varchar(80);--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "name" varchar(160);--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "attendee_id" integer;--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "profile_version" integer;--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "claim_id" varchar(64);--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "email" varchar(254);--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "phone" varchar(40);--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "linkedin" varchar(160);--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "discord" varchar(160);--> statement-breakpoint
ALTER TABLE "historical_badges" ADD COLUMN "provisioned_at" timestamp with time zone;
--> statement-breakpoint
-- History created before this migration already has its tiles. Snapshot the
-- matching live contact cards once, so those tiles become inspectable too.
-- Rows that only exist in history remain valid and simply show their existing
-- display fields with no unavailable contact fields.
UPDATE "historical_badges" AS h
SET
  "public_alias" = b."public_alias",
  "name" = b."name",
  "bio" = b."bio",
  "attendee_id" = b."attendee_id",
  "profile_version" = b."profile_version",
  "claim_id" = b."claim_id",
  "email" = b."email",
  "phone" = b."phone",
  "linkedin" = b."linkedin",
  "discord" = b."discord",
  "provisioned_at" = b."provisioned_at"
FROM "badges" AS b
WHERE h."hardware_id" = b."hardware_id";
