import { Maximize2, Network, Radio, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { GraphCanvas } from "../components/GraphCanvas";
import { PixelTile } from "../components/PixelTile";
import { useGraph } from "../hooks/useGraph";
import type { GraphNode } from "../types";

export function ProjectorPage() {
  const { graph, connectionState, recentConnection, error, refresh } = useGraph();
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const recentPeople = useMemo(() => {
    if (!graph || !recentConnection) return null;
    const source = graph.nodes.find((node) => node.id === recentConnection.sourceId);
    const target = graph.nodes.find((node) => node.id === recentConnection.targetId);
    return source && target ? { source, target } : null;
  }, [graph, recentConnection]);

  useEffect(() => {
    if (!selected || !graph) return;
    setSelected(graph.nodes.find((node) => node.id === selected.id) ?? null);
  }, [graph, selected]);

  const selectedConnections = selected && graph
    ? graph.edges.filter((edge) => edge.sourceId === selected.id || edge.targetId === selected.id).length
    : 0;

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  return (
    <main className="projector-shell">
      <header className="projector-header">
        <BrandMark />
        <div className={`live-status ${connectionState}`}>
          <span className="live-dot" />
          {connectionState === "live" ? "Live mosaic" : connectionState}
        </div>
        <button className="icon-button" type="button" onClick={toggleFullscreen} title="Toggle fullscreen">
          <Maximize2 size={18} />
          <span className="sr-only">Toggle fullscreen</span>
        </button>
      </header>

      <section className="mosaic-stage">
        {graph ? (
          <GraphCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            selectedId={selected?.id ?? null}
            recentConnection={recentConnection}
            onSelect={setSelected}
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
              <h2>{selected.displayName}</h2>
              <p className="person-meta">{[selected.role, selected.company].filter(Boolean).join(" · ") || "Here to connect"}</p>
              <div className="connection-count"><strong>{selectedConnections}</strong><span>direct connections</span></div>
            </>
          ) : null}
        </aside>
      </section>

      <footer className="projector-footer">
        <span>Hack the North 2026</span>
        <span>Every tile is a person. Every line is an introduction.</span>
      </footer>
    </main>
  );
}
