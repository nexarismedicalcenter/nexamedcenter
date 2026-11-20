# NEXARIS Medical Center

Site public indépendant, destiné au domaine `nexarishaiti.com` et au projet Firebase `nexaris-1339d`. La publication prévue utilise HTML, CSS et JavaScript statiques sur GitHub Pages; les services métier utilisent Firebase Cloud Functions. Le dépôt séparé `nexamedcenter-admin` héberge le tableau de bord d’administration. Les sources historiques Next.js/Vercel restent dans `src/` comme référence et ne sont pas exécutées par GitHub Pages.

## Architecture et publication

- Le workflow `.github/workflows/pages.yml` publie uniquement `site/`.
- Avant d’activer Pages, définir la variable Actions `NEXA_APPCHECK_SITE_KEY` avec la clé de site App Check autorisée pour `nexarishaiti.com`. Le workflow l’injecte dans la copie publiée de `site/firebase-config.js`; elle n’est pas conservée dans le dépôt.
- Les règles Firestore et Storage refusent les accès directs des clients. Les lectures et écritures métier passent par des Cloud Functions qui vérifient Firebase Auth, App Check, les permissions et les entrées.
- Firebase Admin SDK s’utilise côté serveur avec l’identité d’exécution Google Cloud. Ne jamais placer une clé de compte de service dans le dépôt ou le navigateur.
- `storage.cors.json` limite les téléversements signés au site NEXA et aux origines locales de développement. Les règles Storage restent fermées par défaut.
- Aucun déploiement, changement DNS ou changement de données Firebase de production n’est effectué par le travail local.

## Parcours et règles métier

Le site statique comprend les parcours d’accueil, répertoires, authentification patient, profil médical initial, portefeuille, rendez-vous et notifications, ainsi que les candidatures et espaces professionnels. Nexa - Care propose des créneaux, une retenue de réservation de 20 minutes et un paiement MonCash via le pont serveur Smart Cut ou par Wallet NEXA. Les montants affichent le prix du service, les frais de transaction et le total avant paiement.

Chaque compte Auth enregistré non anonyme reçoit automatiquement un numéro patient NMC séquentiel au format `NMC-0000001`, même si le compte est créé hors du formulaire du site ou utilise uniquement un numéro de téléphone. L’attribution est atomique et idempotente; les sessions anonymes ne consomment pas de numéro.

Pour une téléconsultation demandée par le patient, le refus du médecin crédite le prix du service au Wallet; les frais de transaction restent acquis à NEXARIS. Après deux appels initiés par le patient et restés sans réponse du médecin, le prix du service est crédité au Wallet. Après deux appels initiés par le médecin et restés sans réponse du patient, le prix du service reste à NEXA et aucun versement médecin n’est dû. Si une téléconsultation payée n’est jamais acceptée, elle reste en attente d’examen administratif après l’heure prévue, sans remboursement automatique. Tout remboursement en espèces demandé par le patient est traité manuellement par l’administration; les frais de transaction ne sont pas remboursés.

Le Wallet ne permet aucun dépôt ni retrait. Les paiements Wallet couvrent le prix du service et les frais enregistrés pour le rendez-vous. Un remboursement approuvé crédite le prix du service seulement. Les taux de commission seront configurés ultérieurement par type de service.

Les soins infirmiers utilisent des périodes exclusives AM, PM ou Week-end, aux heures fixées par l’administration. Le personnel choisit la période de travail; un patient réserve la période disponible. L’administration configure le tarif et le mode de prestation. Les remboursements infirmiers approuvés portent sur le prix total de la période; les frais de transaction restent acquis à NEXARIS.

Le pont MonCash conserve Smart Cut comme intermédiaire de paiement serveur-à-serveur signé. NEXA transmet une référence opaque, le montant HTG et le statut de règlement; aucun nom, UID, rendez-vous ou détail médical n’est transmis à Smart Cut. Les fonctions et callbacks utilisent des secrets HMAC distincts et sont idempotents.

Le site inclut les parcours médicaux et des téléconsultations Agora. Les jetons Agora restent côté serveur. Les présences et tentatives d’appel sont rapprochées par Cloud Functions; les événements signés Agora doivent être configurés avant toute activation des opérations financières en production.

## Développement local

1. Installer Node.js, Java, Firebase CLI et un serveur statique local.
2. Vérifier que le projet Firebase d’émulation `demo-nexaris` est sélectionné; ne pas démarrer les émulateurs avec le projet de production.
3. Démarrer les émulateurs:

   ```powershell
   firebase emulators:start --project demo-nexaris
   ```

4. Servir `site/` localement, par exemple sur `localhost:5500`. La configuration du client statique détecte localhost et utilise les émulateurs.

La clé App Check de développement reste vide avec les émulateurs. La clé du domaine public et les domaines Auth autorisés doivent être configurés avant d’activer les parcours protégés en production.

## Contrôles disponibles

```powershell
npm run lint
npm run build
npm test
npm run test:emulator
```

`npm run test:emulator` utilise le projet `demo-nexaris`. Aucun contrôle ni test ne signifie que les nouvelles fonctions sont déployées ou prêtes pour la production.

## État de migration

La migration de l’ancienne architecture Next.js/Vercel vers le site statique et Cloud Functions est partielle. La présence d’une route dans `src/` ne signifie pas qu’elle est accessible sur GitHub Pages. Les parcours protégés nécessitent les fonctions migrées, les secrets et la configuration App Check. Les textes statiques des conditions et de la confidentialité restent à faire approuver avant publication.
