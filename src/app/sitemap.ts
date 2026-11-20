import type { MetadataRoute } from "next";

const siteUrl = "https://nexarishaiti.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const publicRoutes = [
    { path: "/", priority: 1 },
    { path: "/care", priority: 0.9 },
    { path: "/pharmacie", priority: 0.8 },
    { path: "/laboratoires", priority: 0.8 },
    { path: "/imagerie", priority: 0.8 },
    { path: "/examens", priority: 0.7 },
    { path: "/medecins", priority: 0.8 },
    { path: "/professionnels/candidature", priority: 0.6 },
    { path: "/professionnels/candidature/infirmier", priority: 0.6 },
  ];

  return publicRoutes.map(({ path, priority }) => ({
    url: new URL(path, siteUrl).toString(),
    changeFrequency: "weekly" as const,
    priority,
  }));
}
