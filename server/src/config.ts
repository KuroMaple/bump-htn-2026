import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgres://bump:bump@localhost:5432/bump"),
  GATEWAY_API_KEY: z.string().min(16).default("local-gateway-key-change-me"),
  ADMIN_API_KEY: z.string().min(16).default("local-admin-key-change-me"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),
  DEDUPE_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  /* The observer badge every edge radiates from. Clearing the board keeps it,
   * otherwise the next bump has nothing to connect to and the star graph
   * cannot rebuild. Must match the gateway's --observer. */
  ROOT_BADGE_ID: z.string().trim().min(1).max(128).default("brave-moth-badger-vivid"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export const config = configSchema.parse(process.env);
