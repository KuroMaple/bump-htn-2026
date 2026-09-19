import { Archive, ChevronLeft, ChevronRight, Maximize2, Minus, Network, Plus, Radio, RotateCcw, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { GraphCanvas } from "../components/GraphCanvas";
import { PixelTile } from "../components/PixelTile";
import { useGraph } from "../hooks/useGraph";
import type { GraphNode, NodeDetail } from "../types";

export function ProjectorPage({ mode = "current" }: { mode?: "current" | "history" }) {
  const historical = mode === "history";
  const [throughSessionId, setThroughSessionId] = useState<string | undefined>();
  const { graph, connectionState, recentConnection, error, refresh } = useGraph(mode, throughSessionId);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [zoom, setZoom] = useState(1);
  const [clearing, setClearing] = useState(false);

  /* The projector is the only operator screen, so it asks for the admin key
   * itself the first time and remembers it for the session. A rejected key is
   * discarded so the next attempt re-prompts instead of failing silently. */
  const clearBoard = async () => {
    let secret = sessionStorage.getItem("bump-admin-secret") ?? "";
    if (!secret) {
      secret = window.prompt("Admin key (stored for this session)") ?? "";
      if (!secret) return;
    }

    if (
      !window.confirm(
        "Clear the mosaic?\n\nRemoves every attendee and connection, ready for a fresh round of bumps. Your root badge is kept so new connections still have something to attach to.",
      )
    ) {
      return;
    }

    setClearing(true);
    try {
      const response = await fetch("/api/admin/clear", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ scope: "all" }),
      });
      if (response.status === 401) {
        sessionStorage.removeItem("bump-admin-secret");
        window.alert("That admin key was rejected. Click clear again to re-enter it.");
        return;
      }
      if (!response.ok) throw new Error(`Clear failed (${response.status})`);
      sessionStorage.setItem("bump-admin-secret", secret);
      setSelected(null);
      refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not clear the board.");
    } finally {
      setClearing(false);
    }
  };

  /* Contact details are not in /api/graph; fetch the clicked node on demand. */
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    fetch(historical ? `/api/nodes/history/${selected.id}` : `/api/nodes/${selected.id}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((node: NodeDetail | null) => {
        if (!cancelled) setDetail(node);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [historical, selected?.id]);

  const profileRows = useMemo(() => {
    if (!detail) return [] as Array<[string, string]>;
    return ([
      ["Attendee ID", detail.attendeeId],
      ["Claim ID", detail.claimId],
      ["Profile version", detail.profileVersion],
      ["Email", detail.contact.email],
      ["Phone", detail.contact.phone],
      ["LinkedIn", detail.contact.linkedin],
      ["Discord", detail.contact.discord],
      [
        "Provisioned",
        detail.provisionedAt
          ? new Date(detail.provisionedAt).toLocaleString()
          : null,
      ],
    ] as Array<[string, string | number | null | undefined]>).flatMap(([label, value]) =>
      value == null || value === "" ? [] : [[label, String(value)] as [string, string]],
    );
  }, [detail]);

  const recentPeople = useMemo(() => {
    if (historical || !graph || !recentConnection) return null;
    const source = graph.nodes.find((node) => node.id === recentConnection.sourceId);
    const target = graph.nodes.find((node) => node.id === recentConnection.targetId);
    return source && target ? { source, target } : null;
  }, [graph, historical, recentConnection]);

  useEffect(() => {
    if (!selected || !graph) return;
    setSelected(graph.nodes.find((node) => node.id === selected.id) ?? null);
  }, [graph, selected]);

  const selectedConnections = selected && graph
    ? graph.edges.filter((edge) => edge.sourceId === selected.id || edge.targetId === selected.id).length
    : 0;

  const visibleSessionIndex = graph?.visibleThroughSessionId
    ? graph.sessions.findIndex((session) => session.id === graph.visibleThroughSessionId)
    : -1;
  const stepSession = (direction: -1 | 1) => {
    if (!graph || visibleSessionIndex < 0) return;
    const next = graph.sessions[visibleSessionIndex + direction];
    if (next) setThroughSessionId(next.id);
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  return (
    <main className="projector-shell">
      <header className="projector-header">
        <BrandMark />
        <div className="projector-status">
          <div className={`live-status ${connectionState}`}>
            <span className="live-dot" />
            {connectionState === "live" ? historical ? "Historical mosaic" : "Live mosaic" : connectionState}
          </div>
          {graph?.sessions.length ? (
            <div className="sync-timeline" aria-label="Hourly timeline">
            <button
              type="button"
              className="icon-button"
              onClick={() => stepSession(-1)}
              disabled={visibleSessionIndex <= 0}
              title="Show the previous hour"
            ><ChevronLeft size={17} /></button>
            <span>
              {graph.sessions[visibleSessionIndex]?.label ?? "No bumps yet"}
              <small>{visibleSessionIndex + 1} of {graph.sessions.length} · cumulative</small>
            </span>
            <button
              type="button"
              className="icon-button"
              onClick={() => stepSession(1)}
              disabled={visibleSessionIndex >= graph.sessions.length - 1}
              title="Show the next hour"
            ><ChevronRight size={17} /></button>
            </div>
          ) : null}
        </div>
        <div className="header-actions">
          <a
            className="icon-button"
            href={historical ? "/projector" : "/projector/history"}
            title={historical ? "Open current mosaic" : "Open permanent historical mosaic"}
          >
            <Archive size={18} />
            <span className="sr-only">{historical ? "Open current mosaic" : "Open historical mosaic"}</span>
          </a>
          {!historical ? (
            <button
              className="icon-button danger"
              type="button"
              onClick={() => void clearBoard()}
              disabled={clearing}
              title="Clear the current mosaic — keeps your root badge and all history"
            >
              <Trash2 size={18} />
              <span className="sr-only">Clear the current mosaic</span>
            </button>
          ) : null}
          <button className="icon-button" type="button" onClick={toggleFullscreen} title="Toggle fullscreen">
            <Maximize2 size={18} />
            <span className="sr-only">Toggle fullscreen</span>
          </button>
        </div>
      </header>

      <section className="mosaic-stage">
        {graph ? (
          <GraphCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            zoom={zoom}
            selectedId={selected?.id ?? null}
            recentConnection={recentConnection}
            onSelect={(node) => setSelected(node?.kind === "badge" ? node : null)}
          />
        ) : (
          <div className="stage-message">
            <span className="loader-grid" aria-hidden="true" />
            <p>{error ?? "Warming up the mosaic"}</p>
            {error ? <button type="button" onClick={() => void refresh()}>Try again</button> : null}
          </div>
        )}

        <div className="mosaic-stats" aria-label="Mosaic statistics">
          <div><Users size={15} /><strong>{graph?.nodes.length ?? 0}</strong><span>people</span></div>
          <div><Network size={15} /><strong>{graph?.edges.length ?? 0}</strong><span>connections</span></div>
        </div>

        <div className="zoom-controls" aria-label="Graph zoom controls">
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(0.4, Math.round((value - 0.2) * 10) / 10))}
            disabled={zoom <= 0.4}
            aria-label="Zoom out by 20%"
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="zoom-reset"
            aria-label="Reset zoom"
            title="Reset zoom"
          >
            <RotateCcw size={13} />
            <span>{Math.round(zoom * 100)}%</span>
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(3, Math.round((value + 0.2) * 10) / 10))}
            disabled={zoom >= 3}
            aria-label="Zoom in by 20%"
          >
            <Plus size={15} />
          </button>
        </div>

        {recentPeople ? (
          <div className="recent-bump" aria-live="polite">
            <Radio size={16} />
            <span><strong>{recentPeople.source.displayName}</strong> met <strong>{recentPeople.target.displayName}</strong></span>
          </div>
        ) : null}

        <aside className={`person-panel ${selected ? "open" : ""}`} aria-hidden={!selected}>
          {selected ? (
            <>
              <button className="panel-close" type="button" onClick={() => setSelected(null)} aria-label="Close details">×</button>
              <PixelTile seed={selected.visualSeed} size={96} label={`${selected.displayName}'s mosaic tile`} />
              <p className="eyebrow">Attendee</p>
              <h2>{detail?.displayName ?? selected.displayName}</h2>
              {profileRows.length > 0 ? (
                <dl className="person-contact">
                  {profileRows.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="person-contact-empty">No contact details captured</p>
              )}
              <div className="connection-count"><strong>{selectedConnections}</strong><span>direct connections</span></div>
            </>
          ) : null}
        </aside>
      </section>

      <footer className="projector-footer">
        <span>Hack the North 2026</span>
        <span>Hack the North, visualized</span>
      </footer>
    </main>
  );
}
