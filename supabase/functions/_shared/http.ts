// Utilitaires HTTP communs aux fonctions serveur.

export const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

export const flag = (name: string) => (Deno.env.get(name) ?? '').toLowerCase() === 'true';

/** Enveloppe une fonction : CORS, erreurs métier en JSON, erreurs inattendues journalisées. */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
      console.error(e);
      return json({ error: 'erreur_interne' }, 500);
    }
  };
}

/** Code d'erreur métier levé par une fonction SQL (« raise exception 'xxx' »). */
export function sqlCode(err: { message?: string } | null | undefined, fallback = 'erreur'): string {
  const m = (err?.message ?? '').match(/^[a-z_]+$/m);
  return m ? m[0] : fallback;
}
