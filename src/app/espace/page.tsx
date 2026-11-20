import type { Metadata } from "next";
import PatientSpace from "./patient-space";

export const metadata: Metadata = {
  title: "Mon espace patient",
  robots: { index: false, follow: false },
};

export default function PatientSpacePage() {
  return <PatientSpace />;
}
