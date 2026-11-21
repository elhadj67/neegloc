// POST /webhook-orange?token=<ORANGE_CALLBACK_TOKEN> — rappel Orange Money (schéma « Notification »).
// L'URL, jeton compris, est transmise à Orange dans l'en-tête X-Callback-Url de chaque QR code.
// On n'encaisse JAMAIS sur la foi du rappel : le statut est relu auprès de l'API Orange
// (trustPayload: false) avant toute écriture. Orange peut livrer un rappel plusieurs fois :
// on déduplique sur X-Sonatel-Idempotency-Key.
// Déployer avec --no-verify-jwt.

import { env } from '../_shared/http.ts';
import { safeEqual } from '../_shared/crypto.ts';
import { sessionIdFromCallback } from '../_shared/providers/orange.ts';
import { processEvent } from '../_shared/webhook.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('méthode non autorisée', { status: 405 });
  const token = new URL(req.url).searchParams.get('token') ?? req.headers.get('X-Callback-Token') ?? '';
  if (!safeEqual(token, env('ORANGE_CALLBACK_TOKEN'))) return new Response('jeton invalide', { status: 401 });

  const raw = await req.text();
  let body;
  try { body = JSON.parse(raw); } catch { return new Response('JSON invalide', { status: 400 }); }
  const sessionId = sessionIdFromCallback(body);
  if (!sessionId) return new Response('rappel sans identifiant', { status: 400 });

  const status = String(body?.status ?? 'inconnu');
  const cle = req.headers.get('X-Sonatel-Idempotency-Key') || `${body?.transactionId ?? sessionId}:${status}`;
  return processEvent({
    provider: 'orange_money',
    eventId: cle,
    type: `callback.${status}`,
    payload: body,
    state: { sessionId, clientReference: sessionId, amount: NaN, currency: 'XOF', status: 'pending', final: false, raw: body },
    trustPayload: false,
  });
});
