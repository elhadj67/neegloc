// Applique l'état d'une session opérateur au paiement correspondant.
// C'est le seul chemin qui encaisse : webhook, vérification de statut et réconciliation y passent tous.

import type { Db } from './db.ts';
import type { ProviderId, SessionState } from './providers/types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findPayment(db: Db, provider: ProviderId, s: Pick<SessionState, 'sessionId' | 'clientReference'>) {
  const bySession = await db.from('payments').select('*').eq('provider', provider).eq('session_id', s.sessionId).maybeSingle();
  if (bySession.data) return bySession.data;
  if (s.clientReference && UUID.test(s.clientReference)) {
    const byRef = await db.from('payments').select('*').eq('provider', provider).eq('id', s.clientReference).maybeSingle();
    if (byRef.data) return byRef.data;
  }
  return null;
}

export async function settle(db: Db, provider: ProviderId, s: SessionState): Promise<string> {
  const pay = await findPayment(db, provider, s);
  if (!pay) return 'paiement_inconnu';

  if (s.status === 'succeeded') {
    if (s.currency !== pay.currency) {
      await db.rpc('echec_paiement', { p_payment: pay.id, p_raison: `devise_recue_${s.currency}`, p_final: false });
      return 'devise_incorrecte';
    }
    const { data, error } = await db.rpc('appliquer_paiement', { p_payment: pay.id, p_tx: s.txId ?? null, p_montant: s.amount });
    if (error) throw new Error(`appliquer_paiement: ${error.message}`);
    return String(data);
  }
  if (s.status === 'failed' || s.status === 'expired') {
    const { error } = await db.rpc('echec_paiement', {
      p_payment: pay.id, p_raison: s.error ?? s.status, p_final: s.final, p_statut: s.status === 'expired' ? 'expire' : 'echoue',
    });
    if (error) throw new Error(`echec_paiement: ${error.message}`);
    return s.final ? 'echec' : 'tentative_refusee';
  }
  return 'en_attente';
}
