import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

/* npm workspaces run this package with `server/` as cwd, while the shared
 * local configuration lives at the repository root. Resolve it from this
 * module rather than the process cwd so dev, production, and migrations all
 * load the same .env file. */
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

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
  /* Team matching. The key is read from .env and never leaves the server;
   * without it the endpoint refuses rather than half-running a batch. */
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  /* This model supports the Responses API, structured output, and hosted web
   * search. It is deliberately still configurable in .env for demo tuning. */
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-5.4-mini"),
  /* The hosted web-search tool's type name has changed across API versions
   * ("web_search_preview" -> "web_search"); configurable so a rename does not
   * need a code change mid-event. */
  OPENAI_WEB_SEARCH_TOOL: z.string().trim().min(1).default("web_search"),
  /* At or above this, a match is committed and its edges go live. Below it,
   * the match is stored as pending and draws nothing until approved. */
  TEAM_MATCH_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  /* The event the model is told to search within. */
  TEAM_MATCH_EVENT: z.string().trim().min(1).default("Hack the North 2026"),
  TEAM_MATCH_GALLERY_URL: z.string().url().default("https://hackthenorth2026.devpost.com/project-gallery"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /* HTN OS badge terminal: if both are set the server drives a scrolling bump
   * log on the badge screen. Leave blank to disable. */
  BADGE_TERMINAL_ID: z.string().trim().optional(),
  BADGE_TERMINAL_KEY: z.string().trim().optional(),
  /* HTN OS bump detector: JSON array of {id, key, hardwareId} objects.
   * Example: '[{"id":"xb2b9","key":"hunter2","hardwareId":"e8:3d:c1:29:87:00"}]'
   * Leave blank to disable. */
  HTNOS_BADGES: z.string().trim().optional(),
});

export const config = configSchema.parse(process.env);
