# Instructions du projet NEXARIS

## Architecture retenue

- Le site public est une application statique en HTML, CSS et JavaScript dans `site/`, publiée séparément sur GitHub Pages par `.github/workflows/pages.yml`.
- Le backend métier est constitué de Cloud Functions Firebase dans `functions/`, pour le projet NEXA `nexaris-1339d`.
- Le dashboard d’administration appartient au dépôt distinct `nexarismedicalcenter/nexamedcenter-admin`. Ne pas y déplacer le dashboard dans ce dépôt.
- Next.js et Vercel ne sont plus la cible d’hébergement. `src/` et les fichiers Next historiques servent uniquement de référence de migration; ne pas ajouter de nouvelle route produit Next.js ni Vercel.

## Données et intégrations

- Ne jamais lire ni écrire les collections Firestore directement depuis le navigateur pour les données métier. Passer par une Cloud Function qui vérifie l’utilisateur, son rôle, la propriété des ressources et les entrées.
- Ne jamais placer un secret, une clé privée ou un compte de service dans `site/`, le dépôt ou les journaux. La configuration Firebase Web est publique; les secrets restent dans Secret Manager ou l’environnement serveur autorisé.
- Smart Cut conserve uniquement la passerelle MonCash. Les échanges avec cette passerelle restent serveur-à-serveur, signés et limités à une référence opaque, un montant et une devise. Ne lui transmettre aucune identité, donnée clinique, adresse ou détail de commande.
- Ne pas importer les données historiques Smart Cut Health dans le projet NEXA.

## Vérifications et publication

- Ne pas lancer tests, builds, émulateurs, commandes de déploiement, changements DNS ou écritures Firebase de production sans demande explicite de l’utilisateur.
- Avant une publication demandée, vérifier l’état Git, ne pas écraser les changements existants, ajouter uniquement les fichiers prévus, puis vérifier le workflow Pages, le SHA publié et l’URL publique.
