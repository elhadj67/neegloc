// Numéros sénégalais au format international E.164 (+221XXXXXXXXX), exigé par Wave.

export function toE164(tel: string): string {
  const d = String(tel ?? '').replace(/\D/g, '');
  if (d.length === 9) return '+221' + d;
  if (d.length === 12 && d.startsWith('221')) return '+' + d;
  if (d.length === 14 && d.startsWith('00221')) return '+' + d.slice(2);
  throw new Error('numero_invalide');
}
