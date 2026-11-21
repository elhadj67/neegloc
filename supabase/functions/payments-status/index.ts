// GET /payments-status?id=<payment_id> — statut d'un paiement, avec vérification auprès de
// l'opérateur si le webhook tarde (filet de sécurité : le webhook reste la source principale).

import { adminClient, isAdmin, requireUser } from '../_shared/db.ts';
import { handler, HttpError, json } from '../_shared/http.ts';
import { getProvider } from '../_shared/providers/index.ts';
import { settle } from '../_shared/settle.ts';

Deno.serve(handler(async (req) => {
  const db = adminClient();
  const user = await requireUser(req, db);
  const id = new URL(req.url).searchParams.get('id') ?? '';
  const sel = 'id, booking_id, kind, mois, provider, amount, status, erreur, session_id, created_at, paid_at, tx_id';
  let { data: pay } = await db.from('payments').select(sel).eq('id', id).maybeSingle();
  if (!pay) throw new HttpError(404, 'paiement_introuvable');

  const { data: b } = await db.from('bookings').select('locataire_id').eq('id', pay.booking_id).single();
  if (b?.locataire_id !== user.id && !(await isAdmin(db, user.id))) throw new HttpError(404, 'paiement_introuvable');

  const age = Date.now() - new Date(pay.created_at).getTime();
  if (pay.status === 'en_attente' && pay.session_id && age > 15_000) {
    try {
      const s = await getProvider(pay.provider, db).getSession(pay.session_id);
      await settle(db, pay.provider, s);
      ({ data: pay } = await db.from('payments').select(sel).eq('id', id).single());
    } catch (err) {
      console.warn('vérification opérateur', err);
    }
  }
  const { session_id: _s, ...pub } = pay!;
  return json(pub);
}));
