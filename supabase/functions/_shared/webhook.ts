// Traitement commun des notifications d'opérateur, une fois la signature vérifiée :
// idempotence (chaque événement n'est traité qu'une fois), contre-vérification auprès de l'API
// de l'opérateur, puis encaissement. Une erreur renvoie 500 pour que l'opérateur réessaie.

import { adminClient, type Db } from './db.ts';
import { getProvider } from './providers/index.ts';
import type { ProviderId, SessionState } from './providers/types.ts';
import { settle } from './settle.ts';

// deno-lint-ignore no-explicit-any
type Json = any;

export interface EventInput {
  provider: ProviderId;
  eventId: string;
  type: string;
  payload: Json;
  state: SessionState | null;       // null : événement sans rapport avec un paiement en ligne
  trustPayload: boolean;            // false : on n'encaisse qu'après lecture du statut chez l'opérateur
}

export async function processEvent(e: EventInput, db: Db = adminClient()): Promise<Response> {
  const id = `${e.provider}:${e.eventId}`;
  const ins = await db.from('payment_events').insert({ id, provider: e.provider, type: e.type, payload: e.payload });
  if (ins.error) {
    if (ins.error.code !== '23505') throw ins.error;
    const prev = await db.from('payment_events').select('traite').eq('id', id).maybeSingle();
    if (prev.data?.traite) return new Response('ok (doublon)', { status: 200 });
  }
  if (!e.state) {
    await db.from('payment_events').update({ traite: true }).eq('id', id);
    return new Response('ignoré', { status: 200 });
  }
  try {
    let state = e.state;
    try {
      const live = await getProvider(e.provider, db).getSession(e.state.sessionId);
      state = { ...live, clientReference: live.clientReference ?? e.state.clientReference };
    } catch (err) {
      if (!e.trustPayload) throw err;
      console.warn(`Contre-vérification ${e.provider} impossible, on s'appuie sur l'événement signé`, err);
    }
    const result = await settle(db, e.provider, state);
    await db.from('payment_events').update({ traite: true, erreur: null }).eq('id', id);
    return new Response(JSON.stringify({ result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error(err);
    await db.from('payment_events').update({ erreur: String(err).slice(0, 500) }).eq('id', id);
    return new Response('erreur, réessayez', { status: 500 });
  }
}
