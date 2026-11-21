// Adaptateur Orange Money Sénégal (Sonatel) : À COMPLÉTER avec la documentation technique Sonatel.
//
// Ce qui est confirmé publiquement (developer.orange-sonatel.com, developer.orange.com, 21/11/2026) :
//  - l'offre « OM Merchant Payment » permet de payer par QR code ou par lien profond Max It ;
//  - une offre « Notification » permet de déclarer une URL de rappel (callback) ;
//  - un environnement de test gratuit existe ; la mise en production demande RCCM, NINEA, CNI.
// Ce qui N'EST PAS public : adresses de l'API, point d'obtention du jeton, noms des champs,
// valeurs de statut, format et authentification du rappel. Ils sont dans la documentation
// remise après création d'un compte développeur Sonatel.
//
// Le code ci-dessous fixe la mécanique (jeton OAuth2 client_credentials mis en cache, appels HTTP,
// vérification du statut auprès d'Orange avant tout encaissement). Les trois fonctions de
// correspondance (buildPaymentRequest, parsePaymentResponse, parseStatusResponse) suivent des
// hypothèses à vérifier : tant que ORANGE_MAPPING_VALIDE n'est pas à « true », l'adaptateur
// refuse de créer des paiements réels.

import { type CheckoutInput, type CheckoutResult, type Provider, ProviderError, type SessionState } from './types.ts';

export interface OrangeConfig {
  baseUrl: string;            // ORANGE_BASE_URL (sandbox puis production)
  tokenPath: string;          // ORANGE_TOKEN_PATH
  paymentPath: string;        // ORANGE_PAYMENT_PATH (création du paiement / QR code)
  statusPath: string;         // ORANGE_STATUS_PATH, contient « {id} »
  clientId: string;
  clientSecret: string;
  merchantCode: string;       // code marchand Orange Money
  merchantName: string;
  mappingValide: boolean;
  fetchFn?: typeof fetch;
}

// deno-lint-ignore no-explicit-any
type Json = any;

// ---------- Correspondances à valider avec la documentation Sonatel ----------

/** HYPOTHÈSE : forme de la requête de paiement marchand par QR code / Max It. */
export function buildPaymentRequest(cfg: OrangeConfig, i: CheckoutInput): Json {
  return {
    amount: { unit: i.currency, value: i.amount },
    code: cfg.merchantCode,
    name: cfg.merchantName,
    reference: i.paymentId,
    callbackSuccessUrl: i.successUrl,
    callbackCancelUrl: i.errorUrl,
    validity: 1800,
    metadata: { paymentId: i.paymentId },
  };
}

/** HYPOTHÈSE : la réponse contient un identifiant, un QR code en base64 et des liens profonds. */
export function parsePaymentResponse(r: Json): CheckoutResult {
  const id = r?.qrId ?? r?.transactionId ?? r?.id;
  if (!id) throw new ProviderError('orange_money', 200, 'reponse_inattendue', JSON.stringify(r).slice(0, 300));
  const qr = typeof r.qrCode === 'string' ? (r.qrCode.startsWith('data:') ? r.qrCode : `data:image/png;base64,${r.qrCode}`) : undefined;
  return {
    sessionId: String(id),
    action: { type: 'qr', qr, deeplinks: r.deepLinks ?? undefined, url: r.paymentUrl ?? undefined },
    expiresAt: r.validityEnd ?? undefined,
    raw: r,
  };
}

/** HYPOTHÈSE : statuts SUCCESS / FAILED / CANCELLED / EXPIRED / PENDING / INITIATED. */
export function parseStatusResponse(sessionId: string, r: Json): SessionState {
  const s = String(r?.status ?? '').toUpperCase();
  const status: SessionState['status'] = s === 'SUCCESS' ? 'succeeded'
    : s === 'EXPIRED' ? 'expired'
    : (s === 'FAILED' || s === 'CANCELLED' || s === 'REJECTED') ? 'failed'
    : 'pending';
  return {
    sessionId,
    clientReference: r?.reference ?? r?.metadata?.paymentId ?? null,
    amount: Number(r?.amount?.value ?? r?.amount),
    currency: r?.amount?.unit ?? 'XOF',
    status,
    final: status !== 'pending',
    txId: r?.transactionId ?? null,
    error: status === 'failed' ? s : null,
    raw: r,
  };
}

/** Extrait l'identifiant de session d'un rappel Orange. On ne fait jamais confiance au statut du rappel. */
export function sessionIdFromCallback(body: Json): string | null {
  const id = body?.qrId ?? body?.transactionId ?? body?.id ?? body?.reference;
  return id ? String(id) : null;
}

// ---------- Mécanique ----------

export function orangeProvider(cfg: OrangeConfig): Provider {
  const doFetch = cfg.fetchFn ?? fetch;
  let token: { value: string; until: number } | null = null;

  async function getToken(): Promise<string> {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const res = await doFetch(cfg.baseUrl + cfg.tokenPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    });
    const data: Json = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) throw new ProviderError('orange_money', res.status, 'jeton_refuse', JSON.stringify(data).slice(0, 300));
    token = { value: data.access_token, until: Date.now() + (Number(data.expires_in) || 300) * 1000 };
    return token.value;
  }

  async function call(method: string, path: string, body?: unknown): Promise<Json> {
    const res = await doFetch(cfg.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: Json = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* corps non JSON */ }
    if (!res.ok) throw new ProviderError('orange_money', res.status, data?.code ?? `http_${res.status}`, data?.message ?? text.slice(0, 300));
    return data;
  }

  return {
    id: 'orange_money',
    async createCheckout(i) {
      if (!cfg.mappingValide) {
        throw new ProviderError('orange_money', 501, 'orange_non_configure',
          'Correspondance des champs Orange Money à valider avec la documentation Sonatel (ORANGE_MAPPING_VALIDE).');
      }
      return parsePaymentResponse(await call('POST', cfg.paymentPath, buildPaymentRequest(cfg, i)));
    },
    async getSession(id) {
      return parseStatusResponse(id, await call('GET', cfg.statusPath.replace('{id}', encodeURIComponent(id))));
    },
    // Pas de remboursement ni de versement automatiques tant que l'offre « Cash In » n'est pas documentée :
    // le gestionnaire les fait à la main et les marque comme effectués (fonction marquer_payout).
  };
}
