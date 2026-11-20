import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://nexarishaiti.com"),
  title: {
    default: "NEXA Medical Center | Des soins plus proches de vous",
    template: "%s | NEXA Medical Center",
  },
  description:
    "NEXA Medical Center vous accompagne pour trouver des professionnels, prendre rendez-vous et suivre votre parcours de soins en Haïti.",
  applicationName: "NEXA Medical Center",
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr-HT">
      <body>{children}</body>
    </html>
  );
}
