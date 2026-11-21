// Mode « transfert manuel » : le client envoie l'argent par transfert Wave ou Orange Money vers un
// numéro (compte personnel pendant les tests), déclare la référence, et un gestionnaire valide après
// vérification dans son historique (fonctions SQL declarer_transfert / valider_transfert).
// Aucune API opérateur : rien n'est encaissé sans validation humaine.

import { env } from '../http.ts';
import type { Db } from '../db.ts';
import { type CheckoutInput, type CheckoutResult, type Provider, ProviderError, type SessionState } from './types.ts';

export type TransfertId = 'transfert_wave' | 'transfert_om';

export function transfertProvider(id: TransfertId, db: Db): Provider {
  const wave = id === 'transfert_wave';
  const operateur = wave ? 'Wave' : 'Orange Money';
  const numero = env(wave ? 'TRANSFERT_WAVE_NUMERO' : 'TRANSFERT_OM_NUMERO');
  const nom = Deno.env.get(wave ? 'TRANSFERT_WAVE_NOM' : 'TRANSFERT_OM_NOM') ?? '';
  const delaiMin = Number(Deno.env.get('TRANSFERT_DELAI_MINUTES') ?? '30');

  return {
    id,
    createCheckout(i: CheckoutInput): Promise<CheckoutResult> {
      const reference = 'NL' + i.paymentId.replaceAll('-', '').slice(0, 6).toUpperCase();
      return Promise.resolve({
        sessionId: 'tr_' + i.paymentId,
        action: { type: 'transfert', operateur, numero, nom, montant: i.amount, reference },
        expiresAt: new Date(Date.now() + delaiMin * 60_000).toISOString(),
        raw: { manuel: true },
      });
    },

    async getSession(sessionId: string): Promise<SessionState> {
      const { data: p } = await db.from('payments').select('id, amount, currency, status, tx_id').eq('session_id', sessionId).maybeSingle();
      if (!p) throw new ProviderError(id, 404, 'session_introuvable', sessionId);
      const status = p.status === 'reussi' ? 'succeeded' : p.status === 'echoue' ? 'failed' : p.status === 'expire' ? 'expired' : 'pending';
      // L'état vient de la validation du gestionnaire, déjà appliquée en base : rien de plus à faire ici
      return { sessionId, clientReference: p.id, amount: p.amount, currency: p.currency, status, final: status !== 'pending', txId: p.tx_id, raw: p };
    },
    // Pas de versement ni de remboursement automatiques : le gestionnaire les fait et les marque « fait »
  };
}
