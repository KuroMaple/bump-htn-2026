import { FileUp, KeyRound, Plus, Radio, RefreshCw, Search, Users } from "lucide-react";
import Papa from "papaparse";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import type { AdminBadge } from "../types";

interface BadgeDraft {
  hardwareId: string;
  name: string;
  role: string;
  company: string;
  projectorIdentity: "alias" | "real_name" | "hidden";
}

const emptyDraft: BadgeDraft = {
  hardwareId: "",
  name: "",
  role: "",
  company: "",
  projectorIdentity: "alias",
};

async function adminRequest<T>(path: string, secret: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function AdminPage() {
  const [secret, setSecret] = useState(() => sessionStorage.getItem("bump-admin-secret") ?? "");
  const [badges, setBadges] = useState<AdminBadge[]>([]);
  const [draft, setDraft] = useState<BadgeDraft>(emptyDraft);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Enter the admin key to load the event roster.");
  const [busy, setBusy] = useState(false);

  const loadBadges = useCallback(async () => {
    setBusy(true);
    try {
      const result = await adminRequest<AdminBadge[]>("/api/admin/badges", secret);
      sessionStorage.setItem("bump-admin-secret", secret);
      setBadges(result);
      setStatus(`${result.length} badges loaded.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load badges.");
    } finally {
      setBusy(false);
    }
  }, [secret]);

  const visibleBadges = useMemo(() => {
    const normalized = query.toLowerCase().trim();
    if (!normalized) return badges;
    return badges.filter((badge) =>
      [badge.name, badge.publicAlias, badge.hardwareId, badge.company]
        .some((value) => value?.toLowerCase().includes(normalized)),
    );
  }, [badges, query]);

  const addBadge = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await adminRequest<AdminBadge>("/api/admin/badges", secret, {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft(emptyDraft);
      await loadBadges();
      setStatus("Badge registered and private link created.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not register badge.");
      setBusy(false);
    }
  };

  const importCsv = (file: File) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const roster = result.data.map((row) => ({
          hardwareId: row.hardware_id?.trim(),
          name: row.name?.trim(),
          role: row.role?.trim() || undefined,
          company: row.company?.trim() || undefined,
          bio: row.bio?.trim() || undefined,
          projectorIdentity: row.projector_identity?.trim() || "alias",
        }));
        setBusy(true);
        void adminRequest<{ imported: number }>("/api/admin/badges/import", secret, {
          method: "POST",
          body: JSON.stringify(roster),
        })
          .then(async ({ imported }) => {
            await loadBadges();
            setStatus(`${imported} badges imported.`);
          })
          .catch((error: unknown) => {
            setStatus(error instanceof Error ? error.message : "CSV import failed.");
            setBusy(false);
          });
      },
      error: (error) => setStatus(error.message),
    });
  };

  const simulate = async () => {
    if (badges.length < 2) {
      setStatus("Register at least two badges before simulating a bump.");
      return;
    }
    const left = badges[Math.floor(Math.random() * badges.length)]!;
    let right = left;
    while (right.id === left.id) right = badges[Math.floor(Math.random() * badges.length)]!;
    setBusy(true);
    try {
      const result = await adminRequest<{ status: string }>("/api/admin/simulate", secret, {
        method: "POST",
        body: JSON.stringify({
          badge_id_a: left.hardwareId,
          badge_id_b: right.hardwareId,
          signal_strength: -48,
        }),
      });
      setStatus(`${left.publicAlias} + ${right.publicAlias}: ${result.status.replace("_", " ")}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Simulation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <BrandMark />
        <div><p className="eyebrow">Operations</p><h1>Event control</h1></div>
        <Link to="/projector">Open mosaic</Link>
      </header>

      <section className="admin-toolbar">
        <label className="secret-input">
          <KeyRound size={17} />
          <span className="sr-only">Admin API key</span>
          <input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Admin API key" />
        </label>
        <button type="button" onClick={() => void loadBadges()} disabled={!secret || busy}>
          <RefreshCw size={16} className={busy ? "spinning" : ""} /> Load roster
        </button>
        <button className="secondary-button" type="button" onClick={() => void simulate()} disabled={busy || badges.length < 2}>
          <Radio size={16} /> Simulate bump
        </button>
        <label className="secondary-button file-button">
          <FileUp size={16} /> Import CSV
          <input type="file" accept=".csv,text/csv" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importCsv(file);
            event.target.value = "";
          }} />
        </label>
      </section>

      <p className="admin-status" aria-live="polite">{status}</p>

      <div className="admin-layout">
        <section className="roster-panel">
          <div className="panel-heading">
            <div><Users size={18} /><h2>Badge roster</h2><span>{badges.length}</span></div>
            <label className="search-input"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search roster" /></label>
          </div>
          <div className="roster-table" role="table">
            <div className="roster-row roster-columns" role="row"><span>Name</span><span>Hardware ID</span><span>Projector</span></div>
            {visibleBadges.map((badge) => (
              <div className="roster-row" role="row" key={badge.id}>
                <span><strong>{badge.name}</strong><small>{badge.publicAlias}</small></span>
                <code>{badge.hardwareId}</code>
                <span className={`identity-badge ${badge.projectorIdentity}`}>{badge.projectorIdentity.replace("_", " ")}</span>
              </div>
            ))}
            {!visibleBadges.length ? <div className="roster-empty">No matching badges</div> : null}
          </div>
        </section>

        <section className="register-panel">
          <div className="panel-heading"><div><Plus size={18} /><h2>Register badge</h2></div></div>
          <form onSubmit={(event) => void addBadge(event)}>
            <label>Hardware ID<input required value={draft.hardwareId} onChange={(event) => setDraft({ ...draft, hardwareId: event.target.value })} placeholder="badge-042" /></label>
            <label>Attendee name<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Full name" /></label>
            <div className="form-split">
              <label>Role<input value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} placeholder="Engineer" /></label>
              <label>Company<input value={draft.company} onChange={(event) => setDraft({ ...draft, company: event.target.value })} placeholder="Organization" /></label>
            </div>
            <label>Projector identity<select value={draft.projectorIdentity} onChange={(event) => setDraft({ ...draft, projectorIdentity: event.target.value as BadgeDraft["projectorIdentity"] })}><option value="alias">Generated alias</option><option value="real_name">Real name</option><option value="hidden">Hidden</option></select></label>
            <button type="submit" disabled={busy || !secret}><Plus size={16} /> Register badge</button>
          </form>
        </section>
      </div>
    </main>
  );
}
