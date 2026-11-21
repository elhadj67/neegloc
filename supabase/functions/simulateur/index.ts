// /simulateur — API de la page de paiement simulée (web/simulateur.html).
//   GET  ?session=sim_…               → montant, bénéficiaire, statut
//   POST { session, action: 'payer'|'refuser' } → envoie un webhook signé, renvoie l'URL de retour
// Déployer avec --no-verify-jwt (la page est ouverte hors session Supabase, comme chez un opérateur).

import { adminClient, functionsBase } from '../_shared/db.ts';
import { env, flag, handler, HttpError, json } from '../_shared/http.ts';
import { waveSignatureHeader } from '../_shared/crypto.ts';
import { simToWave } from '../_shared/providers/simulateur.ts';

Deno.serve(handler(async (req) => {
  if (!flag('SIMULATEUR_ACTIF')) throw new HttpError(404, 'simulateur_inactif');
  const db = adminClient();

  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('session') ?? '';
    const { data: s } = await db.from('simulateur_sessions').select('*, payment:payments(kind, mois, booking_id)').eq('id', id).maybeSingle();
    if (!s) throw new HttpError(404, 'session_introuvable');
    return json({ id: s.id, amount: s.amount, currency: s.currency, statut: s.statut, expires_at: s.expires_at,
      kind: s.payment?.kind, mois: s.payment?.mois, booking_id: s.payment?.booking_id });
  }

  if (req.method !== 'POST') throw new HttpError(405, 'methode_non_autorisee');
  const { session, action } = await req.json().catch(() => ({}));
  const { data: s } = await db.from('simulateur_sessions').select('*').eq('id', session).maybeSingle();
  if (!s) throw new HttpError(404, 'session_introuvable');
  if (s.statut !== 'open' || new Date(s.expires_at).getTime() < Date.now()) throw new HttpError(409, 'session_terminee');
  if (action !== 'payer' && action !== 'refuser') throw new HttpError(400, 'action_invalide');

  const statut = action === 'payer' ? 'succeeded' : 'failed';
  const tx = action === 'payer' ? 'TSIM' + crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase() : null;
  const { data: row } = await db.from('simulateur_sessions').update({ statut, tx_id: tx }).eq('id', s.id).eq('statut', 'open').select().single();

  const evt = {
    id: 'SIM_' + crypto.randomUUID().replaceAll('-', ''),
    type: action === 'payer' ? 'checkout.session.completed' : 'checkout.session.payment_failed',
    data: simToWave(row),
  };
  const raw = JSON.stringify(evt);
  const res = await fetch(`${functionsBase()}/webhook-simulateur`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Wave-Signature': await waveSignatureHeader(env('SIMULATEUR_WEBHOOK_SECRET'), raw) },
    body: raw,
  });
  if (!res.ok) console.warn('webhook simulateur', res.status, await res.text());
  return json({ redirect: action === 'payer' ? s.success_url : s.error_url, webhook: res.status });
}));
