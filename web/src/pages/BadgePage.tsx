import { ArrowLeft, Eye, EyeOff, Network, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import { PixelTile } from "../components/PixelTile";
import type { BadgePageData } from "../types";

export function BadgePage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<BadgePageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const response = await fetch(`/api/badges/${encodeURIComponent(token)}`);
      if (!response.ok) throw new Error("This badge page is unavailable.");
      setData((await response.json()) as BadgePageData);
    };
    void load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "This badge page is unavailable.");
    });
  }, [token]);

  if (!data) {
    return (
      <main className="personal-shell">
        <div className="personal-loading"><BrandMark /><p>{error ?? "Finding your place in the mosaic"}</p></div>
      </main>
    );
  }

  const identityLabel = data.badge.projectorIdentity === "real_name"
    ? "Your name is visible"
    : data.badge.projectorIdentity === "hidden"
      ? "Hidden from projector"
      : `Visible as ${data.badge.publicAlias}`;

  return (
    <main className="personal-shell">
      <nav className="personal-nav">
        <BrandMark />
        <Link to="/projector"><ArrowLeft size={16} /> Mosaic</Link>
      </nav>

      <section className="profile-band">
        <PixelTile seed={data.badge.visualSeed} size={132} label={`${data.badge.displayName}'s mosaic tile`} />
        <div className="profile-copy">
          <p className="eyebrow">Your Bump tile</p>
          <h1>{data.badge.displayName}</h1>
          <p>{[data.badge.role, data.badge.company].filter(Boolean).join(" · ")}</p>
          {data.badge.bio ? <p className="profile-bio">{data.badge.bio}</p> : null}
          <span className="privacy-chip">
            {data.badge.projectorIdentity === "hidden" ? <EyeOff size={14} /> : <Eye size={14} />}
            {identityLabel}
          </span>
        </div>
      </section>

      <section className="personal-metrics">
        <div><Radio size={20} /><strong>{data.connections.length}</strong><span>people met</span></div>
        <div><Network size={20} /><strong>{data.secondDegreeCount}</strong><span>one introduction away</span></div>
      </section>

      <section className="badge-profile-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">From your badge</p>
            <h2>Profile details</h2>
          </div>
          <span>private to you</span>
        </div>
        <dl className="badge-profile-grid">
          {([
            ["Badge ID", data.badge.profile.badgeId],
            ["Attendee ID", data.badge.profile.attendeeId],
            ["Claim ID", data.badge.profile.claimId],
            ["Email", data.badge.profile.email],
            ["Phone", data.badge.profile.phone],
            ["LinkedIn", data.badge.profile.linkedin],
            ["Discord", data.badge.profile.discord],
            [
              "Provisioned",
              data.badge.profile.provisionedAt
                ? new Date(data.badge.profile.provisionedAt).toLocaleString()
                : null,
            ],
          ] as Array<[string, string | number | null]>)
            .filter(([, value]) => value !== null && value !== undefined && value !== "")
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{String(value)}</dd>
              </div>
            ))}
        </dl>
      </section>

      <section className="connections-section">
        <div className="section-heading">
          <div><p className="eyebrow">Your network</p><h2>Connections</h2></div>
          <span>{data.connections.length} total</span>
        </div>
        {data.connections.length ? (
          <div className="connection-list">
            {data.connections.map((connection) => (
              <article className="connection-row" key={connection.id}>
                <PixelTile seed={connection.visualSeed} size={50} />
                <div>
                  <h3>{connection.displayName}</h3>
                  <p>{[connection.role, connection.company].filter(Boolean).join(" · ") || "Conference attendee"}</p>
                </div>
                <time dateTime={connection.connectedAt}>
                  {new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(connection.connectedAt))}
                </time>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-connections"><Radio size={24} /><p>Your first connection will appear here.</p></div>
        )}
      </section>
    </main>
  );
}
