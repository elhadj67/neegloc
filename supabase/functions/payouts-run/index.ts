// POST /payouts-run { payout_id? } — un gestionnaire déclenche les versements en attente
// (tous, ou un seul). Les versements Orange Money se font à la main puis se marquent
// avec la fonction SQL marquer_payout.

import { adminClient, isAdmin, requireUser } from '../_shared/db.ts';
import { handler, HttpError, json } from '../_shared/http.ts';
import { runPayouts } from '../_shared/payouts.ts';

Deno.serve(handler(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'methode_non_autorisee');
  const db = adminClient();
  const user = await requireUser(req, db);
  if (!(await isAdmin(db, user.id))) throw new HttpError(403, 'acces_refuse');
  const { payout_id } = await req.json().catch(() => ({}));
  return json({ versements: await runPayouts(db, payout_id || undefined) });
}));
