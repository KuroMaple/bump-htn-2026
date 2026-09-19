import { z } from "zod";

export const bumpInputSchema = z
  .object({
    badge_id_a: z.string().trim().min(1).max(128),
    badge_id_b: z.string().trim().min(1).max(128),
    timestamp: z.iso.datetime({ offset: true }),
    signal_strength: z.number().min(-150).max(20).nullable().optional(),
    event_id: z.string().trim().min(8).max(160),
    source: z.string().trim().min(1).max(80).default("laptop-gateway"),
    observer_id: z.string().trim().min(1).max(128).optional(),
  })
  .refine((value) => value.badge_id_a !== value.badge_id_b, {
    message: "A badge cannot bump itself",
    path: ["badge_id_b"],
  });

export type BumpInput = z.infer<typeof bumpInputSchema>;

export const badgeInputSchema = z.object({
  hardwareId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().max(160).optional(),
  company: z.string().trim().max(160).optional(),
  bio: z.string().trim().max(1000).optional(),
  projectorIdentity: z.enum(["alias", "real_name", "hidden"]).default("alias"),
});

export type BadgeInput = z.infer<typeof badgeInputSchema>;
