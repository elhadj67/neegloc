// POST /payments-create — ouvre une session de paiement chez l'opérateur choisi.
// Corps : { booking_id, kind: 'acompte'|'caution'|'solde'|'loyer', mois?, provider, payer_tel? }
// Le montant est toujours recalculé côté serveur (fonction SQL montant_du).

import { adminClient, requireUser } from '../_shared/db.ts';
import { env, handler, HttpError, json, sqlCode } from '../_shared/http.ts';
import { getProvider, moyensActifs } from '../_shared/providers/index.ts';
import type { ProviderId } from '../_shared/providers/types.ts';
import { toE164 } from '../_shared/tel.ts';

const KINDS = ['acompte', 'caution', 'solde', 'loyer'];
const LIBELLE: Record<string, string> = { acompte: 'Acompte de blocage', caution: 'Caution', solde: 'Solde de caution', loyer: 'Loyer' };

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'methode_non_autorisee');
  const db = adminClient();
  const user = await requireUser(req, db);
  const body = await req.json().catch(() => ({}));
  const { booking_id, kind } = body;
  const mois: string | null = kind === 'loyer' ? (body.mois ?? null) : null;
  const provider = body.provider as ProviderId;

  if (!KINDS.includes(kind)) throw new HttpError(400, 'type_invalide');
  if (!moyensActifs().includes(provider)) throw new HttpError(400, 'moyen_indisponible');

  const { data: b } = await db.from('bookings').select('id, locataire_id, listing_id').eq('id', booking_id).maybeSingle();
  if (!b || b.locataire_id !== user.id) throw new HttpError(404, 'reservation_introuvable');

  const { data: amount, error: e1 } = await db.rpc('montant_du', { p_booking: b.id, p_kind: kind, p_mois: mois });
  if (e1) throw new HttpError(409, sqlCode(e1, 'paiement_non_attendu'));

  let payerMobile: string | undefined;
  if (body.payer_tel) {
    try { payerMobile = toE164(body.payer_tel); } catch { throw new HttpError(400, 'numero_invalide'); }
  }

  // Une seule session ouverte par réservation : on réutilise ou on ferme les précédentes
  const { data: open } = await db.from('payments').select('*').eq('booking_id', b.id).in('status', ['cree', 'en_attente']);
  // Un transfert déjà déclaré attend la vérification du gestionnaire : on ne l'écrase pas
  if ((open ?? []).some((p) => p.declare_le)) throw new HttpError(409, 'transfert_en_verification');
  for (const p of open ?? []) {
    const encoreValide = p.expires_at && new Date(p.expires_at).getTime() > Date.now() + 2 * 60_000;
    if (encoreValide && p.action && p.kind === kind && p.provider === provider && (p.mois ?? null) === mois && p.amount === amount) {
      return json({ payment_id: p.id, action: p.action, amount, reused: true });
    }
    try { if (p.session_id) await getProvider(p.provider, db).expireSession?.(p.session_id); } catch (err) { console.warn('expiration', err); }
    // Si ce paiement aboutit quand même, appliquer_paiement l'encaisse et rembourse un éventuel trop-perçu
    await db.rpc('echec_paiement', { p_payment: p.id, p_raison: 'remplace', p_final: true, p_statut: 'expire' });
  }

  const { data: pay, error: e2 } = await db.from('payments')
    .insert({ booking_id: b.id, kind, mois, provider, amount, payer_tel: payerMobile ?? null, created_by: user.id })
    .select().single();
  if (e2) throw new HttpError(409, 'creation_impossible', e2.message);

  const app = env('APP_URL');
  try {
    const r = await getProvider(provider, db).createCheckout({
      paymentId: pay.id,
      amount,
      currency: 'XOF',
      successUrl: `${app}/retour.html?p=${pay.id}`,
      errorUrl: `${app}/retour.html?p=${pay.id}&e=1`,
      payerMobile: body.restreindre_numero ? payerMobile : undefined,
      description: `${LIBELLE[kind]}${mois ? ' ' + mois : ''} · ${b.id}`,
    });
    const expires = r.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString();
    await db.from('payments').update({
      status: 'en_attente', session_id: r.sessionId, action: r.action, expires_at: expires,
      checkout_url: 'url' in r.action ? (r.action.url ?? null) : null,
    }).eq('id', pay.id);
    return json({ payment_id: pay.id, action: r.action, amount, expires_at: expires });
  } catch (err) {
    console.error(err);
    await db.from('payments').update({ status: 'echoue', erreur: String(err).slice(0, 300) }).eq('id', pay.id);
    throw new HttpError(502, 'operateur_indisponible', 'Le service de paiement ne répond pas, réessayez dans un instant.');
  }
}));
