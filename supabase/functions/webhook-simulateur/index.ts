// POST /webhook-simulateur — reçoit les notifications signées du simulateur, au format exact de Wave.
// Sert à tester la vérification de signature et l'encaissement sans compte marchand.
// Déployer avec --no-verify-jwt.

import { env, flag } from '../_shared/http.ts';
import { verifyWaveSignature } from '../_shared/crypto.ts';
import { parseWaveEvent } from '../_shared/providers/wave.ts';
import { processEvent } from '../_shared/webhook.ts';

Deno.serve(async (req) => {
  if (!flag('SIMULATEUR_ACTIF')) return new Response('simulateur inactif', { status: 404 });
  if (req.method !== 'POST') return new Response('méthode non autorisée', { status: 405 });
  const raw = await req.text();
  if (!(await verifyWaveSignature(req.headers.get('Wave-Signature'), raw, env('SIMULATEUR_WEBHOOK_SECRET')))) {
    return new Response('signature invalide', { status: 401 });
  }
  const evt = JSON.parse(raw);
  return processEvent({ provider: 'simulateur', eventId: evt.id, type: evt.type, payload: evt, state: parseWaveEvent(evt), trustPayload: true });
});
