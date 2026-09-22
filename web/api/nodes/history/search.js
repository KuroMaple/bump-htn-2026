import searchIndex from "../../../public/api/nodes/history/search-index.json";

/* Mirrors vite.config.ts's historySearchRouter (dev-only middleware) for
 * static production hosting: case-insensitive substring match on
 * officialName, capped at 8 results. */
export default function handler(req, res) {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const matches = q
    ? searchIndex.filter((entry) => entry.officialName.toLowerCase().includes(q)).slice(0, 8)
    : [];
  res.setHeader("Content-Type", "application/json");
  res.status(200).json(matches);
}
