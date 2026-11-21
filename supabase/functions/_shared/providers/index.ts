import { env, flag } from '../http.ts';
import type { Db } from '../db.ts';
import type { Provider, ProviderId } from './types.ts';
import { waveProvider } from './wave.ts';
import { orangeProvider } from './orange.ts';
import { simulateurProvider } from './simulateur.ts';
import { transfertProvider } from './transfert.ts';

/** Moyens de paiement proposés aux clients, d'après MOYENS_ACTIFS (ex. « wave,orange_money »). */
export function moyensActifs(): ProviderId[] {
  const list = (Deno.env.get('MOYENS_ACTIFS') ?? 'wave').split(',').map((s) => s.trim()).filter(Boolean) as ProviderId[];
  return list.filter((p) => p !== 'simulateur' || flag('SIMULATEUR_ACTIF'));
}

export function getProvider(id: ProviderId, db: Db): Provider {
  switch (id) {
    case 'wave':
      return waveProvider({
        apiKey: env('WAVE_API_KEY'),
        signingSecret: Deno.env.get('WAVE_SIGNING_SECRET') || null,
        baseUrl: Deno.env.get('WAVE_API_BASE') || undefined,
      });
    case 'orange_money':
      return orangeProvider({
        baseUrl: env('ORANGE_BASE_URL'),
        tokenPath: Deno.env.get('ORANGE_TOKEN_PATH') ?? '/oauth/token',
        paymentPath: env('ORANGE_PAYMENT_PATH'),
        statusPath: env('ORANGE_STATUS_PATH'),
        clientId: env('ORANGE_CLIENT_ID'),
        clientSecret: env('ORANGE_CLIENT_SECRET'),
        merchantCode: env('ORANGE_MERCHANT_CODE'),
        merchantName: Deno.env.get('ORANGE_MERCHANT_NAME') ?? 'Neeg Loc',
        mappingValide: flag('ORANGE_MAPPING_VALIDE'),
      });
    case 'simulateur':
      if (!flag('SIMULATEUR_ACTIF')) throw new Error('simulateur_inactif');
      return simulateurProvider(db, env('APP_URL'));
    case 'transfert_wave':
    case 'transfert_om':
      return transfertProvider(id, db);
  }
}
