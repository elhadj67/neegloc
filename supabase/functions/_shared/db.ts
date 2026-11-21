import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { env, HttpError } from './http.ts';

export type Db = SupabaseClient;

/** Client « service » : contourne les règles d'accès. À n'utiliser que côté serveur. */
export function adminClient(): Db {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
}

export async function requireUser(req: Request, db: Db) {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new HttpError(401, 'non_authentifie');
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, 'non_authentifie');
  return data.user;
}

export async function isAdmin(db: Db, userId: string): Promise<boolean> {
  const { data } = await db.from('profiles').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'admin';
}

export const functionsBase = () => `${env('SUPABASE_URL')}/functions/v1`;
