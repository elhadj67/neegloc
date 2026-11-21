// POST /webhook-wave — notifications Wave (à déclarer dans le Business Portal, Développeur > Webhooks).
// Événements à cocher : checkout.session.completed, checkout.session.payment_failed.
// Déployer avec --no-verify-jwt : l'authentification se fait par la signature Wave.

import { env } from '../_shared/http.ts';
import { safeEqual, verifyWaveSignature } from '../_shared/crypto.ts';
import { parseWaveEvent } from '../_shared/providers/wave.ts';
import { processEvent } from '../_shared/webhook.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('méthode non autorisée', { status: 405 });
  const raw = await req.text();                       // corps brut : la signature porte sur les octets exacts
  const secret = env('WAVE_WEBHOOK_SECRET');
  const mode = Deno.env.get('WAVE_WEBHOOK_MODE') ?? 'signing';
  const ok = mode === 'shared'
    ? safeEqual((req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''), secret)
    : await verifyWaveSignature(req.headers.get('Wave-Signature'), raw, secret);
  if (!ok) return new Response('signature invalide', { status: 401 });

  let evt;
  try { evt = JSON.parse(raw); } catch { return new Response('JSON invalide', { status: 400 }); }
  if (!evt?.id) return new Response('événement sans identifiant', { status: 400 });

  return processEvent({ provider: 'wave', eventId: evt.id, type: evt.type, payload: evt, state: parseWaveEvent(evt), trustPayload: true });
});
