// Signatures HMAC-SHA256 au format Wave : en-tête « Wave-Signature: t=<secondes>,v1=<hex>[,v1=<hex>] ».
// Chaîne signée = horodatage + corps brut, sans séparateur (docs.wave.com/webhook).

const enc = new TextEncoder();

export async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparaison en temps constant (évite de révéler la signature attendue par le temps de réponse). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function parseWaveSignature(header: string): { t: string | null; v1: string[] } {
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1' && v) v1.push(v.toLowerCase());
  }
  return { t, v1 };
}

/**
 * Vérifie une signature Wave. Plusieurs v1 sont possibles pendant une rotation de secret.
 * Rejette les messages de plus de 5 minutes (recommandation Wave) et ceux datés de plus de 5 minutes dans le futur.
 */
export async function verifyWaveSignature(
  header: string | null, rawBody: string, secret: string, toleranceSec = 300, nowMs = Date.now(),
): Promise<boolean> {
  if (!header || !secret) return false;
  const { t, v1 } = parseWaveSignature(header);
  if (!t || !/^\d+$/.test(t) || v1.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;
  const expected = await hmacHex(secret, t + rawBody);
  return v1.some((s) => safeEqual(s, expected));
}

export async function waveSignatureHeader(secret: string, rawBody: string, nowMs = Date.now()): Promise<string> {
  const t = String(Math.floor(nowMs / 1000));
  return `t=${t},v1=${await hmacHex(secret, t + rawBody)}`;
}
