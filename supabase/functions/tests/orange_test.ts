// Tests unitaires de l'adaptateur Orange Money : deno test supabase/functions/tests/
// Les réponses simulées suivent les schémas de la spécification « Orange Money API » v1.1.0.

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  buildPaymentRequest, msisdn, type OrangeConfig, orangeProvider, parsePaymentResponse, parseTransactions, sessionIdFromCallback,
} from '../_shared/providers/orange.ts';
import { ProviderError } from '../_shared/providers/types.ts';

const PAY = '0b6f6a2e-1c1d-4a57-9d3e-2f1a5c9b7e10';
const CFG: OrangeConfig = {
  baseUrl: 'https://api.sandbox.orange-sonatel.com', clientId: 'id', clientSecret: 'secret',
  merchantCode: '123456', merchantName: 'Neeg Loc', callbackUrl: 'https://x.supabase.co/functions/v1/webhook-orange?token=t0k',
  mappingValide: true,
};
const INPUT = { paymentId: PAY, amount: 37500, currency: 'XOF' as const, successUrl: 'https://site/retour.html?p=1', errorUrl: 'https://site/retour.html?p=1&e=1', description: 'Acompte · NL-ABC123' };

Deno.test('Orange : numéro E.164 → MSISDN', () => {
  assertEquals(msisdn('+221771234567'), '771234567');
  assertEquals(msisdn('771234567'), '771234567');
});

Deno.test('Orange : corps de la demande de QR code (MerchantBody)', () => {
  const b = buildPaymentRequest(CFG, INPUT);
  assertEquals(b.code, '123456');
  assertEquals(b.amount, { unit: 'XOF', value: 37500 });
  assertEquals(b.reference, PAY);
  assertEquals(b.validity, 1800);
  assertEquals(b.restrictions, { isSingleUse: true });
  assert(Object.keys(b.metadata).length <= 10);
  assertEquals(buildPaymentRequest(CFG, { ...INPUT, payerMobile: '+221771234567' }).restrictions.payerMsisdn, '771234567');
});

Deno.test('Orange : réponse QR → action « qr » avec liens et expiration', () => {
  const r = parsePaymentResponse(PAY, {
    qrCode: 'iVBORw0KGgo=', validity: 1800, qrId: 'qr-1', shortLink: 'https://om.sn/abc',
    deepLinks: { MAXIT: 'https://sugu.orange-sonatel.com/mp/1', OM: 'https://sugu.orange-sonatel.com/mp/1' },
  }, 1_000_000);
  assertEquals(r.sessionId, PAY);
  assertEquals(r.action, { type: 'qr', qr: 'data:image/png;base64,iVBORw0KGgo=', deeplinks: { MAXIT: 'https://sugu.orange-sonatel.com/mp/1', OM: 'https://sugu.orange-sonatel.com/mp/1' }, url: 'https://om.sn/abc' });
  assertEquals(r.expiresAt, new Date(1_000_000 + 1_800_000).toISOString());
  // Réponse réelle de la sandbox (21/11/2026) : shortLink vide, deepLink et deepLinks identiques
  const sb = parsePaymentResponse(PAY, { deepLink: 'https://sugu.orange-sonatel.com/mp/x', deepLinks: { OM: 'https://sugu.orange-sonatel.com/mp/x', MAXIT: 'https://sugu.orange-sonatel.com/mp/x' }, qrCode: 'AAA', validity: 1800, shortLink: '', qrId: 'x', validFor: { startDateTime: '2026-11-21T20:06:41', endDateTime: '2026-11-21T20:36:41' } });
  assertEquals((sb.action as { url?: string }).url, undefined);
  // Ancienne forme : un seul lien profond
  const r2 = parsePaymentResponse(PAY, { deepLink: 'https://sugu.orange-sonatel.com/mp/2' });
  assertEquals((r2.action as { deeplinks: Record<string, string> }).deeplinks, { MAXIT: 'https://sugu.orange-sonatel.com/mp/2' });
  let err: unknown; try { parsePaymentResponse(PAY, {}); } catch (e) { err = e; }
  assert(err instanceof ProviderError && err.code === 'reponse_inattendue');
});

Deno.test('Orange : transactions trouvées par référence → état normalisé', () => {
  const tx = (status: string, id: string, at: string, value = 37500) => ({ status, transactionId: id, reference: PAY, amount: { value, unit: 'XOF' }, updatedAt: at, type: 'MERCHANT_PAYMENT' });
  // Aucune transaction : le client n'a pas encore payé
  const vide = parseTransactions(PAY, []);
  assertEquals([vide.status, vide.final, vide.txId], ['pending', false, null]);
  // Échec puis succès : le succès l'emporte
  const s = parseTransactions(PAY, [tx('FAILED', 'MP1', '2026-11-21T10:00:00Z'), tx('SUCCESS', 'MP2', '2026-11-21T09:00:00Z')]);
  assertEquals([s.status, s.final, s.txId, s.amount, s.currency, s.clientReference], ['succeeded', true, 'MP2', 37500, 'XOF', PAY]);
  // Échec seul : non définitif (le client peut réessayer)
  const f = parseTransactions(PAY, [{ ...tx('REJECTED', 'MP3', '2026-11-21T10:00:00Z'), statusReason: 'solde insuffisant' }]);
  assertEquals([f.status, f.final, f.error], ['failed', false, 'solde insuffisant']);
  // En cours
  assertEquals(parseTransactions(PAY, [tx('PENDING', 'MP4', '2026-11-21T10:00:00Z')]).status, 'pending');
  // Une transaction d'une autre référence est ignorée
  assertEquals(parseTransactions(PAY, [{ ...tx('SUCCESS', 'MP5', '2026-11-21T10:00:00Z'), reference: 'autre' }]).status, 'pending');
  // Réponse paginée
  assertEquals(parseTransactions(PAY, { content: [tx('SUCCESS', 'MP6', '2026-11-21T10:00:00Z')] }).txId, 'MP6');
});

Deno.test('Orange : rappel → notre référence uniquement', () => {
  assertEquals(sessionIdFromCallback({ status: 'SUCCESS', transactionId: 'MP7', reference: PAY }), PAY);
  assertEquals(sessionIdFromCallback({ status: 'SUCCESS', transactionId: 'MP7' }), null);
});

Deno.test('Orange : appels HTTP (jeton mis en cache, en-tête de rappel, recherche, erreurs RFC 7807)', async () => {
  const appels: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit = {}) => {
    appels.push({ url, init });
    const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } }));
    if (url.endsWith('/oauth/v1/token')) return json({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
    if (url.endsWith('/api/eWallet/v4/qrcode')) return json({ qrCode: 'AAA', validity: 1800, deepLinks: { MAXIT: 'https://m/1' } });
    if (url.includes('/api/eWallet/v1/transactions?')) return json([{ status: 'SUCCESS', transactionId: 'MP9', reference: PAY, amount: { value: 37500, unit: 'XOF' } }]);
    return json({ type: 'x', title: 'Bad Request', status: '400', code: '2000', detail: 'Customer account does not exist', violations: [{ field: 'amount.value', message: 'must be >= 1' }] }, 400);
  }) as typeof fetch;

  const p = orangeProvider({ ...CFG, fetchFn });
  const c = await p.createCheckout(INPUT);
  assertEquals(c.sessionId, PAY);
  const qr = appels.find((a) => a.url.endsWith('/qrcode'))!;
  assertEquals((qr.init.headers as Record<string, string>)['X-Callback-Url'], CFG.callbackUrl);
  assertEquals((qr.init.headers as Record<string, string>).Authorization, 'Bearer tok');
  const s = await p.getSession(PAY);
  assertEquals([s.status, s.txId], ['succeeded', 'MP9']);
  assert(appels.some((a) => a.url.includes(`reference=${PAY}`)));
  assertEquals(appels.filter((a) => a.url.endsWith('/oauth/v1/token')).length, 1, 'jeton réutilisé');

  const bad = orangeProvider({ ...CFG, baseUrl: 'https://autre', fetchFn: ((url: string, init?: RequestInit) => url.endsWith('/oauth/v1/token') ? fetchFn(url, init) : fetchFn('https://x/erreur', init)) as typeof fetch });
  const e = await assertRejects(() => bad.createCheckout(INPUT), ProviderError);
  assertEquals((e as ProviderError).code, 'om_2000');
  assert(String((e as ProviderError).message).includes('amount.value'));

  const off = orangeProvider({ ...CFG, mappingValide: false, fetchFn });
  const e2 = await assertRejects(() => off.createCheckout(INPUT), ProviderError);
  assertEquals((e2 as ProviderError).code, 'orange_non_configure');
});
