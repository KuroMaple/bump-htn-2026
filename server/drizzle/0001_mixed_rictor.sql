ALTER TABLE "badges" ADD COLUMN "attendee_id" integer;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "profile_version" integer;--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "claim_id" varchar(64);--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "email" varchar(254);--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "phone" varchar(40);--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "linkedin" varchar(160);--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "discord" varchar(160);--> statement-breakpoint
ALTER TABLE "badges" ADD COLUMN "provisioned_at" timestamp with time zone;