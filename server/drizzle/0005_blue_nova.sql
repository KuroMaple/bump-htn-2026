CREATE TYPE "public"."team_match_status" AS ENUM('confirmed', 'pending', 'rejected');--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"badge_id" uuid NOT NULL,
	"hardware_id" varchar(128) NOT NULL,
	"project_slug" varchar(200) NOT NULL,
	"project_title" varchar(200) NOT NULL,
	"project_url" varchar(500),
	"matched_name" varchar(200),
	"confidence" real NOT NULL,
	"status" "team_match_status" DEFAULT 'pending' NOT NULL,
	"model" varchar(120),
	"source_url" varchar(500),
	"reasoning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_memberships_badge_project_unique" ON "team_memberships" USING btree ("badge_id","project_slug");--> statement-breakpoint
CREATE INDEX "team_memberships_project_idx" ON "team_memberships" USING btree ("project_slug");--> statement-breakpoint
CREATE INDEX "team_memberships_status_idx" ON "team_memberships" USING btree ("status");