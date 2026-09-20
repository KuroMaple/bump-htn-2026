CREATE TABLE "historical_team_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"historical_badge_id" uuid NOT NULL,
	"hardware_id" varchar(128) NOT NULL,
	"project_slug" varchar(200) NOT NULL,
	"project_title" varchar(200) NOT NULL,
	"project_url" varchar(500),
	"matched_name" varchar(200),
	"confidence" real NOT NULL,
	"status" "team_match_status" NOT NULL,
	"model" varchar(120),
	"source_url" varchar(500),
	"reasoning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "historical_team_memberships" ADD CONSTRAINT "historical_team_memberships_historical_badge_id_historical_badges_id_fk" FOREIGN KEY ("historical_badge_id") REFERENCES "public"."historical_badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "historical_team_memberships_badge_project_unique" ON "historical_team_memberships" USING btree ("historical_badge_id","project_slug");--> statement-breakpoint
CREATE INDEX "historical_team_memberships_project_idx" ON "historical_team_memberships" USING btree ("project_slug");--> statement-breakpoint
CREATE INDEX "historical_team_memberships_status_idx" ON "historical_team_memberships" USING btree ("status");