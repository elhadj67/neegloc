// Simulateur d'opérateur : reproduit le parcours Wave (page de paiement, webhook signé, statut)
// pour tester toute la chaîne sans compte marchand. Activé seulement si SIMULATEUR_ACTIF=true.

import type { Db } from '../db.ts';
import { mapWaveSession } from './wave.ts';
import { type CheckoutInput, type CheckoutResult, type PayoutInput, type PayoutResult, type Provider, ProviderError,
  type SessionState } from './types.ts';

// deno-lint-ignore no-explicit-any
type Json = any;

/** Ligne simulateur_sessions → objet session au format Wave. */
export function simToWave(row: Json): Json {
  const done = row.statut === 'succeeded';
  return {
    id: row.id,
    amount: String(row.amount),
    currency: row.currency,
    client_reference: row.payment_id,
    checkout_status: row.statut === 'open' ? 'open' : row.statut === 'expired' ? 'expired' : 'complete',
    payment_status: done ? 'succeeded' : row.statut === 'failed' ? 'cancelled' : 'processing',
    transaction_id: row.tx_id ?? null,
    last_payment_error: row.statut === 'failed' ? { code: 'payment-failure', message: 'Refusé dans le simulateur' } : null,
    when_created: row.created_at,
    when_expires: row.expires_at,
  };
}

export function simulateurProvider(db: Db, appUrl: string): Provider {
  return {
    id: 'simulateur',

    async createCheckout(i: CheckoutInput): Promise<CheckoutResult> {
      const id = 'sim_' + crypto.randomUUID().replaceAll('-', '').slice(0, 16);
      const { data, error } = await db.from('simulateur_sessions').insert({
        id, payment_id: i.paymentId, amount: i.amount, currency: i.currency, success_url: i.successUrl, error_url: i.errorUrl,
      }).select().single();
      if (error) throw new ProviderError('simulateur', 500, 'insertion', error.message);
      return { sessionId: id, action: { type: 'redirect', url: `${appUrl}/simulateur.html?session=${id}` }, expiresAt: data.expires_at, raw: data };
    },

    async getSession(id: string): Promise<SessionState> {
      const { data } = await db.from('simulateur_sessions').select('*').eq('id', id).maybeSingle();
      if (!data) throw new ProviderError('simulateur', 404, 'session_introuvable', id);
      if (data.statut === 'open' && new Date(data.expires_at).getTime() < Date.now()) data.statut = 'expired';
      return mapWaveSession(simToWave(data));
    },

    async expireSession(id: string): Promise<void> {
      await db.from('simulateur_sessions').update({ statut: 'expired' }).eq('id', id).eq('statut', 'open');
    },

    async refundSession(_id: string): Promise<void> { /* rien à faire */ },

    async payout(i: PayoutInput): Promise<PayoutResult> {
      return { status: 'succeeded', ref: 'SIMPO_' + i.idempotencyKey.slice(0, 8).toUpperCase(), raw: { simulated: true } };
    },
  };
}
