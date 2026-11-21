// POST /paiements-maintenance — à planifier toutes les 5 min (pg_net, voir README) ou à lancer par un gestionnaire.
//  1. Réconcilie les paiements en attente depuis plus de 2 min (webhook perdu ou retardé).
//  2. Exécute les versements en attente si PAYOUT_AUTO=true.
// Authentification : en-tête « x-cron-secret: <CRON_SECRET> » ou jeton d'un gestionnaire.

import { adminClient, isAdmin, requireUser } from '../_shared/db.ts';
import { flag, handler, HttpError, json } from '../_shared/http.ts';
import { safeEqual } from '../_shared/crypto.ts';
import { getProvider } from '../_shared/providers/index.ts';
import { settle } from '../_shared/settle.ts';
import { runPayouts } from '../_shared/payouts.ts';

Deno.serve(handler(async (req) => {
  const db = adminClient();
  const cron = req.headers.get('x-cron-secret');
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  if (!(cron && secret && safeEqual(cron, secret))) {
    const user = await requireUser(req, db);
    if (!(await isAdmin(db, user.id))) throw new HttpError(403, 'acces_refuse');
  }

  const avant = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: pend } = await db.from('payments').select('id, provider, session_id, expires_at')
    .eq('status', 'en_attente').lt('created_at', avant).not('session_id', 'is', null).limit(50);

  const reconcilies: Array<{ id: string; resultat: string }> = [];
  for (const p of pend ?? []) {
    try {
      const s = await getProvider(p.provider, db).getSession(p.session_id);
      reconcilies.push({ id: p.id, resultat: await settle(db, p.provider, s) });
    } catch (e) {
      // Opérateur injoignable et session expirée depuis longtemps : on clôt le paiement localement
      if (p.expires_at && new Date(p.expires_at).getTime() < Date.now() - 60 * 60_000) {
        await db.rpc('echec_paiement', { p_payment: p.id, p_raison: 'expire_sans_reponse', p_final: true, p_statut: 'expire' });
        reconcilies.push({ id: p.id, resultat: 'expire_sans_reponse' });
      } else {
        reconcilies.push({ id: p.id, resultat: 'erreur: ' + String(e).slice(0, 120) });
      }
    }
  }

  const versements = flag('PAYOUT_AUTO') ? await runPayouts(db) : [];
  return json({ reconcilies, versements });
}));
