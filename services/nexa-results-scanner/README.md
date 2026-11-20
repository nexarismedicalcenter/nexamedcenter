# Scanner privé des résultats NEXA

Ce service autonome ClamAV analyse les PDF, images JPEG/PNG/WebP et fichiers vocaux WebM/Ogg/MP4/MPEG transmis par les API NEXA. Pour chaque fichier audio propre, `ffprobe` décode aussi sa durée; si l’antivirus ou l’analyse de durée échoue, le fichier reste bloqué. Le service ne journalise, ne conserve et ne renvoie jamais le contenu du fichier.

L’image part de la variante officielle Debian 13, nécessaire à l’installation des paquets APT Node.js et FFmpeg. Le build refuse les versions ClamAV antérieures à 1.4.6 ou 1.5.4, qui n’incluent pas les correctifs de sécurité requis.

## Contrat HTTP

- `GET /healthz` indique seulement que le processus HTTP tourne. Ce contrôle ne remplace pas la vérification du démarrage ClamAV faite par `entrypoint.sh`.
- `POST /scan`, avec le type MIME dans `Content-Type` et les octets du fichier dans le corps. Limite : 15 Mio; types permis : `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg`.
- Le service traite au plus deux analyses simultanément par défaut. `NEXA_SCANNER_MAX_CONCURRENT_SCANS` peut fixer une limite de 1 à 16; toute autre valeur arrête le démarrage. Quand la limite est atteinte, `/scan` répond `503` avec `Retry-After: 2` avant de lire le fichier.
- Réponse `200`: `{"status":"CLEAN"|"INFECTED","scannerVersion":"…"}` et, pour un audio propre, `durationSeconds`. Erreur ou verdict inconnu : `503` et `UNAVAILABLE`; une file momentanément saturée répond `503` avec `Retry-After`; signature ou type invalide : `415`.

## Déploiement privé à faire au cutover

Depuis le projet Google Cloud `nexaris-1339d`, dans la région `us-east4`, créer une identité runtime distincte sans accès Firestore, Storage ou données médicales, puis publier ce service avec l’authentification Cloud Run obligatoire. Ne pas utiliser `--allow-unauthenticated`. Accorder `roles/run.invoker` uniquement à l’identité d’invocation utilisée par les Cloud Functions Firebase NEXA; ne pas accorder ce rôle à `allUsers` ou `allAuthenticatedUsers`.

Configurer `NEXA_MALWARE_SCANNER_URL` avec l’URL HTTPS du service et `NEXA_MALWARE_SCANNER_AUDIENCE` avec son audience Cloud Run exacte dans l’environnement des Cloud Functions NEXA. La fonction obtient un jeton d’identité Google avec l’identité dédiée d’invocation et ne transmet que les octets d’un objet de quarantaine après avoir vérifié son propriétaire, sa taille et son type. Les fichiers restent en quarantaine privée tant que chacun n’a pas reçu un verdict `CLEAN`; une panne du service bloque leur remise.

Ce dépôt contient le code du scanner, pas son image publiée ni ses secrets. Aucun déploiement n’a été exécuté.
