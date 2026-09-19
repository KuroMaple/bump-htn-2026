CREATE TYPE "public"."bump_event_status" AS ENUM('received', 'accepted', 'duplicate_event', 'duplicate_window', 'unknown_badge', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."projector_identity" AS ENUM('alias', 'real_name', 'hidden');--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hardware_id" varchar(128) NOT NULL,
	"private_token" varchar(128) NOT NULL,
	"visual_seed" varchar(128) NOT NULL,
	"public_alias" varchar(80) NOT NULL,
	"name" varchar(160) NOT NULL,
	"role" varchar(160),
	"company" varchar(160),
	"bio" text,
	"projector_identity" "projector_identity" DEFAULT 'alias' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bump_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" varchar(160) NOT NULL,
	"hardware_id_a" varchar(128) NOT NULL,
	"hardware_id_b" varchar(128) NOT NULL,
	"observer_id" varchar(128),
	"source" varchar(80) NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signal_strength" real,
	"status" "bump_event_status" DEFAULT 'received' NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"badge_a_id" uuid NOT NULL,
	"badge_b_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"bump_count" integer DEFAULT 1 NOT NULL,
	"latest_signal_strength" real,
	"strongest_signal_strength" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_badge_a_id_badges_id_fk" FOREIGN KEY ("badge_a_id") REFERENCES "public"."badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_badge_b_id_badges_id_fk" FOREIGN KEY ("badge_b_id") REFERENCES "public"."badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "badges_hardware_id_unique" ON "badges" USING btree ("hardware_id");--> statement-breakpoint
CREATE UNIQUE INDEX "badges_private_token_unique" ON "badges" USING btree ("private_token");--> statement-breakpoint
CREATE UNIQUE INDEX "bump_events_event_id_unique" ON "bump_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "bump_events_received_at_idx" ON "bump_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "bump_events_status_idx" ON "bump_events" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_badge_pair_unique" ON "connections" USING btree ("badge_a_id","badge_b_id");--> statement-breakpoint
CREATE INDEX "connections_badge_a_idx" ON "connections" USING btree ("badge_a_id");--> statement-breakpoint
CREATE INDEX "connections_badge_b_idx" ON "connections" USING btree ("badge_b_id");