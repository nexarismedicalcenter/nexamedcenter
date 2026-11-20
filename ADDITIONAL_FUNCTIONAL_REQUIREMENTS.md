# Addenda fonctionnel NEXARIS MEDICAL CENTER

**Sources analysées intégralement :** cahier de cadrage NEXARIS fourni par l’utilisateur, sections 1 à 14, ainsi que sa nouvelle transmission du 10 novembre 2026. Cette note consolide les deux lectures, ajoute les exigences au chantier de migration en cours et ne remplace pas l’architecture NEXA déjà retenue.

## 1. Positionnement et périmètre des plateformes

- Le produit indépendant porte l’identité **NEXARIS MEDICAL CENTER** et regroupe Nexa - Care, Nexa - Pharma, Nexa - Lab et Nexa - Imaging. Les quatre pôles sont des liens de premier niveau du header.
- Le site Smart Cut peut garder une page de présentation Santé & Pharmacie statique qui explique les services et oriente chaque bouton vers le pôle NEXARIS correspondant. Elle ne gère ni comptes, ni dossiers, ni opérations de santé.
- Les patients accomplissent leurs démarches de santé sur le site NEXARIS. Smart Cut conserve seulement la passerelle MonCash autorisée; NEXA ne doit pas appeler ses anciennes fonctions Health.
- L’information de la page de présentation Smart Cut doit refléter les services effectivement publiés sur NEXARIS.

## 2. Pôles et parcours patients

- **Nexa - Care :** téléconsultations, rendez-vous médicaux proposés par un médecin, visites médicales à domicile et soins infirmiers à domicile.
- **Nexa - Pharma :** pharmacies et médicaments.
- **Nexa - Lab :** laboratoires et examens.
- **Nexa - Imaging :** imagerie médicale.
- Dans Care, le patient choisit d’abord le type de service; la recherche présente ensuite les professionnels compatibles avec le service, les horaires, les zones desservies et les tarifs publiés.
- Le patient peut payer les services par MonCash ou par son portefeuille NEXA.

## 3. Portefeuille, paiements et comptabilité

- Le patient ne peut ni recharger son portefeuille ni retirer son solde. Il reçoit les remboursements dans son portefeuille et peut réutiliser ces fonds pour d’autres services NEXARIS.
- Un remboursement en espèces reste une opération manuelle de l’administration.
- Ajouter une ligne de frais de transaction de **3,5 %** à tous les paiements de services, y compris les paiements par portefeuille; afficher les frais et le total avant confirmation et les conserver dans l’historique financier.
- Décision utilisateur antérieure : sur un service de 5 000 HTG, le patient paie 5 175 HTG; lors d’un remboursement intégral du service, 5 000 HTG sont crédités au portefeuille et les 175 HTG de frais restent à NEXARIS. Cette règle résout la question du remboursement des frais pour les deux moyens de paiement.
- Le cahier de cadrage initial mentionnait **70 % médecin / 30 % NEXARIS** pour les téléconsultations. Décision utilisateur ultérieure : les taux de commission seront fixés plus tard par type de service. Le 70/30 reste donc une valeur de référence non confirmée et ne doit pas être appliqué ni enregistré par défaut. Les frais de transaction de 3,5 % restent une ligne distincte.
- Les tarifs à domicile, les zones tarifaires et les commissions par type de service doivent être configurables par l’administration. Le dashboard NEXA peut enregistrer un taux distinct par type avec tous les champs laissés vides au départ; ces taux préparatoires ne sont appliqués à aucun paiement ou versement.
- **À définir avant tout versement professionnel :** le taux par type de service, son assiette comptable, son échéance et la réserve éventuelle. Aucun montant de commission ou versement professionnel ne doit être calculé tant que ces paramètres ne sont pas validés.
- Le versement du professionnel est déclenché à l’ouverture effective d’une téléconsultation; pour les prestations à domicile, après les validations de mission définies plus bas. Aucun système de retrait professionnel ne doit être ajouté avant clarification de la règle de versement et de la portée de la décision « aucun retrait ».

## 4. Téléconsultation et rendez-vous médical

- Un seul forfait est proposé : **25 minutes**. Le patient choisit un médecin et paie; le médecin voit la demande et peut l’accepter ou la refuser.
- Un refus du médecin rembourse intégralement le montant du service au portefeuille; les frais de transaction suivent la règle distincte ci-dessus.
- Le patient ne peut pas appeler avant l’heure prévue. À partir de cette heure, patient et médecin peuvent s’appeler jusqu’au démarrage effectif.
- Les tentatives d’appel et leurs horodatages sont conservés. Après deux tentatives initiées par le patient et restées sans réponse du médecin, le montant du service est remboursé à 100 % au patient; après deux tentatives initiées par le médecin et restées sans réponse du patient, le montant du service revient à NEXARIS et le médecin reçoit 0.
- Si une téléconsultation payée reste sans acceptation du médecin, aucune tentative patient ne peut être comptée. Le dossier reste donc en attente d’une décision de l’administration NEXARIS : aucun remboursement Wallet automatique ne part. L’administration peut créditer le prix du service au Wallet; si le patient demande des espèces, le remboursement est fait et consigné manuellement. Les frais de transaction restent à NEXARIS.
- Une consultation effectivement commencée déclenche le partage financier configuré.
- Un rendez-vous proposé par le médecin est payé par le patient; le paiement le confirme et le médecin ne peut ensuite pas le refuser. Le patient rejoint la salle d’attente à l’heure prévue.
- Décision confirmée : ni patient ni médecin ne peut annuler un rendez-vous. Après deux appels initiés par le médecin et restés sans réponse du patient, 100 % du montant du service reste à NEXARIS. Après deux appels initiés par le patient et restés sans réponse du médecin, 100 % du montant du service revient au portefeuille patient. Si le médecin n’accepte jamais la consultation payée, le cas reste en examen par l’administration, sans crédit automatique. L’absence doit être constatée et horodatée.
- Après expiration d’une retenue de réservation non payée, le patient peut choisir un nouveau créneau publié du même professionnel ou masquer l’ancien rendez-vous. Le masquage conserve l’archive et tous les montants et n’est autorisé que si le backend vérifie que le paiement n’a pas été réglé.

## 5. Visites médicales à domicile

- Les médecins peuvent s’affilier pour les téléconsultations et les visites à domicile. Leur fiche publique expose photo, nom, spécialité/qualification, zones, disponibilités par jour/plage, frais de visite et action de réservation.
- Une visite dure une heure; un médecin a au plus cinq visites par jour et un intervalle minimal de deux heures sépare deux visites. Une réservation payée ne peut pas être refusée dans la plateforme.
- Si le médecin ne peut pas venir, il appelle le patient et convient avec lui d’une nouvelle date/heure. Si sa présence n’est pas confirmée, le patient ne peut pas produire le code de clôture et récupère 100 % du montant du service au portefeuille. Une nouvelle visite est planifiée séparément.
- Services possibles selon qualification : consultation/examen, évaluation et orientation, prescriptions, suivi de maladies chroniques, soins gériatriques/pédiatriques/palliatifs, urgences non vitales, renouvellement d’ordonnances, certificats et conseils de prévention.
- Le médecin peut inscrire son évaluation dans le dossier et prescrire.

## 6. Soins infirmiers à domicile

- Créer un parcours d’affiliation infirmière distinct de celui des médecins : demande, vérification et décision d’approbation/refus par NEXARIS; le profil de service est complété après approbation.
- Répertorier les qualifications : infirmier généraliste, soins intensifs, gériatrie, pédiatrie, soins palliatifs, santé communautaire, anesthésie et instrumentation. Afficher la photo, le nom, la qualification, les années d’expérience calculées depuis l’année de début déclarée, les services, zones, disponibilités et tarif.
- Le catalogue de services, dans les limites de la qualification et des règles professionnelles applicables, comprend :
  - prise des signes vitaux : tension artérielle, température, fréquence cardiaque, saturation en oxygène et glycémie capillaire;
  - administration de médicaments et soins prescrits : injections intramusculaires, intraveineuses ou sous-cutanées et perfusions;
  - soins de plaies simples ou complexes, escarres et suivi de cicatrisation;
  - prélèvements sanguins et collecte d’échantillons (urine, selles notamment);
  - surveillance postopératoire, changement de pansement et retrait de points/agrafes selon prescription;
  - suivi de patients atteints de maladies chroniques, notamment diabète, hypertension, insuffisance cardiaque et maladies respiratoires;
  - aide aux personnes âgées, mobilité, prévention des chutes et surveillance générale;
  - soins d’hygiène et de confort, toilette au lit, habillage et prévention des escarres;
  - gestion de sondes urinaires/nasogastriques, stomies et oxygénothérapie;
  - éducation thérapeutique, conseils nutritionnels et suivi de l’observance;
  - accompagnement palliatif, soulagement de la douleur et soins de confort.
- Le personnel infirmier **ne peut pas prescrire** de médicaments. Il peut consigner les soins réalisés dans l’évaluation à domicile.
- L’administration configure les zones, le tarif total de chacune des périodes de travail **AM**, **PM** et **Week-end**, ainsi que la modalité de service : une visite, plusieurs visites pendant la période, ou modalités convenues après réservation. Le choix de modalité est affiché au patient avant paiement et conservé dans la réservation. Le nombre précis et le calendrier des visites multiples ne sont pas définis ici et ne doivent pas être inventés par le code.
- Horaires : AM lundi–vendredi 08 h–16 h; PM 16 h–08 h le lendemain; Week-end samedi 08 h–lundi 08 h. L’infirmier choisit les semaines où il offre AM/PM et les week-ends où il offre le bloc Week-end; les tarifs affichés correspondent à la période complète choisie.
- Décision utilisateur du 17 novembre 2026 : **un seul patient peut réserver chaque bloc hebdomadaire pour un infirmier donné**. L’unicité métier est donc infirmier + semaine de début + période (AM, PM ou Week-end), indépendamment de la commune; un bloc ne peut pas accueillir plusieurs patients ou visites fractionnées. Le serveur doit cacher les blocs déjà réservés et imposer l’exclusivité dans une transaction lors de la création et du paiement.
- Décision utilisateur du 18 novembre 2026 : si NEXA approuve un remboursement après examen du compte rendu, créditer au Wallet le **prix total de la période infirmière** (AM, PM ou Week-end), pour un paiement initial par MonCash ou Wallet. Les frais de transaction restent acquis à NEXARIS. Si le patient demande un remboursement en espèces, l’administration le traite et l’enregistre manuellement; aucun crédit Wallet ne doit alors être créé.
- Les taux de commission infirmiers restent à définir. Conserver le détail de chaque prestation de la semaine; une validation/code accompagne chaque prestation, mais le règlement du lot est déclenché en fin de semaine ou après les prestations du week-end concernées.

## 7. Confirmation des missions à domicile et preuves

- Le parcours cible décrit : choix du service, professionnel et plage; paiement; notification au professionnel; réalisation; formulaire patient; code unique envoyé par courriel et dans l’application; saisie du code par le professionnel; clôture et versement.
- Formulaire infirmier : présence, date/heures, correspondance photo/identité, soin complet/partiel/non fait, qualité, professionnalisme, ponctualité, courtoisie/respect (1–5), confirmation du patient, commentaire facultatif et signature électronique du patient/représentant.
- Formulaire médecin : présence/identité, date/heures, consultation complète/partielle/non faite, examen, ordonnance, examens recommandés, réponses aux questions, ponctualité, professionnalisme, écoute, explications, satisfaction globale, commentaire facultatif, confirmation du patient et signature.
- Conserver le lien réservation/patient/professionnel, heures, réponses, évaluations, signature, code et statut. GPS à l’arrivée/départ seulement si autorisé; photo de visite uniquement avec consentement explicite.
- Ces formulaires contiennent des données de santé et des signatures : accès limité aux parties autorisées, stockage privé, journalisation sans recopier les notes médicales, durée de conservation et consentement à fixer avant mise en production. Ne pas exposer GPS ou photos avant validation des autorisations et de la politique de rétention.

## 8. Dossier médical et historique

- Conserver le format NMC à **sept chiffres** (`NMC-0000001`), fixé par l’instruction explicite antérieure de l’utilisateur. Le format à six chiffres de l’exemple §9.1 du nouveau cahier est une incohérence rédactionnelle et ne remplace pas ce choix.
- Attribuer automatiquement à chaque compte NEXA enregistré un numéro patient NMC unique dès la création du compte Firebase Auth, avant même la finalisation du profil. L’attribution serveur doit être atomique, idempotente et protégée par l’index d’unicité; l’inscription, la connexion et les candidatures récupèrent le numéro attribué. Les sessions Auth anonymes ne sont pas des comptes enregistrés et ne consomment pas de numéro.
- Ajouter une fiche médicale initiale : nom/prénom depuis le compte, date de naissance et âge calculé, sexe, langues préférées (créole, français, anglais, espagnol), allergies avec détails conditionnels, diabète/hypertension avec mois et année de début, tabac, alcool, café et thé avec quantités conditionnelles.
- Afficher les informations essentielles en tête du dossier. Les réponses de cette fiche sont des données de santé sensibles.
- Créer une fiche datée par consultation, avec médecin, date/heure automatiques et validation/signature; garder les notes antérieures dans l’historique autorisé.
- Séparer les sections : fiche médicale, consultations, évaluations à domicile, médicaments/ordonnances, laboratoire, imagerie, résultats et documents.
- Distinguer écriture médicale des médecins et consignation des soins infirmiers; aucun rôle infirmier ne peut créer une prescription.

## 9. Accès au dossier et résultats

- Le NMC sert à rechercher le dossier, mais ne suffit jamais à autoriser sa lecture. Une autorisation de prise en charge doit lier le patient, le professionnel et le rendez-vous/service.
- L’accès lié à une téléconsultation ou un rendez-vous payé commence **au démarrage effectif de la consultation**, et expire après 24 h. À l’expiration, la lecture de l’historique et tous les droits d’écriture de cette autorisation sont bloqués. Un nouvel accès nécessite une nouvelle autorisation conforme au parcours.
- Un médecin ne peut écrire, prescrire ou proposer un rendez-vous que dans un parcours de prise en charge autorisé. Il ne peut pas détourner le dépôt d’un résultat qu’il n’a pas demandé.
- Le patient peut déposer les résultats d’examens dans son dossier. Seul le médecin prescripteur reçoit l’accès de suivi et une notification avec les identifiants nécessaires (nom, prénom, NMC, sexe, âge). Il peut alors ajouter une note, prescrire ou proposer un rendez-vous selon le cas; l’action est datée/auditée et notifiée au patient.
- Les prescriptions apparaissent dans « Mes ordonnances », les rendez-vous dans « Mes rendez-vous » et les rendez-vous payés dans la liste des consultations à venir du médecin.

## 10. Notifications et historique

Notifier le médecin pour toute demande de téléconsultation et son issue; patient/professionnel pour paiement, remboursement et rendez-vous confirmé; professionnels pour visites et soins réservés; médecin prescripteur pour résultats déposés; patient pour nouvelles notes, prescriptions ou rendez-vous; patient/professionnel pour formulaires, code validé et mission clôturée. Garder un historique acteur/objet/date/heure/statut pour les actions médicales et financières, avec minimisation des données médicales et financières dans les notifications.

## 11. Design et représentation

- Design professionnel, moderne, clair et rassurant, cohérent avec la page Health de référence tout en affichant l’identité indépendante NEXARIS.
- Les visuels de personnes représentent majoritairement des personnes noires, en cohérence avec le public haïtien.
- Sur Smart Cut, la présentation des services et leurs appels à l’action doivent être lisibles et pointer vers les routes correspondantes de nexarishaiti.com.
- Disponibilités, zones, tarifs et qualifications restent lisibles sur mobile comme sur ordinateur.

## 12. Harmonisation avec les décisions déjà données

| Sujet | Règle de travail |
|---|---|
| NMC | Garder sept chiffres (`NMC-0000001`), malgré l’exemple à six chiffres du cahier. |
| Frais de paiement | 3,5 % sur MonCash et portefeuille; le frais séparé revient à NEXARIS et n’est pas remboursé dans l’exemple utilisateur. |
| Remboursement | Le montant du service est crédité au portefeuille; aucun retrait patient; remboursement en espèces exécuté manuellement par l’administration. |
| Retraits professionnels | Ne pas créer de fonctionnalité de retrait sans nouvelle décision; le sens du « versement au compte professionnel » reste à préciser. |
| Téléconsultation et rendez-vous proposé | Le médecin peut refuser une téléconsultation demandée par le patient, avec remboursement du prix du service au Wallet. Un rendez-vous que le médecin a proposé ne peut pas être refusé après paiement; patient et médecin ne peuvent pas annuler ce rendez-vous. L’API distingue ces engagements par `bookingType` : elle crédite automatiquement le montant du service pour le refus d’une téléconsultation, garde les frais de transaction chez NEXARIS et refuse le refus d’un autre type de rendez-vous. |
| Visites à domicile | Décisions utilisateur des 10 et 17 novembre 2026 : adopter le parcours professionnel, créneau puis paiement; la réservation payée est confirmée sans approbation NEXA préalable. Maintenir jusqu’à cinq visites médicales par jour, une heure par visite et deux heures d’intervalle. Après le formulaire patient, une présence confirmée avec un écart d’identité ou de réalisation passe en revue NEXA. L’administration décide au cas par cas soit d’autoriser la clôture par code, soit de créditer au Wallet le prix du service uniquement; les frais de transaction restent acquis à NEXARIS. Un remboursement en espèces reste possible uniquement à la demande du patient et doit être traité manuellement par l’administration. Journaliser la décision et son motif codé; ne pas enregistrer de commentaire médical dans le journal administratif. |
| Soins infirmiers hebdomadaires | Le tarif est un montant total pour la période AM, PM ou Week-end sélectionnée. Règles de départ : AM = lundi–vendredi 08 h–16 h; PM = 16 h–08 h le lendemain; Week-end = samedi 08 h–lundi 08 h. L’administration configure les horaires, tarifs et modalité (visite unique, visites multiples ou modalités convenues après réservation); le personnel choisit les périodes et semaines où il travaille. Le nombre et le calendrier de visites multiples restent à préciser. Décision utilisateur du 17 novembre 2026 : un seul patient par infirmier, semaine et période; pas de réservations fractionnées ou multi-patients dans un bloc. Si NEXA autorise un remboursement après revue, créditer au Wallet le prix total de la période infirmière; les frais de transaction restent acquis à NEXARIS. Le remboursement en espèces est traité manuellement par l’administration. |
| Commissions professionnelles | Taux à définir par type de service. Le 70/30 mentionné dans le cahier initial n’est pas confirmé par la décision utilisateur ultérieure; aucun taux ou versement ne doit être appliqué par défaut. Les frais de transaction restent distincts. |
| Consentements sensibles | GPS, photo, signature et données de santé restent limités jusqu’à la validation des consentements et durées de conservation. |

## 13. Répartition des travaux par dépôt

- `nexamedcenter` : interface patient et professionnel, inscription/infirmiers, recherche Care, consultations, accès dossier limité dans le temps, résultats, formulaires de mission, paiements côté NEXA et notifications.
- `nexamedcenter-admin` : revue des affiliations, frais de transaction, tarifs/zones, commissions par type de service lorsqu’elles seront définies, absences, missions, validations, remboursements manuels et audit.
- `smartcutservices-main-live` : page statique de présentation Santé & Pharmacie, liens vers les routes publiques NEXARIS; aucun accès aux profils, dossiers ou opérations.
- `smartcut-backend` : passerelle générique MonCash conservée; retrait progressif des fonctions Health seulement après bascule et validation des liens/paiements.
- Firebase `nexaris-1339d` : source des données NEXARIS. Règles client, bucket privé, App Check, scanner, consentements et index doivent être validés sans réutiliser la base Smart Cut.

## 14. Éléments à ajouter à la matrice de parité

Ajouter des lignes de suivi distinctes pour : rôle infirmier et affiliation; catalogue des soins infirmiers; règles de disponibilité/semaine et zones; réservation et mission à domicile; contrôles d’absence par tentatives horodatées; clôture par code et paiement regroupé; dossier médical initial; accès médecin 24 h à partir de l’ouverture effective; accès de suivi du prescripteur; résultats téléversés par patient; changements de rendez-vous et absences; paramétrage financier et historique des paramètres; page marketing Smart Cut; notifications et preuves de mission. Les tarifs non décidés, la politique de conservation et la rémunération professionnelle restent des bloqueurs métier avant publication.

## Décision ultérieure — réservation des visites médicales à domicile — 10 novembre 2026

À la question de savoir si la visite suit « demande puis confirmation NEXA » ou « professionnel, créneau et paiement », l’utilisateur a explicitement choisi le second parcours. Cette décision remplace l’ancienne étape de confirmation NEXA préalable pour les nouvelles réservations. Les anciennes demandes restent conservées pour leur traitement historique.
