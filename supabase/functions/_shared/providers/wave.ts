// Adaptateur Wave (Sénégal), d'après docs.wave.com (Checkout, Webhooks, Payout), lu le 21/11/2026.
//  - Checkout : POST /v1/checkout/sessions → wave_launch_url ; la session expire après 30 min.
//  - Webhook  : en-tête Wave-Signature, HMAC-SHA256 de (horodatage + corps brut).
//  - Payout   : POST /v1/payout avec en-tête Idempotency-Key obligatoire.
//  - Signature des requêtes sortantes : facultative, activée par clé dans le Business Portal.

import { waveSignatureHeader } from '../crypto.ts';
import { type CheckoutInput, type CheckoutResult, type PayoutInput, type PayoutResult, type Provider, ProviderError,
  type SessionState } from './types.ts';

export interface WaveConfig {
  apiKey: string;
  signingSecret?: string | null;   // si la clé API a été créée avec « request signing »
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

// deno-lint-ignore no-explicit-any
type Json = any;

/** Session Checkout Wave → état normalisé. */
export function mapWaveSession(s: Json): SessionState {
  let status: SessionState['status'] = 'pending';
  if (s.payment_status === 'succeeded') status = 'succeeded';
  else if (s.checkout_status === 'expired') status = 'expired';
  else if (s.payment_status === 'cancelled' && s.checkout_status !== 'open') status = 'failed';
  return {
    sessionId: s.id,
    clientReference: s.client_reference ?? null,
    amount: Number(s.amount),
    currency: s.currency,
    status,
    final: status !== 'pending',
    txId: s.transaction_id ?? null,
    error: s.last_payment_error?.code ?? null,
    raw: s,
  };
}

/** Événement webhook → état normalisé (null si l'événement ne concerne pas un paiement en ligne). */
export function parseWaveEvent(evt: Json): SessionState | null {
  if (!evt || typeof evt.type !== 'string' || !evt.data) return null;
  if (evt.type === 'checkout.session.completed') return mapWaveSession(evt.data);
  if (evt.type === 'checkout.session.payment_failed') {
    const s = mapWaveSession(evt.data);
    // Le client peut réessayer tant que la session reste ouverte
    return s.status === 'pending' ? { ...s, status: 'failed', final: false } : s;
  }
  return null;
}

export function waveProvider(cfg: WaveConfig): Provider {
  const base = cfg.baseUrl ?? 'https://api.wave.com';
  const doFetch = cfg.fetchFn ?? fetch;

  async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Json> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', ...extra };
    if (cfg.signingSecret) headers['Wave-Signature'] = await waveSignatureHeader(cfg.signingSecret, raw);
    const res = await doFetch(base + path, { method, headers, body: body === undefined ? undefined : raw });
    const text = await res.text();
    let data: Json = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* corps non JSON */ }
    if (!res.ok) throw new ProviderError('wave', res.status, data?.code ?? `http_${res.status}`, data?.message ?? text.slice(0, 300));
    return data;
  }

  return {
    id: 'wave',

    async createCheckout(i: CheckoutInput): Promise<CheckoutResult> {
      const body: Record<string, string> = {
        amount: String(Math.round(i.amount)),   // chaîne, sans décimales pour le XOF
        currency: i.currency,
        success_url: i.successUrl,
        error_url: i.errorUrl,
        client_reference: i.paymentId,
      };
      if (i.payerMobile) body.restrict_payer_mobile = i.payerMobile;
      const s = await call('POST', '/v1/checkout/sessions', body);
      return { sessionId: s.id, action: { type: 'redirect', url: s.wave_launch_url }, expiresAt: s.when_expires, raw: s };
    },

    async getSession(id: string): Promise<SessionState> {
      return mapWaveSession(await call('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`));
    },

    async expireSession(id: string): Promise<void> {
      try {
        await call('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`);
      } catch (e) {
        if (!(e instanceof ProviderError && (e.httpStatus === 409 || e.httpStatus === 404))) throw e;   // déjà terminée
      }
    },

    async refundSession(id: string): Promise<void> {
      await call('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/refund`);
    },

    async payout(i: PayoutInput): Promise<PayoutResult> {
      const body: Record<string, string> = {
        currency: 'XOF',
        receive_amount: String(Math.round(i.amount)),
        mobile: i.mobile,
        client_reference: i.payoutId,
      };
      if (i.name) body.name = i.name.slice(0, 255);
      if (i.reason) body.payment_reason = i.reason.slice(0, 40);
      const p = await call('POST', '/v1/payout', body, { 'Idempotency-Key': i.idempotencyKey });
      if (p.payout_error) return { status: 'failed', ref: p.id, error: `${p.payout_error.error_code}: ${p.payout_error.error_message}`, raw: p };
      const status = p.status === 'succeeded' ? 'succeeded' : p.status === 'failed' ? 'failed' : 'processing';
      return { status, ref: p.id, raw: p };
    },
  };
}
