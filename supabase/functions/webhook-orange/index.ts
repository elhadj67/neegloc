// POST /webhook-orange?token=<ORANGE_CALLBACK_TOKEN> — rappel Orange Money.
// Le format et l'authentification du rappel Sonatel ne sont pas publics : on exige un jeton secret
// dans l'URL déclarée chez Orange, et on n'encaisse JAMAIS sur la foi du rappel. Le statut est
// relu auprès de l'API Orange (trustPayload: false) avant toute écriture.
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
  return processEvent({
    provider: 'orange_money',
    eventId: `${sessionId}:${status}`,
    type: `callback.${status}`,
    payload: body,
    state: { sessionId, clientReference: body?.reference ?? null, amount: NaN, currency: 'XOF', status: 'pending', final: false, raw: body },
    trustPayload: false,
  });
});
