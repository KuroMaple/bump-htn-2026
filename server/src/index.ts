import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";
import { hasBearerToken } from "./auth.js";
import { config } from "./config.js";
import { closeDatabase, db } from "./db/client.js";
import { subscribe } from "./events.js";
import { badgeInputSchema, bumpInputSchema, syncSessionInputSchema } from "./schemas.js";
import { listTeamMatches, runTeamMatching, seedVerifiedTeam, setTeamMatchStatus } from "./team-match.js";
import { BadgeTerminal } from "./badge-terminal.js";
import { HTNOSBumper, type HTNOSBadgeConfig } from "./htnos-bumper.js";
import { renderTilePng } from "./tile-png.js";
import { clearGraph, createSyncSession, getBadgePage, getGraph, getHistoricalGraph, getHistoricalNodeDetail, getNodeDetail, listBadges, processBump, registerBadge, searchHistoricalNodes, searchNodes } from "./service.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: config.NODE_ENV === "production" ? config.PUBLIC_APP_URL : true,
});

app.get("/api/health", async () => {
  await db.execute("select 1");
  return { status: "ok", time: new Date().toISOString() };
});

/* Serve a badge's mandela as a PNG — used by the on-badge URL and by any
 * external display. Seed comes from the badge's visualSeed in the DB; falls
 * back to the raw token if the badge is not found (still produces a stable
 * deterministic image). */
app.get("/api/badges/:token/tile.png", async (request, reply) => {
  const { token } = request.params as { token: string };
  const data = await getBadgePage(token).catch(() => null);
  const seed = data?.badge.visualSeed ?? token;
  const png = renderTilePng(seed, 30);
  return reply
    .header("Content-Type", "image/png")
    .header("Cache-Control", "public, max-age=3600")
    .send(png);
});

/* `through` is a timeline step key (local clock hour, e.g. "2026-09-19T14"),
 * not a uuid: steps are derived from bump times, not stored. */
const graphQuery = z.object({ through: z.string().min(1).max(32).optional() });

app.get("/api/graph", async (request) => getGraph(graphQuery.parse(request.query).through));

/* A permanent, append-only graph. Its initial rows are seeded by migration
 * 0002 and clearGraph intentionally never touches its tables. */
app.get("/api/graph/history", async (request) => getHistoricalGraph(graphQuery.parse(request.query).through));

const nodeSearchQuery = z.object({ q: z.string().trim().min(1).max(160) });

app.get("/api/nodes/search", async (request) => searchNodes(nodeSearchQuery.parse(request.query).q));

app.get("/api/nodes/history/search", async (request) => searchHistoricalNodes(nodeSearchQuery.parse(request.query).q));

app.get("/api/nodes/:id", async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const node = await getNodeDetail(id);
  if (!node) return reply.code(404).send({ error: "Node not found" });
  return node;
});

app.get("/api/nodes/history/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const node = await getHistoricalNodeDetail(id);
  if (!node) return reply.code(404).send({ error: "Historical node not found" });
  return node;
});

app.get("/api/badges/:token", async (request, reply) => {
  const { token } = z.object({ token: z.string().min(1).max(128) }).parse(request.params);
  const page = await getBadgePage(token);
  if (!page) return reply.code(404).send({ error: "Badge page not found" });
  return page;
});

app.get("/api/events", async (request, reply) => {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);

  const unsubscribe = subscribe((event) => {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.post("/api/bumps", async (request, reply) => {
  if (!hasBearerToken(request, config.GATEWAY_API_KEY)) {
    return reply.code(401).send({ error: "Invalid gateway credentials" });
  }
  const parsed = bumpInputSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid event", issues: parsed.error.issues });
  }
  const result = await processBump(parsed.data);
  return reply.code(result.status === "accepted" ? 201 : 202).send(result);
});

/* The USB gateway opens one of these per physical badge connection. Every
 * accepted contact sent with the returned ID becomes a visible branch. */
app.post("/api/sync-sessions", async (request, reply) => {
  if (!hasBearerToken(request, config.GATEWAY_API_KEY)) {
    return reply.code(401).send({ error: "Invalid gateway credentials" });
  }
  const parsed = syncSessionInputSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid sync session", issues: parsed.error.issues });
  }
  const session = await createSyncSession(parsed.data);
  return reply.code(201).send({ id: session.id, startedAt: session.startedAt.toISOString() });
});

app.get("/api/admin/badges", async (request, reply) => {
  if (!hasBearerToken(request, config.ADMIN_API_KEY)) {
    return reply.code(401).send({ error: "Invalid admin credentials" });
  }
  return listBadges();
});

app.post("/api/admin/badges", async (request, reply) => {
  if (!hasBearerToken(request, config.ADMIN_API_KEY)) {
    return reply.code(401).send({ error: "Invalid admin credentials" });
  }
  const parsed = badgeInputSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid badge", issues: parsed.error.issues });
  }
  return reply.code(201).send(await registerBadge(parsed.data));
});

app.post("/api/admin/badges/import", async (request, reply) => {
  if (!hasBearerToken(request, config.ADMIN_API_KEY)) {
    return reply.code(401).send({ error: "Invalid admin credentials" });
  }
  const parsed = z.array(badgeInputSchema).min(1).max(1000).safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid roster", issues: parsed.error.issues });
  }
  const imported = [];
  for (const badge of parsed.data) imported.push(await registerBadge(badge));
  return reply.code(201).send({ imported: imported.length, badges: imported });
});

/* Resolve hackathon teams for everyone on the board.
 *
 * Runs one web-searching model call per person, so it is slow and costs money:
 * it is a deliberate button press, never automatic. Matches at or above
 * TEAM_MATCH_MIN_CONFIDENCE go live; the rest stay pending for review. */
app.post("/api/admin/team-match", async (request, reply) => {
  if (!hasBearerToken(request, config.ADMIN_API_KEY)) {
    return reply.code(401).send({ error: "Invalid admin credentials" });
  }
  const parsed = z.object({ rematch: z.boolean().default(false) }).safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid options", issues: parsed.error.issues });
  }
  try {
    return await runTeamMatching(parsed.data);
  } catch (error) {
    if ((error as { code?: string }).code === "NO_KEY") {
      return reply.code(503).send({ error: "Team matching is not configured: set OPENAI_API_KEY in .env" });
    }
    request.log.error({ err: error }, "team matching failed");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "Team matching failed" });
  }
});

app.get("/api/admin/team-matches", async (request, reply) => {
  if (!hasBearerToken(request, config.ADMIN_API_KEY)) {
    return reply.code(401).send({ error: "Invalid admin credentials" });
  }
  return listTeamMatches();
});

/* For a project page an admin has personally checked. This avoids a second
 * paid search and preserves the public URL which supports the resulting link. */
app.post("/api/admin/team-matches/verified", async (request, reply) => {
  if (!hasBearerToken(request, config.ADMIN_API_KEY)) {
    return reply.code(401).send({ error: "Invalid admin credentials" });
  }
  const parsed = z.object({
    project_title: z.string().trim().min(1).max(200),
    project_url: z.string().url().max(500),
    members: z.array(z.object({
      badge_id: z.string().uuid(),
      source_name: z.string().trim().min(1).max(200),
    })).min(2).max(20),
  }).safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid verified team", issues: parsed.error.issues });
  }
  return seedVerifiedTeam({
    projectTitle: parsed.data.project_title,
    projectUrl: parsed.data.project_url,
    members: parsed.data.members.map((member) => ({ badgeId: member.badge_id, sourceName: member.source_name })),
  });
});

app.post("/api/admin/team-matches/:id", async (request, reply) => {
  if (!hasBearerToken(request, config.ADMIN_API_KEY)) {
    return reply.code(401).send({ error: "Invalid admin credentials" });
  }
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const parsed = z.object({ status: z.enum(["confirmed", "rejected"]) }).safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid status", issues: parsed.error.issues });
  }
  const row = await setTeamMatchStatus(id, parsed.data.status);
  if (!row) return reply.code(404).send({ error: "Match not found" });
  return row;
});

app.post("/api/admin/clear", async (request, reply) => {
  if (!hasBearerToken(request, config.ADMIN_API_KEY)) {
    return reply.code(401).send({ error: "Invalid admin credentials" });
  }
  const parsed = z
    .object({
      scope: z.enum(["edges", "all"]).default("all"),
      /* Root badge(s) to preserve. Defaults to the configured observer so a
       * clear never removes the hub every edge connects to. Pass [] to wipe
       * the roster completely. */
      keep: z.array(z.string().trim().min(1).max(128)).optional(),
    })
    .safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid scope", issues: parsed.error.issues });
  }
  return clearGraph(parsed.data.scope, parsed.data.keep ?? [config.ROOT_BADGE_ID]);
});

app.post("/api/admin/simulate", async (request, reply) => {
  if (!hasBearerToken(request, config.ADMIN_API_KEY)) {
    return reply.code(401).send({ error: "Invalid admin credentials" });
  }
  const parsed = z
    .object({
      badge_id_a: z.string().min(1).max(128),
      badge_id_b: z.string().min(1).max(128),
      signal_strength: z.number().min(-150).max(20).optional(),
    })
    .safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid simulation", issues: parsed.error.issues });
  }
  const event = bumpInputSchema.parse({
    ...parsed.data,
    timestamp: new Date().toISOString(),
    event_id: `sim-${randomUUID()}`,
    source: "admin-simulator",
  });
  return reply.code(201).send(await processBump(event));
});

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = join(currentDirectory, "../../web/dist");
if (existsSync(webDirectory)) {
  await app.register(staticPlugin, { root: webDirectory });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

let badgeTerminal: BadgeTerminal | null = null;
if (config.BADGE_TERMINAL_ID && config.BADGE_TERMINAL_KEY) {
  badgeTerminal = new BadgeTerminal({ badgeId: config.BADGE_TERMINAL_ID, key: config.BADGE_TERMINAL_KEY });
  badgeTerminal.start();
}

let htnosBumper: HTNOSBumper | null = null;
if (config.HTNOS_BADGES) {
  try {
    const badges = JSON.parse(config.HTNOS_BADGES) as HTNOSBadgeConfig[];
    if (badges.length >= 2) {
      htnosBumper = new HTNOSBumper(badges);
      htnosBumper.start();
      console.log(`[htnos-bumper] monitoring ${badges.length} badges`);
    } else {
      console.warn("[htnos-bumper] need at least 2 badges in HTNOS_BADGES to detect bumps");
    }
  } catch {
    console.error("[htnos-bumper] HTNOS_BADGES is not valid JSON, skipping");
  }
}

const shutdown = async () => {
  badgeTerminal?.stop();
  htnosBumper?.stop();
  await app.close();
  await closeDatabase();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
