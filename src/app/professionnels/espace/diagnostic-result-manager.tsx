"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type ProviderType = "laboratory" | "imaging";
type ResultStatus = "RESULT_PENDING_REVIEW" | "CORRECTION_REQUESTED" | "VALIDATED" | "RESULT_AVAILABLE" | "NOT_PERFORMED" | "SUPERSEDED";
type ResultRequirements = { requiredCategories: string[]; allowSupplemental: boolean; allowMultiplePerCategory: boolean; maxFiles: number; maxFileBytes: number; allowedMimeTypes: string[] };
type OrderItem = { offerId: string; name: string; resultStatus?: ResultStatus; resultId?: string; correctionReason?: string; resultRequirements?: ResultRequirements };
type Order = { id: string; orderNumber: string; patientNumber: string; status: string; items: OrderItem[]; createdAt: string | null };
type UploadFile = { id: string; file: File; category: string };
type UploadPolicy = { fileId: string; fileName: string; uploadUrl: string; fields: Record<string, string> };

const statusLabels: Record<string, string> = {
  RESULT_PENDING_REVIEW: "Résultat transmis · revue NEXA en attente",
  CORRECTION_REQUESTED: "Correction demandée par NEXA",
  VALIDATED: "Résultat validé · transfert patient en attente",
  RESULT_AVAILABLE: "Résultat disponible au patient",
  NOT_PERFORMED: "Examen non réalisé · contacter NEXA",
  SUPERSEDED: "Ancienne version remplacée",
};

function fileKey(orderId: string, offerId: string) { return `${orderId}:${offerId}`; }

function requirementsFor(item: OrderItem, providerType: ProviderType): ResultRequirements {
  return item.resultRequirements || {
    requiredCategories: [providerType === "laboratory" ? "LAB_RESULT" : "IMAGING"],
    allowSupplemental: true,
    allowMultiplePerCategory: true,
    maxFiles: 20,
    maxFileBytes: 15 * 1024 * 1024,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  };
}

export default function DiagnosticResultManager({ user, providerType }: { user: User; providerType: ProviderType }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [uploads, setUploads] = useState<Record<string, UploadFile[]>>({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [performedAt, setPerformedAt] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ type: providerType });
      if (searchTerm) params.set("q", searchTerm);
      const result = await appointmentRequest<{ orders: Order[]; nextCursor?: string | null }>(user, `/api/provider/diagnostic-orders?${params}`);
      setOrders(result.orders || []);
      setNextCursor(result.nextCursor || null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Les commandes ne peuvent pas être chargées.");
    } finally { setLoading(false); }
  }, [providerType, searchTerm, user]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load, searchRevision]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchTerm(searchDraft.trim());
    setOrders([]); setNextCursor(null); setLoading(true); setError(""); setSearchRevision((value) => value + 1);
  }

  function clearSearch() {
    setSearchDraft(""); setSearchTerm(""); setOrders([]); setNextCursor(null); setLoading(true); setError(""); setSearchRevision((value) => value + 1);
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true); setError("");
    try {
      const params = new URLSearchParams({ type: providerType, cursor: nextCursor });
      if (searchTerm) params.set("q", searchTerm);
      const result = await appointmentRequest<{ orders: Order[]; nextCursor?: string | null }>(user, `/api/provider/diagnostic-orders?${params}`);
      setOrders((current) => {
        const existingIds = new Set(current.map((order) => order.id));
        return [...current, ...(result.orders || []).filter((order) => !existingIds.has(order.id))];
      });
      setNextCursor(result.nextCursor || null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les commandes précédentes ne peuvent pas être chargées."); }
    finally { setLoadingMore(false); }
  }

  function addFiles(key: string, selected: FileList | null, item: OrderItem) {
    if (!selected?.length) return;
    const requirements = requirementsFor(item, providerType);
    const values = Array.from(selected);
    const existing = uploads[key] || [];
    if (existing.length + values.length > requirements.maxFiles) { setError(`Un résultat peut contenir au maximum ${requirements.maxFiles} fichiers.`); return; }
    const invalid = values.find((file) => !requirements.allowedMimeTypes.includes(file.type) || file.size < 1 || file.size > requirements.maxFileBytes);
    if (invalid) { setError(`Chaque fichier doit respecter les formats autorisés et la limite de ${Math.round(requirements.maxFileBytes / (1024 * 1024))} Mio.`); return; }
    setUploads((current) => ({ ...current, [key]: [...(current[key] || []), ...values.map((file) => ({ id: window.crypto.randomUUID(), file, category: requirements.requiredCategories[0] }))] }));
    setError("");
  }

  function setFileCategory(key: string, id: string, category: string) {
    setUploads((current) => ({ ...current, [key]: (current[key] || []).map((entry) => entry.id === id ? { ...entry, category } : entry) }));
  }

  function removeFile(key: string, id: string) {
    setUploads((current) => ({ ...current, [key]: (current[key] || []).filter((entry) => entry.id !== id) }));
  }

  async function uploadResult(event: FormEvent<HTMLFormElement>, order: Order, item: OrderItem, key: string) {
    event.preventDefault();
    const selected = uploads[key] || [];
    const requirements = requirementsFor(item, providerType);
    if (!confirmed[key]) { setError("Confirmez la concordance patient, examen et commande."); return; }
    const missingCategory = requirements.requiredCategories.find((category) => !selected.some((entry) => entry.category === category));
    if (!selected.length || missingCategory) { setError(`Ajoutez au moins un fichier dans chaque catégorie obligatoire${missingCategory ? ` : ${missingCategory}` : ""}.`); return; }
    if (!requirements.allowMultiplePerCategory && selected.some((entry, index) => selected.some((other, otherIndex) => otherIndex < index && other.category === entry.category))) {
      setError("Cet examen n’autorise qu’un seul fichier par catégorie."); return;
    }
    setBusyId(key); setError(""); setNotice("");
    let uploadSessionId = "";
    try {
      const started = await appointmentRequest<{ uploadSessionId: string; files: UploadPolicy[] }>(user, "/api/provider/diagnostic-results/uploads", "POST", {
        orderId: order.id,
        examLineId: item.offerId,
        confirmMatch: true,
        files: selected.map(({ file, category }) => ({ fileName: file.name, contentType: file.type, size: file.size, category })),
      });
      uploadSessionId = started.uploadSessionId;
      await Promise.all(started.files.map(async (policy, index) => {
        const target = new URL(policy.uploadUrl);
        const localUpload = process.env.NODE_ENV !== "production" && target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
        if ((!localUpload && target.protocol !== "https:") || (!localUpload && target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com"))) throw new Error("Le lien de téléversement sécurisé n’est pas valide.");
        const form = new FormData();
        Object.entries(policy.fields).forEach(([name, value]) => form.append(name, value));
        form.append("file", selected[index].file, policy.fileName);
        const response = await fetch(target, { method: "POST", body: form, cache: "no-store" });
        if (!response.ok) throw new Error(`Le fichier ${index + 1} n’a pas été téléversé. Vérifiez votre connexion puis réessayez.`);
      }));
      const submitted = await appointmentRequest<{ message: string }>(user, "/api/provider/diagnostic-results/submit", "POST", {
        uploadSessionId,
        comment: comments[key] || "",
        performedAt: performedAt[key] || "",
      });
      setNotice(submitted.message);
      setUploads((current) => ({ ...current, [key]: [] }));
      setConfirmed((current) => ({ ...current, [key]: false }));
      setComments((current) => ({ ...current, [key]: "" }));
      setPerformedAt((current) => ({ ...current, [key]: "" }));
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Le résultat n’a pas pu être transmis.";
      setError(message);
      if (uploadSessionId) await appointmentRequest(user, "/api/provider/diagnostic-results/uploads", "DELETE", { uploadSessionId }).catch(() => undefined);
    } finally { setBusyId(""); }
  }

  const eligibleOrders = orders.filter((order) => ["EXAM_COMPLETED", "COMPLETED"].includes(order.status));
  return <section className="diagnostic-orders diagnostic-results" aria-labelledby="diagnostic-results-heading">
    <div className="diagnostic-orders-heading"><h3 id="diagnostic-results-heading">Résultats {providerType === "laboratory" ? "de laboratoire" : "d’imagerie"}</h3><button className="button button-quiet" disabled={loading || Boolean(busyId)} onClick={() => void load()} type="button">Actualiser</button></div>
    <form className="diagnostic-order-search" onSubmit={search} role="search">
      <label>Numéro de commande ou numéro patient NMC<input autoComplete="off" maxLength={100} onChange={(event) => setSearchDraft(event.target.value)} placeholder="NMC-LAB-0008 ou NMC-0000009" value={searchDraft} /></label>
      <button className="button button-primary" disabled={loading || loadingMore || Boolean(busyId)} type="submit">Rechercher</button>
      {searchTerm || searchDraft ? <button className="button button-quiet" disabled={loading || loadingMore || Boolean(busyId)} onClick={clearSearch} type="button">Effacer</button> : null}
      <p>La recherche porte sur le numéro complet de commande ou le numéro patient NMC.</p>
    </form>
    <p className="appointment-privacy">Les fichiers restent privés. NEXA vérifie chaque résultat et chaque fichier avant toute mise à disposition au patient.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
    {loading ? <p role="status">Chargement des commandes achevées…</p> : eligibleOrders.length ? <div className="diagnostic-order-list">{eligibleOrders.map((order) => <article className="diagnostic-order-card" key={order.id}>
      <div className="diagnostic-order-top"><div><strong>{order.orderNumber}</strong><span>Patient {order.patientNumber}</span><small>Examen effectué · {order.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium" }).format(new Date(order.createdAt)) : "Date à confirmer"}</small></div></div>
      <ul>{order.items.map((item) => {
        const key = fileKey(order.id, item.offerId);
        const canUpload = !item.resultStatus || item.resultStatus === "CORRECTION_REQUESTED";
        return <li className="diagnostic-result-line" key={item.offerId}>
          <strong>{item.name}</strong>
          {item.resultStatus ? <p className="appointment-privacy">{statusLabels[item.resultStatus] || item.resultStatus}</p> : null}
          {item.resultStatus === "CORRECTION_REQUESTED" && item.correctionReason ? <p className="appointment-privacy" role="note"><strong>Motif de correction demandé par NEXA :</strong> {item.correctionReason}</p> : null}
          {canUpload ? <form className="diagnostic-result-form" onSubmit={(event) => void uploadResult(event, order, item, key)}>
            <label>Ajouter des fichiers (limite {Math.round(requirementsFor(item, providerType).maxFileBytes / (1024 * 1024))} Mio chacun)<input accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={Boolean(busyId)} multiple onChange={(event) => { addFiles(key, event.currentTarget.files, item); event.currentTarget.value = ""; }} type="file" /></label>
            {(uploads[key] || []).length ? <ul className="diagnostic-result-files">{uploads[key].map((entry) => <li key={entry.id}><span>{entry.file.name} · {new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 1 }).format(entry.file.size / (1024 * 1024))} Mio</span><label>Catégorie<select disabled={Boolean(busyId)} value={entry.category} onChange={(event) => setFileCategory(key, entry.id, event.target.value)}>{(providerType === "laboratory" ? ["LAB_RESULT", "SUPPLEMENTAL"] : ["IMAGING", "RADIOLOGY_REPORT", "SUPPLEMENTAL"]).filter((category) => category !== "SUPPLEMENTAL" || requirementsFor(item, providerType).allowSupplemental).map((category) => <option key={category} value={category}>{category === "LAB_RESULT" ? "Résultat de laboratoire" : category === "IMAGING" ? "Image d’imagerie" : category === "RADIOLOGY_REPORT" ? "Compte rendu d’imagerie" : "Document complémentaire"}</option>)}</select></label><button className="button button-quiet" disabled={Boolean(busyId)} onClick={() => removeFile(key, entry.id)} type="button">Retirer</button></li>)}</ul> : null}
            <label>Date de réalisation (facultatif)<input type="date" value={performedAt[key] || ""} disabled={Boolean(busyId)} onChange={(event) => setPerformedAt((current) => ({ ...current, [key]: event.target.value }))} /></label>
            <label>Commentaire facultatif<textarea maxLength={1000} rows={3} value={comments[key] || ""} disabled={Boolean(busyId)} onChange={(event) => setComments((current) => ({ ...current, [key]: event.target.value }))} /></label>
            <label className="diagnostic-result-confirm"><input checked={confirmed[key] === true} disabled={Boolean(busyId)} onChange={(event) => setConfirmed((current) => ({ ...current, [key]: event.target.checked }))} type="checkbox" />Je confirme que ces fichiers correspondent au patient, à l’examen et à la commande affichés.</label>
            <button className="button button-primary" disabled={Boolean(busyId) || !confirmed[key] || requirementsFor(item, providerType).requiredCategories.some((category) => !(uploads[key] || []).some((entry) => entry.category === category))} type="submit">{busyId === key ? "Téléversement et analyse sécurisée…" : item.resultStatus === "CORRECTION_REQUESTED" ? "Transmettre la correction" : "Transmettre à la revue NEXA"}</button>
          </form> : null}
        </li>;
      })}</ul>
    </article>)}</div> : <p>{searchTerm ? "Aucune commande achevée ne correspond à ce numéro." : "Aucune commande achevée à transmettre à la revue NEXA."}</p>}
    {!loading && nextCursor ? <button className="button button-outline" disabled={loadingMore || Boolean(busyId)} onClick={() => void loadMore()} type="button">{loadingMore ? "Chargement des résultats précédents…" : "Charger les commandes achevées précédentes"}</button> : null}
  </section>;
}
