export const HOME_VISIT_SERVICES = [
  { id: "CONSULTATION_EXAMINATION", label: "Consultation et examen" },
  { id: "EVALUATION_ORIENTATION", label: "Évaluation et orientation" },
  { id: "CHRONIC_DISEASE_FOLLOW_UP", label: "Suivi des maladies chroniques" },
  { id: "GERIATRIC_CARE", label: "Soins gériatriques" },
  { id: "PEDIATRIC_CARE", label: "Soins pédiatriques" },
  { id: "PALLIATIVE_CARE", label: "Soins palliatifs" },
  { id: "NON_LIFE_THREATENING_URGENT_CARE", label: "Urgence non vitale" },
  { id: "PRESCRIPTION", label: "Prescription" },
  { id: "PRESCRIPTION_RENEWAL", label: "Renouvellement d’ordonnance" },
  { id: "CERTIFICATE", label: "Certificat médical" },
  { id: "PREVENTION_COUNSELING", label: "Conseils de prévention" },
] as const;

export type HomeVisitServiceId = (typeof HOME_VISIT_SERVICES)[number]["id"];

export function getHomeVisitServiceLabel(value: unknown): string {
  return HOME_VISIT_SERVICES.find((service) => service.id === value)?.label || "Visite médicale à domicile";
}
