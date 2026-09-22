import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/* Static hosting has no backend to honour ?through=<hour>, so /api/graph/history
 * would always serve the same fully-expanded snapshot and the timeline stepper
 * would look broken. Pre-generated per-hour snapshots live in
 * public/api/graph/history-steps/<hour>.json; this middleware routes the query
 * param to the matching file, mirroring what a real server would do. Dev-only —
 * production hosting needs the equivalent rewrite in vercel.json. */
function historyStepRouter(): Plugin {
  return {
    name: "history-step-router",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/graph/history")) return next();
        const url = new URL(req.url, "http://localhost");
        const through = url.searchParams.get("through");
        if (!through) return next();
        const stepPath = fileURLToPath(
          new URL(`./public/api/graph/history-steps/${through}.json`, import.meta.url),
        );
        if (!existsSync(stepPath)) return next();
        res.setHeader("Content-Type", "application/json");
        res.end(readFileSync(stepPath));
      });
    },
  };
}

/* /api/nodes/history/search has no backend to query either — arbitrary text
 * can't be pre-generated per-query the way the 10 fixed hour steps can.
 * Instead, serve the full anonymized roster once and filter it here the same
 * way searchHistoricalNodes() does server-side (case-insensitive substring on
 * name, sorted, capped at 8). Dev-only — production hosting needs the
 * equivalent as a Vercel serverless function reading the same index file. */
function historySearchRouter(): Plugin {
  return {
    name: "history-search-router",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/nodes/history/search")) return next();
        const url = new URL(req.url, "http://localhost");
        const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const indexPath = fileURLToPath(
          new URL("./public/api/nodes/history/search-index.json", import.meta.url),
        );
        if (!existsSync(indexPath)) return next();
        const index = JSON.parse(readFileSync(indexPath, "utf-8")) as Array<{
          officialName: string;
        }>;
        const matches = q
          ? index.filter((entry) => entry.officialName.toLowerCase().includes(q)).slice(0, 8)
          : [];
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(matches));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), historyStepRouter(), historySearchRouter()],
  server: {
    port: 5173,
  },
});
