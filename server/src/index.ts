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
import { clearGraph, createSyncSession, getBadgePage, getGraph, getHistoricalGraph, getHistoricalNodeDetail, getNodeDetail, listBadges, processBump, registerBadge, searchHistoricalNodes, searchNodes } from "./service.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: config.NODE_ENV === "production" ? config.PUBLIC_APP_URL : true,
});

app.get("/api/health", async () => {
  await db.execute("select 1");
  return { status: "ok", time: new Date().toISOString() };
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

const shutdown = async () => {
  await app.close();
  await closeDatabase();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
