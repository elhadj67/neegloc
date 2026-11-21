// Adaptateur Orange Money Sénégal (Sonatel), d'après la spécification officielle
// « Orange Money API » v1.1.0 du 22/10/2026 (docs/orange/, non versionné).
//
//  - Jeton : POST /oauth/v1/token (client_credentials, formulaire), valable `expires_in` secondes.
//  - Paiement : POST /api/eWallet/v4/qrcode → QR code (base64) + liens Max It / Orange Money.
//    Notre identifiant de paiement est envoyé comme `reference` et sert d'identifiant de session :
//    Orange ne donne l'identifiant de transaction (MP…) qu'une fois le client passé au paiement.
//  - Rappel : Orange POST le résultat sur l'URL passée dans l'en-tête X-Callback-Url
//    (schéma `Notification` : status SUCCESS | FAILED, transactionId, reference, amount).
//    On ne s'y fie jamais : le statut est relu par l'API avant tout encaissement.
//  - Statut : GET /api/eWallet/v1/transactions?reference=… (recherche par notre référence),
//    qui renvoie les transactions avec leur statut et leur identifiant MP….
//  - Versements (Cash In) : demandent un compte distributeur et un code PIN chiffré en RSA.
//    Pas encore branchés : le gestionnaire les fait à la main (fonction marquer_payout).
//
// Tant que ORANGE_MAPPING_VALIDE n'est pas à « true » (à faire après un paiement réussi en sandbox),
// l'adaptateur refuse de créer des paiements.

import { type CheckoutInput, type CheckoutResult, type Provider, ProviderError, type SessionState } from './types.ts';

export const ORANGE_SANDBOX = 'https://api.sandbox.orange-sonatel.com';
export const ORANGE_LIVE = 'https://api.orange-sonatel.com';

export interface OrangeConfig {
  baseUrl: string;            // ORANGE_BASE_URL : sandbox puis production
  clientId: string;
  clientSecret: string;
  merchantCode: string;       // code marchand Orange Money (6 chiffres)
  merchantName: string;
  callbackUrl: string;        // …/functions/v1/webhook-orange?token=…
  mappingValide: boolean;
  validite?: number;          // durée de vie du QR code en secondes (1800 par défaut)
  fetchFn?: typeof fetch;
}

// deno-lint-ignore no-explicit-any
type Json = any;

const TOKEN_PATH = '/oauth/v1/token';
const QR_PATH = '/api/eWallet/v4/qrcode';
const TX_PATH = '/api/eWallet/v1/transactions';

/** +221 77 123 45 67 → 771234567 (format MSISDN attendu par Orange). */
export function msisdn(e164: string): string {
  const d = e164.replace(/\D/g, '');
  return d.startsWith('221') && d.length === 12 ? d.slice(3) : d;
}

/** Corps de POST /api/eWallet/v4/qrcode (schéma MerchantBody). */
export function buildPaymentRequest(cfg: OrangeConfig, i: CheckoutInput): Json {
  const body: Json = {
    code: cfg.merchantCode,
    name: cfg.merchantName,
    amount: { unit: 'XOF', value: i.amount },
    validity: cfg.validite ?? 1800,
    reference: i.paymentId,
    callbackSuccessUrl: i.successUrl,
    callbackCancelUrl: i.errorUrl,
    metadata: { paymentId: i.paymentId, objet: i.description.slice(0, 100) },
    restrictions: { isSingleUse: true },
  };
  if (i.payerMobile) body.restrictions.payerMsisdn = msisdn(i.payerMobile);
  return body;
}

/** Réponse de génération du QR code (schéma Qr) → action pour la fenêtre de paiement. */
export function parsePaymentResponse(paymentId: string, r: Json, now = Date.now()): CheckoutResult {
  if (!r?.qrCode && !r?.deepLink && !r?.deepLinks) {
    throw new ProviderError('orange_money', 200, 'reponse_inattendue', JSON.stringify(r).slice(0, 300));
  }
  const qr = typeof r.qrCode === 'string' ? (r.qrCode.startsWith('data:') ? r.qrCode : `data:image/png;base64,${r.qrCode}`) : undefined;
  const deeplinks: Record<string, string> = { ...(r.deepLinks ?? {}) };
  if (!Object.keys(deeplinks).length && r.deepLink) deeplinks.MAXIT = r.deepLink;
  const validite = Number(r.validity);
  return {
    sessionId: paymentId,
    action: { type: 'qr', qr, deeplinks, url: r.shortLink ?? undefined },
    expiresAt: validite > 0 ? new Date(now + validite * 1000).toISOString() : undefined,
    raw: { qrId: r.qrId ?? null, validity: r.validity ?? null, shortLink: r.shortLink ?? null, deepLinks: deeplinks },
  };
}

const ECHECS = new Set(['FAILED', 'CANCELLED', 'REJECTED']);

/** Transactions trouvées pour notre référence (schéma Transaction[]) → état normalisé. */
export function parseTransactions(paymentId: string, list: Json): SessionState {
  const txs: Json[] = Array.isArray(list) ? list : (list?.content ?? list?.data ?? []);
  const mien = txs.filter((t) => !t?.reference || t.reference === paymentId);
  const ok = mien.find((t) => String(t?.status).toUpperCase() === 'SUCCESS');
  const recent = [...mien].sort((a, b) => String(b?.updatedAt ?? b?.createdAt ?? '').localeCompare(String(a?.updatedAt ?? a?.createdAt ?? '')))[0];
  const t = ok ?? recent;
  const s = String(t?.status ?? '').toUpperCase();
  const status: SessionState['status'] = s === 'SUCCESS' ? 'succeeded' : ECHECS.has(s) ? 'failed' : 'pending';
  return {
    sessionId: paymentId,
    clientReference: paymentId,
    amount: Number(t?.amount?.value ?? NaN),
    currency: t?.amount?.unit ?? 'XOF',
    status,
    // Un échec n'est pas définitif : le client peut retenter tant que le QR code est valide.
    // L'expiration est gérée par Neeg Loc (expires_at du paiement).
    final: status === 'succeeded',
    txId: t?.transactionId ?? null,
    error: status === 'failed' ? (t?.statusReason ?? s) : null,
    raw: t ?? null,
  };
}

/** Rappel Orange (schéma Notification) : notre référence, ou à défaut rien d'exploitable. */
export function sessionIdFromCallback(body: Json): string | null {
  return typeof body?.reference === 'string' && body.reference ? body.reference : null;
}

export function orangeProvider(cfg: OrangeConfig): Provider {
  const doFetch = cfg.fetchFn ?? fetch;
  let token: { value: string; until: number } | null = null;

  async function getToken(): Promise<string> {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const res = await doFetch(cfg.baseUrl + TOKEN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    });
    const data: Json = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) {
      throw new ProviderError('orange_money', res.status, 'jeton_refuse', data?.error_description ?? data?.error ?? JSON.stringify(data).slice(0, 300));
    }
    token = { value: data.access_token, until: Date.now() + (Number(data.expires_in) || 300) * 1000 };
    return token.value;
  }

  async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Json> {
    const res = await doFetch(cfg.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json', Accept: 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: Json = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* corps non JSON */ }
    if (!res.ok) {
      // Erreurs au format RFC 7807 : { type, title, status, code, detail, violations }
      const detail = [data?.detail ?? data?.title ?? text.slice(0, 200), ...(data?.violations ?? []).map((v: Json) => `${v.field}: ${v.message}`)].join(' · ');
      throw new ProviderError('orange_money', res.status, data?.code ? `om_${data.code}` : `http_${res.status}`, detail);
    }
    return data;
  }

  return {
    id: 'orange_money',
    async createCheckout(i) {
      if (!cfg.mappingValide) {
        throw new ProviderError('orange_money', 501, 'orange_non_configure',
          'Orange Money pas encore validé en sandbox (ORANGE_MAPPING_VALIDE).');
      }
      const r = await call('POST', QR_PATH, buildPaymentRequest(cfg, i), { 'X-Callback-Url': cfg.callbackUrl });
      return parsePaymentResponse(i.paymentId, r);
    },
    async getSession(paymentId) {
      const q = new URLSearchParams({ reference: paymentId, page: '0', size: '20' });
      return parseTransactions(paymentId, await call('GET', `${TX_PATH}?${q}`));
    },
  };
}

