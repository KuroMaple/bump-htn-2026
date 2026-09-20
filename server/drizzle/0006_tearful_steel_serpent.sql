ALTER TABLE "team_memberships" DROP CONSTRAINT "team_memberships_badge_id_badges_id_fk";
--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;