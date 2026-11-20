"use client";

import Link from "next/link";
import { FormEvent, Suspense, useEffect, useState } from "react";
import ServiceNavigation from "@/components/service-navigation";
import DiagnosticCatalog from "./diagnostic-catalog";

type DirectoryType = "doctors" | "laboratories" | "imaging-centers" | "pharmacies";

type DirectoryItem = {
  id: string;
  type: DirectoryType;
  name: string;
  specialty?: string;
  specialties?: string[];
  bio?: string;
  address?: string;
  department?: string;
  commune?: string;
  phone?: string;
  languages?: string[];
  consultationModes?: string[];
  indicativeFee?: number;
  photoUrl?: string;
  services?: string[];
  openingHours?: string;
};

const labels: Record<DirectoryType, string> = {
  doctors: "professionnels de santé",
  laboratories: "laboratoires",
  "imaging-centers": "centres d’imagerie",
  pharmacies: "pharmacies",
};

export default function Directory({
  type,
  title,
  description,
}: {
  type: DirectoryType;
  title: string;
  description: string;
}) {
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("");
  const [results, setResults] = useState<DirectoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({ type });
      if (query.trim()) params.set("q", query.trim());
      if (department.trim()) params.set("department", department.trim());
      try {
        const response = await fetch(`/api/catalog?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json() as { ok?: boolean; results?: DirectoryItem[]; error?: string };
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Chargement impossible.");
        setResults(payload.results || []);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Le répertoire ne répond pas.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [type, query, department, reload]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setQuery(String(form.get("q") || ""));
    setDepartment(String(form.get("department") || ""));
  }

  return (
    <main className="directory-page">
      <header className="directory-header">
        <Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil">
          <span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span>
        </Link>
        <ServiceNavigation className="directory-nav" />
        <Link className="button button-primary" href="/connexion">Se connecter</Link>
      </header>

      <section className="directory-intro">
        <p className="eyebrow">Répertoire NEXA</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </section>

      <form className="directory-filters" onSubmit={submit} role="search">
        <label>Rechercher dans {labels[type]}
          <input name="q" placeholder="Nom, spécialité ou service" />
        </label>
        <label>Département
          <input name="department" placeholder="Ex. Ouest" />
        </label>
        <button className="button button-primary" type="submit">Rechercher</button>
      </form>

      <section className="directory-results" aria-labelledby="directory-results-heading">
        <div className="directory-results-heading">
          <h2 id="directory-results-heading">{loading ? "Chargement du répertoire…" : `${results.length} résultat${results.length === 1 ? "" : "s"}`}</h2>
          <p>Seuls les profils publiés et vérifiés par NEXA apparaissent ici.</p>
        </div>
        {error ? <div className="directory-state directory-error" role="alert"><p>{error}</p><button className="button button-outline" onClick={() => setReload((value) => value + 1)} type="button">Réessayer</button></div> : null}
        {!error && !loading && results.length === 0 ? <div className="directory-state"><h3>Aucun profil publié pour le moment</h3><p>Essayez une autre recherche ou revenez plus tard.</p></div> : null}
        <div className="directory-grid" aria-live="polite">
          {results.map((item) => (
            <article className="directory-card" key={item.id}>
              <div className="directory-card-top">
                <span className="directory-avatar" aria-hidden="true">{item.name.slice(0, 1).toLocaleUpperCase("fr")}</span>
                <span className="directory-verified"><span aria-hidden="true">✓</span> Profil vérifié</span>
              </div>
              <h3>{item.name}</h3>
              {item.specialty ? <p className="directory-specialty">{item.specialty}{item.specialties?.length ? ` · ${item.specialties.join(" · ")}` : ""}</p> : null}
              {item.bio ? <p>{item.bio}</p> : null}
              {item.services?.length ? <p>{item.services.join(" · ")}</p> : null}
              <p className="directory-location">{[item.commune, item.department].filter(Boolean).join(" · ") || item.address || "Haïti"}</p>
              {item.openingHours ? <p className="directory-hours">{item.openingHours}</p> : null}
              {item.languages?.length ? <p className="directory-meta">Langues : {item.languages.join(", ")}</p> : null}
              {item.indicativeFee ? <p className="directory-fee">À partir de {new Intl.NumberFormat("fr-HT").format(item.indicativeFee)} HTG</p> : null}
              {item.phone ? <a className="directory-contact" href={`tel:${encodeURIComponent(item.phone)}`}>Appeler le {item.phone}</a> : null}
              {type === "doctors" ? <Link className="button button-outline" href={`/rendez-vous/${encodeURIComponent(item.id)}`}>Choisir un rendez-vous</Link> : null}
            </article>
          ))}
        </div>
      </section>

      {type === "laboratories" || type === "imaging-centers" ? <Suspense fallback={<section className="directory-results"><p role="status">Chargement des offres…</p></section>}><DiagnosticCatalog providerType={type === "laboratories" ? "laboratory" : "imaging"} /></Suspense> : null}

      <footer className="directory-footer"><Link href="/conditions">Conditions</Link><Link href="/confidentialite">Confidentialité</Link><span>© 2026 NEXA Medical Center</span></footer>
    </main>
  );
}
