// Interface commune aux opérateurs de paiement (Wave, Orange Money, simulateur).
// Ajouter un opérateur = écrire un adaptateur qui respecte cette interface.

export type ProviderId = 'wave' | 'orange_money' | 'simulateur' | 'transfert_wave' | 'transfert_om';

/** Ce que le navigateur doit faire pour que le client paie. */
export type CheckoutAction =
  | { type: 'redirect'; url: string }
  | { type: 'qr'; qr?: string; deeplinks?: Record<string, string>; url?: string }
  | { type: 'transfert'; operateur: string; numero: string; nom: string; montant: number; reference: string };

export interface CheckoutInput {
  paymentId: string;     // sert de référence client chez l'opérateur
  amount: number;        // XOF, entier
  currency: 'XOF';
  successUrl: string;
  errorUrl: string;
  payerMobile?: string;  // E.164, facultatif
  description: string;
}

export interface CheckoutResult {
  sessionId: string;
  action: CheckoutAction;
  expiresAt?: string;
  raw: unknown;
}

export type SessionStatus = 'pending' | 'succeeded' | 'failed' | 'expired';

/** État normalisé d'une session de paiement, quel que soit l'opérateur. */
export interface SessionState {
  sessionId: string;
  clientReference?: string | null;
  amount: number;
  currency: string;
  status: SessionStatus;
  final: boolean;        // plus aucun paiement possible sur cette session
  txId?: string | null;
  error?: string | null;
  raw: unknown;
}

export interface PayoutInput {
  payoutId: string;
  idempotencyKey: string;
  amount: number;
  mobile: string;        // E.164
  name?: string;
  reason?: string;
}

export interface PayoutResult {
  status: 'succeeded' | 'processing' | 'failed';
  ref?: string;
  error?: string;
  raw: unknown;
}

export interface Provider {
  id: ProviderId;
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  getSession(sessionId: string): Promise<SessionState>;
  expireSession?(sessionId: string): Promise<void>;
  refundSession?(sessionId: string): Promise<void>;
  payout?(input: PayoutInput): Promise<PayoutResult>;
}

export class ProviderError extends Error {
  constructor(public provider: ProviderId, public httpStatus: number, public code: string, message: string) {
    super(`${provider} ${httpStatus} ${code}: ${message}`);
  }
}
