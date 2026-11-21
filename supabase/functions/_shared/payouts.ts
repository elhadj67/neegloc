// Exécution des versements sortants (caution et loyers aux propriétaires, remboursements aux locataires).

import type { Db } from './db.ts';
import { getProvider } from './providers/index.ts';
import { ProviderError, type ProviderId } from './providers/types.ts';
import { toE164 } from './tel.ts';

const RAISON: Record<string, string> = {
  caution_proprio: 'Caution Neeg Loc',
  loyer_proprio: 'Loyer Neeg Loc',
  remboursement_locataire: 'Remboursement Neeg Loc',
};

export async function runPayouts(db: Db, onlyId?: string): Promise<Array<{ id: string; statut: string; detail?: string }>> {
  let q = db.from('payouts').select('*, source:payments(id, provider, session_id, amount)').eq('statut', 'a_faire').order('created_at').limit(20);
  if (onlyId) q = q.eq('id', onlyId);
  const { data: list, error } = await q;
  if (error) throw error;
  const out: Array<{ id: string; statut: string; detail?: string }> = [];

  for (const po of list ?? []) {
    // Verrou optimiste : un seul exécutant par versement
    const lock = await db.from('payouts').update({ statut: 'en_cours' }).eq('id', po.id).eq('statut', 'a_faire').select('id');
    if (!lock.data?.length) continue;
    try {
      const provider = getProvider(po.provider as ProviderId, db);
      // Remboursement intégral d'un paiement Wave : on rembourse la session d'origine plutôt que de faire un versement
      if (po.kind === 'remboursement_locataire' && po.source && po.source.amount === po.montant && provider.refundSession && po.source.session_id) {
        await provider.refundSession(po.source.session_id);
        await db.from('payments').update({ status: 'rembourse' }).eq('id', po.source.id);
        await db.rpc('payout_termine', { p_payout: po.id, p_statut: 'reussi', p_ref: `refund:${po.source.session_id}`, p_erreur: null });
        out.push({ id: po.id, statut: 'reussi', detail: 'remboursement de session' });
        continue;
      }
      if (!provider.payout) {
        await db.from('payouts').update({ statut: 'a_faire', erreur: 'versement_automatique_indisponible' }).eq('id', po.id);
        out.push({ id: po.id, statut: 'a_faire', detail: 'à faire à la main' });
        continue;
      }
      const r = await provider.payout({
        payoutId: po.id, idempotencyKey: po.idempotency_key, amount: po.montant, mobile: toE164(po.tel), name: po.nom,
        reason: `${RAISON[po.kind] ?? 'Neeg Loc'} ${po.booking_id}`,
      });
      if (r.status === 'succeeded') {
        await db.rpc('payout_termine', { p_payout: po.id, p_statut: 'reussi', p_ref: r.ref ?? null, p_erreur: null });
      } else if (r.status === 'failed') {
        await db.rpc('payout_termine', { p_payout: po.id, p_statut: 'echoue', p_ref: r.ref ?? null, p_erreur: r.error ?? 'echec' });
      } else {
        await db.from('payouts').update({ provider_ref: r.ref ?? null }).eq('id', po.id);   // reste « en_cours »
      }
      out.push({ id: po.id, statut: r.status, detail: r.error });
    } catch (e) {
      const msg = e instanceof ProviderError ? `${e.code}: ${e.message}` : String(e);
      // Avec la clé d'idempotence, relancer le même versement ne crée pas de doublon chez Wave
      await db.from('payouts').update({ statut: 'a_faire', erreur: msg.slice(0, 300) }).eq('id', po.id);
      out.push({ id: po.id, statut: 'erreur', detail: msg });
    }
  }
  return out;
}
