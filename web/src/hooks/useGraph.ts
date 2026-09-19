import { useCallback, useEffect, useState } from "react";
import type { GraphSnapshot } from "../types";

type ConnectionState = "connecting" | "live" | "offline";

interface BumpEvent {
  type: "bump:accepted";
  connection: {
    id: string;
    sourceId: string;
    targetId: string;
    occurredAt: string;
  };
}

export function useGraph(mode: "current" | "history" = "current", throughSessionId?: string) {
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [recentConnection, setRecentConnection] = useState<BumpEvent["connection"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const endpoint = mode === "history" ? "/api/graph/history" : "/api/graph";
    const query = throughSessionId ? `?through=${encodeURIComponent(throughSessionId)}` : "";
    const response = await fetch(endpoint + query);
    if (!response.ok) throw new Error("The mosaic could not be loaded.");
    const snapshot = (await response.json()) as GraphSnapshot;
    setGraph(snapshot);
    setError(null);
  }, [mode, throughSessionId]);

  useEffect(() => {
    void refresh().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "The mosaic could not be loaded.");
    });

    const events = new EventSource("/api/events");
    events.addEventListener("ready", () => setConnectionState("live"));
    events.addEventListener("graph:refresh", () => void refresh());
    events.addEventListener("bump:accepted", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as BumpEvent;
      // Historical nodes have permanent IDs independent from the live roster.
      // Re-fetch instead of trying to apply a live connection ID locally.
      if (mode === "history") {
        void refresh();
        return;
      }
      setRecentConnection(event.connection);
      setGraph((current) => {
        if (!current) return current;
        const nodeIds = new Set(current.nodes.map((node) => node.id));
        if (!nodeIds.has(event.connection.sourceId) || !nodeIds.has(event.connection.targetId)) {
          return current;
        }
        const existing = current.edges.find((edge) => edge.id === event.connection.id);
        if (existing) {
          return {
            ...current,
            edges: current.edges.map((edge) =>
              edge.id === existing.id
                ? { ...edge, lastSeenAt: event.connection.occurredAt, bumpCount: edge.bumpCount + 1 }
                : edge,
            ),
          };
        }
        return {
          ...current,
          edges: [
            ...current.edges,
            {
              id: event.connection.id,
              sourceId: event.connection.sourceId,
              targetId: event.connection.targetId,
              firstSeenAt: event.connection.occurredAt,
              lastSeenAt: event.connection.occurredAt,
              bumpCount: 1,
            },
          ],
        };
      });
    });
    events.onerror = () => setConnectionState("offline");
    events.onopen = () => setConnectionState("live");
    return () => events.close();
  }, [mode, refresh]);

  return { graph, connectionState, recentConnection, error, refresh };
}
