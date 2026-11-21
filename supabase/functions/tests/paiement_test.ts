// Tests unitaires : deno test supabase/functions/tests/
// Les signatures de référence ont été calculées indépendamment en Python (hmac / hashlib).

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { parseWaveSignature, verifyWaveSignature, waveSignatureHeader } from '../_shared/crypto.ts';
import { mapWaveSession, parseWaveEvent, waveProvider } from '../_shared/providers/wave.ts';
import { ProviderError } from '../_shared/providers/types.ts';
import { toE164 } from '../_shared/tel.ts';
import { settle } from '../_shared/settle.ts';

const SECRET = 'wave_sn_WHS_test_secret';
const T = 1763740800;
const BODY = '{"id":"AE_test1","type":"checkout.session.completed","data":{"id":"cos-abc","amount":"75000","currency":"XOF","client_reference":"0b6f6a2e-1c1d-4a57-9d3e-2f1a5c9b7e10","checkout_status":"complete","payment_status":"succeeded","transaction_id":"TCN4Y4ZC3FM"}}';
const SIG = '10723af7829ab8c2495e5b93c7c6c4000f6ff3c71755f89084b2b866ebd77150';
const NOW = T * 1000 + 10_000;

Deno.test('signature Wave : vecteur de référence accepté', async () => {
  assert(await verifyWaveSignature(`t=${T},v1=${SIG}`, BODY, SECRET, 300, NOW));
});

Deno.test('signature Wave : plusieurs v1 (rotation de secret)', async () => {
  assert(await verifyWaveSignature(`t=${T},v1=${'0'.repeat(64)},v1=${SIG}`, BODY, SECRET, 300, NOW));
});

Deno.test('signature Wave : corps modifié, secret faux, horodatage trop ancien → refus', async () => {
  assertEquals(await verifyWaveSignature(`t=${T},v1=${SIG}`, BODY.replace('75000', '7500'), SECRET, 300, NOW), false);
  assertEquals(await verifyWaveSignature(`t=${T},v1=${SIG}`, BODY, 'autre', 300, NOW), false);
  assertEquals(await verifyWaveSignature(`t=${T},v1=${SIG}`, BODY, SECRET, 300, T * 1000 + 301_000), false);
  assertEquals(await verifyWaveSignature(null, BODY, SECRET, 300, NOW), false);
  assertEquals(await verifyWaveSignature(`v1=${SIG}`, BODY, SECRET, 300, NOW), false);
});

Deno.test('signature Wave : requête GET sans corps (horodatage seul)', async () => {
  assertEquals(await waveSignatureHeader(SECRET, '', T * 1000), `t=${T},v1=2814ff48ec5e556f93268b40901449972bc30147c962bf5ffaa9d204f18d03e8`);
  assertEquals(parseWaveSignature('t=1, v1=AB ,x=2').v1, ['ab']);
});

Deno.test('numéros sénégalais en E.164', () => {
  assertEquals(toE164('77 412 58 90'), '+221774125890');
  assertEquals(toE164('+221 77 412 58 90'), '+221774125890');
  assertEquals(toE164('00221774125890'), '+221774125890');
});

Deno.test('session Wave → état normalisé', () => {
  assertEquals(mapWaveSession({ id: 'c', amount: '100', currency: 'XOF', checkout_status: 'complete', payment_status: 'succeeded' }).status, 'succeeded');
  assertEquals(mapWaveSession({ id: 'c', amount: '100', currency: 'XOF', checkout_status: 'open', payment_status: 'processing' }).status, 'pending');
  assertEquals(mapWaveSession({ id: 'c', amount: '100', currency: 'XOF', checkout_status: 'expired', payment_status: 'processing' }).status, 'expired');
  const f = parseWaveEvent({ type: 'checkout.session.payment_failed', data: { id: 'c', amount: '100', currency: 'XOF', checkout_status: 'open', payment_status: 'cancelled', last_payment_error: { code: 'insufficient-funds' } } });
  assertEquals([f?.status, f?.final, f?.error], ['failed', false, 'insufficient-funds']);
  assertEquals(parseWaveEvent({ type: 'merchant.payment_received', data: {} }), null);
});

Deno.test('adaptateur Wave : création de session, versement idempotent, erreurs', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/checkout/sessions')) {
      return new Response(JSON.stringify({ id: 'cos-1', wave_launch_url: 'https://pay.wave.com/c/cos-1', when_expires: '2026-11-21T10:30:00Z' }), { status: 200 });
    }
    if (url.endsWith('/v1/payout')) {
      return new Response(JSON.stringify({ id: 'pt-1', status: 'succeeded', receive_amount: '500' }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 'checkout-session-not-found', message: 'introuvable' }), { status: 404 });
  }) as typeof fetch;
  const w = waveProvider({ apiKey: 'wave_sn_prod_x', signingSecret: 'wave_sn_AKS_y', fetchFn: fakeFetch });

  const r = await w.createCheckout({ paymentId: 'p1', amount: 75000, currency: 'XOF', successUrl: 'https://a/s', errorUrl: 'https://a/e', description: 'x' });
  assertEquals(r.action, { type: 'redirect', url: 'https://pay.wave.com/c/cos-1' });
  const sent = JSON.parse(String(calls[0].init.body));
  assertEquals(sent, { amount: '75000', currency: 'XOF', success_url: 'https://a/s', error_url: 'https://a/e', client_reference: 'p1' });
  const h = calls[0].init.headers as Record<string, string>;
  assertEquals(h.Authorization, 'Bearer wave_sn_prod_x');
  assert(/^t=\d+,v1=[0-9a-f]{64}$/.test(h['Wave-Signature']));

  const po = await w.payout!({ payoutId: 'po1', idempotencyKey: 'k-1', amount: 500, mobile: '+221770000000', name: 'Fatou' });
  assertEquals(po.status, 'succeeded');
  assertEquals((calls[1].init.headers as Record<string, string>)['Idempotency-Key'], 'k-1');

  await assertRejects(() => w.getSession('cos-x'), ProviderError);
  await w.expireSession!('cos-x');   // 404 ignoré : session déjà terminée
});

// Faux client Supabase : juste assez pour settle()
function fakeDb(payment: Record<string, unknown> | null) {
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = {
    rpcs,
    from() {
      const q = {
        _f: {} as Record<string, unknown>,
        select() { return q; },
        eq(k: string, v: unknown) { q._f[k] = v; return q; },
        maybeSingle() {
          const p = payment;
          const ok = p && Object.entries(q._f).every(([k, v]) => k === 'session_id' ? p.session_id === v : k === 'id' ? p.id === v : p[k] === v);
          return Promise.resolve({ data: ok ? p : null, error: null });
        },
      };
      return q;
    },
    rpc(fn: string, args: Record<string, unknown>) { rpcs.push({ fn, args }); return Promise.resolve({ data: 'ok', error: null }); },
  };
  return db;
}

Deno.test('encaissement : succès, devise inattendue, échec définitif, paiement inconnu', async () => {
  const pay = { id: '0b6f6a2e-1c1d-4a57-9d3e-2f1a5c9b7e10', provider: 'wave', session_id: 'cos-abc', currency: 'XOF', amount: 75000 };
  const base = { sessionId: 'cos-abc', amount: 75000, currency: 'XOF', raw: {} };

  let db = fakeDb(pay);
  // deno-lint-ignore no-explicit-any
  assertEquals(await settle(db as any, 'wave', { ...base, status: 'succeeded', final: true, txId: 'T1' }), 'ok');
  assertEquals(db.rpcs[0], { fn: 'appliquer_paiement', args: { p_payment: pay.id, p_tx: 'T1', p_montant: 75000 } });

  db = fakeDb(pay);
  // deno-lint-ignore no-explicit-any
  assertEquals(await settle(db as any, 'wave', { ...base, currency: 'EUR', status: 'succeeded', final: true }), 'devise_incorrecte');

  db = fakeDb(pay);
  // deno-lint-ignore no-explicit-any
  assertEquals(await settle(db as any, 'wave', { ...base, status: 'expired', final: true }), 'echec');
  assertEquals(db.rpcs[0].args.p_statut, 'expire');

  db = fakeDb(null);
  // deno-lint-ignore no-explicit-any
  assertEquals(await settle(db as any, 'wave', { ...base, status: 'succeeded', final: true }), 'paiement_inconnu');
  assertEquals(db.rpcs.length, 0);
});
