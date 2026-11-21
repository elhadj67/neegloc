# Neeg Loc : backend et paiement Wave / Orange Money

Backend Supabase de Neeg Loc (location immobilière au Sénégal) avec paiement intégré :
acompte de blocage, caution, solde et loyers payés par **Wave** ou **Orange Money**, confirmés
directement par l'opérateur. Viennent ensuite le séquestre de la caution, son versement au
propriétaire, le reversement des loyers et les remboursements.

> État : déployé sur Supabase et testé de bout en bout avec le simulateur et le transfert manuel
> (tests unitaires : `tools/deno.exe test supabase/functions/tests/`). Wave et Orange Money sont
> intégrés d'après leur documentation officielle et attendent les identifiants marchands.

## Architecture

```
 Navigateur / appli (web/)                 Supabase                               Opérateurs
 ─────────────────────────                 ────────                               ──────────
 NeegPay.payer() ── payments-create ──▶ calcule le montant (SQL montant_du)
                                         crée le paiement ─────────────────────▶ Wave Checkout / Orange
              ◀── URL Wave ou QR Orange ─┘                                         │
 le client valide dans Wave / Max It ───────────────────────────────────────────▶ │
                                         webhook-wave / webhook-orange ◀───────────┘ (signé)
                                           vérifie la signature, journalise l'événement (idempotence),
                                           relit le statut chez l'opérateur, puis
                                           appliquer_paiement() : réservation bloquée, caution payée, loyer…
 écran « Paiement reçu » ◀── temps réel (table payments) + payments-status (secours)

 pg_cron toutes les 5 min : expirer()          → libère les logements, expire les blocages de 72 h,
                                                 envoie les rappels, programme les remboursements
 pg_cron chaque jour 9 h : relancer_loyers()
 payouts-run / paiements-maintenance          → versements Wave (caution, loyers, remboursements),
                                                 réconciliation des paiements sans webhook
```

Principes :
- **Le navigateur ne fixe jamais un montant ni un statut.** Les montants viennent de `montant_du()`,
  les statuts ne changent que par les fonctions SQL. Les règles d'accès (RLS) interdisent toute
  écriture directe sur les réservations, les paiements et les versements.
- **Un paiement n'est encaissé que sur confirmation de l'opérateur** : webhook signé (Wave), ou
  statut relu par API (Orange, simulateur, réconciliation).
- **Idempotence partout** : chaque événement opérateur est enregistré une seule fois
  (`payment_events`), `appliquer_paiement()` ignore un paiement déjà encaissé, et les versements
  Wave portent une clé d'idempotence.
- **Un paiement en double, ou arrivé en retard, n'est jamais perdu** : il est encaissé puis
  remboursé automatiquement.

## Contenu

| Chemin | Rôle |
|---|---|
| `supabase/migrations/…_schema.sql` | Tables : profils, annonces, réservations, paiements, loyers, versements, événements, notifications |
| `supabase/migrations/…_metier.sql` | Règles métier : réservation, encaissement, expiration, rappels, bail, fin de bail, versements |
| `supabase/migrations/…_securite.sql` | Règles d'accès (RLS), droits par colonne et par fonction, temps réel, stockage des photos |
| `supabase/migrations/…_taches.sql` | Tâches pg_cron |
| `supabase/migrations/…_transfert*.sql` | Mode transfert manuel : déclaration par le locataire, validation par un gestionnaire |
| `supabase/functions/payments-create` | Ouvre une session de paiement |
| `supabase/functions/payments-status` | Statut d'un paiement, avec vérification chez l'opérateur |
| `supabase/functions/webhook-wave` | Webhook Wave (signature `Wave-Signature`) |
| `supabase/functions/webhook-orange` | Rappel Orange (jeton secret, puis relecture du statut) |
| `supabase/functions/simulateur`, `webhook-simulateur` | Opérateur simulé, au format Wave, pour tester sans compte marchand |
| `supabase/functions/payouts-run` | Versements déclenchés par un gestionnaire |
| `supabase/functions/paiements-maintenance` | Réconciliation et versements automatiques (tâche planifiée) |
| `supabase/functions/_shared/providers/` | Adaptateurs `wave.ts`, `orange.ts`, `simulateur.ts` derrière une interface commune |
| `supabase/functions/tests/` | Tests unitaires Deno (signatures, adaptateur Wave, encaissement) |
| `supabase/tests/scenario.sql` | Scénario SQL de bout en bout (acompte, expiration, caution, clés, loyer, fin de bail, confidentialité) |
| `web/neegpay.js` | Fenêtre de paiement à intégrer dans l'application |
| `web/retour.html`, `web/simulateur.html` | Page de retour après paiement ; page de l'opérateur simulé |
| `web/demo.html` | Démo complète : connexion, annonces, réservation, paiement, contrat, clés, loyers, versements |

## Mise en route (test avec le simulateur)

1. Créer un projet sur supabase.com, installer la [CLI Supabase](https://supabase.com/docs/guides/cli), puis :
   ```bash
   supabase link --project-ref <ref>
   supabase db push                                   # applique les migrations
   cp supabase/functions/.env.example supabase/functions/.env   # puis remplir
   supabase secrets set --env-file supabase/functions/.env
   supabase functions deploy payments-create payments-status payouts-run
   supabase functions deploy webhook-wave webhook-orange webhook-simulateur simulateur paiements-maintenance --no-verify-jwt
   ```
2. Héberger `web/` sur un site statique en HTTPS (Netlify, Vercel, Cloudflare Pages…).
   Copier `web/config.example.js` en `web/config.js`. Mettre `APP_URL` et `APP_ORIGIN` sur l'adresse du site.
3. Dans Supabase > Authentication > URL Configuration, ajouter l'adresse du site.
4. Créer deux comptes sur `demo.html`. Donner le rôle gestionnaire à l'un d'eux :
   `update profiles set role = 'admin' where id = '<uuid>';`
5. Publier une annonce avec le premier compte. Avec le second, la bloquer, puis payer avec le simulateur.

Planifier la réconciliation et les versements (SQL editor, après avoir activé `pg_net`) :
```sql
select cron.schedule('neegloc-maintenance', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<ref>.supabase.co/functions/v1/paiements-maintenance',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{}'::jsonb)
$$);
```

## Tester avec vos comptes personnels Wave et Orange Money

Les comptes personnels n'ont pas d'API : ni session de paiement, ni webhook. Pour faire circuler de
l'argent réel avant d'avoir les comptes marchands, utilisez le mode **transfert manuel** :

1. Dans `supabase/functions/.env`, mettez vos numéros personnels :
   `TRANSFERT_WAVE_NUMERO`, `TRANSFERT_OM_NUMERO` (et les noms affichés), puis
   `MOYENS_ACTIFS=transfert_wave,transfert_om`. Mettez la même liste dans `web/config.js`.
2. Le locataire choisit « Wave (transfert) » ou « Orange Money (transfert) ». Il envoie le montant
   exact sur votre numéro, puis colle le SMS de confirmation (la référence est remplie
   automatiquement) ou saisit la référence.
3. Vous recevez une notification. Dans `demo.html` > « Transferts à vérifier », retrouvez le
   transfert dans votre historique Wave ou Orange Money, puis cliquez **Reçu** ou **Non reçu**.
4. « Reçu » déclenche exactement la même logique qu'un paiement par API : blocage, caution, loyer,
   versements, remboursement en cas de retard ou de doublon.

Garde-fous :
- Rien n'est encaissé sans votre validation.
- Une référence ne peut être déclarée qu'une fois.
- Un transfert en cours de vérification suspend l'annulation et l'expiration du blocage.
- Seul un gestionnaire peut valider.

Les versements (caution au propriétaire, remboursements) se font à la main depuis votre téléphone,
puis se marquent « fait ».

Limites :
- Ce mode sert aux tests avec des proches et de petits montants. Les comptes personnels ne sont pas
  prévus pour encaisser une activité commerciale et ont des plafonds.
- Le parcours API (redirection Wave, webhook signé) ne se teste qu'avec le simulateur, en attendant
  Wave Business.
- Vous pouvez déjà créer un compte développeur gratuit sur le portail Sonatel pour obtenir
  l'environnement de test d'Orange Money.

## Brancher Wave (production)

1. Compte **Wave Business** (marchand) au Sénégal.
2. Business Portal > Développeur : créer une **clé API** avec les droits Checkout et Payout →
   `WAVE_API_KEY`. Si la clé est créée avec la signature des requêtes, mettre son secret dans
   `WAVE_SIGNING_SECRET`.
3. Business Portal > Développeur > Webhooks : URL `https://<ref>.supabase.co/functions/v1/webhook-wave`,
   stratégie **Signing secret**, événements `checkout.session.completed` et
   `checkout.session.payment_failed` → `WAVE_WEBHOOK_SECRET`.
4. `MOYENS_ACTIFS=wave` (ajouter `orange_money` plus tard), `SIMULATEUR_ACTIF=false`,
   `moyens: ['wave']` dans `web/config.js`.
5. Faire un vrai paiement de faible montant, puis un remboursement depuis l'espace gestionnaire.

Détails respectés (docs.wave.com) : montant en chaîne et sans décimales en XOF ; session valable
30 min ; la page Wave ne doit pas s'ouvrir dans une webview intégrée ; signature
HMAC-SHA256 de « horodatage + corps brut », rejet au-delà de 5 min, plusieurs `v1` acceptés ;
en-tête `Idempotency-Key` obligatoire sur les versements ; remboursement d'une session par
`/refund` ; liste d'adresses IP de Wave à autoriser si un pare-feu filtre les webhooks.

## Brancher Orange Money

L'adaptateur suit la spécification officielle « Orange Money API » v1.1.0 (22/10/2026), rangée dans
`docs/orange/` (non versionnée : documentation Sonatel). Parcours :

- `POST /oauth/v1/token` : jeton mis en cache jusqu'à son expiration.
- `POST /api/eWallet/v4/qrcode` : QR code et liens Max It / Orange Money, valables 30 min, à usage unique.
  Notre identifiant de paiement est envoyé comme `reference`, et l'URL de rappel (jeton compris) dans
  l'en-tête `X-Callback-Url` : rien à déclarer chez Orange.
- Rappel sur `webhook-orange` : jamais cru sur parole. Le statut est relu par
  `GET /api/eWallet/v1/transactions?reference=…` avant tout encaissement ; doublons écartés grâce à
  `X-Sonatel-Idempotency-Key`.

Mise en service :
1. Compte sur [developer.orange-sonatel.com](https://developer.orange-sonatel.com/), application de test,
   offres **OM Merchant Payment** et **Notification**.
2. Dans `supabase/functions/.env` : `ORANGE_CLIENT_ID`, `ORANGE_CLIENT_SECRET`, `ORANGE_MERCHANT_CODE`
   (6 chiffres). `ORANGE_BASE_URL` pointe sur la sandbox par défaut.
3. Ajouter `orange_money` à `MOYENS_ACTIFS` et à `moyens` dans `web/config.js`, envoyer les secrets.
4. Payer un QR code de test avec un numéro de la sandbox (`GET /api/assignments/v1/partner/sim-cards`),
   puis passer `ORANGE_MAPPING_VALIDE=true`.
5. Production : `ORANGE_BASE_URL=https://api.orange-sonatel.com` et les identifiants de production.

Les versements Orange (Cash In) demandent un compte distributeur et un code PIN chiffré en RSA : ils ne
sont pas automatisés. Le gestionnaire les fait à la main et les marque « fait ».

## Sécurité

- Les clés Wave et Orange ne quittent jamais le serveur (secrets Supabase). La clé `anon` de
  `config.js` est publique par conception.
- Webhook Wave : signature vérifiée sur le corps brut, comparaison en temps constant,
  horodatage contrôlé. Rappel Orange : jeton secret, puis statut relu chez Orange.
- Montant, devise et référence sont contrôlés à l'encaissement. Un écart bloque l'encaissement
  et alerte les gestionnaires.
- Les numéros des comptes de réception ne sont plus saisis dans l'application : l'argent arrive
  sur le compte marchand lié aux clés API.

## Réglementation (à valider avant d'encaisser pour des tiers)

Garder les cautions en séquestre, puis les reverser à des propriétaires, revient à gérer des fonds
pour le compte de tiers. Faites valider le montage par un juriste au regard des règles de la BCEAO
sur les services de paiement et des conditions des contrats marchands Wave et Orange (versements à
des tiers, délais de conservation).

## Ce qui reste à faire

1. **Orange Money** : tester en sandbox avec les identifiants Sonatel, puis passer `ORANGE_MAPPING_VALIDE=true`.
2. **Wave** : compte Wave Business et clés API (voir plus haut).
3. **Porter l'application Neeg Loc complète** sur ce backend. `web/demo.html` couvre le parcours de
   l'argent ; les écrans existants (annonces avec photos, espaces propriétaire et gestionnaire,
   contrat, quittances) doivent remplacer leur stockage par les tables et fonctions SQL d'ici.
4. **SMS / WhatsApp réels** : la table `notifications` porte le canal visé. Il reste à brancher un
   envoi (API SMS Orange, ou un fournisseur WhatsApp Business) par déclencheur ou par tâche planifiée.
