-- Neeg Loc : schéma de base (Supabase / PostgreSQL 15)
-- Les montants sont en francs CFA (XOF), entiers, sans décimales.

create extension if not exists pgcrypto;

create type public.role_t          as enum ('locataire', 'proprietaire', 'admin');
create type public.listing_statut  as enum ('disponible', 'bloque', 'loue', 'suspendu');
create type public.booking_etat    as enum ('attente_paiement', 'bloque', 'caution_payee', 'bail', 'expire', 'annule', 'clos');
create type public.fonds_t         as enum ('aucun', 'sequestre', 'a_verser', 'verse', 'a_rembourser', 'rembourse');
create type public.payment_kind    as enum ('acompte', 'caution', 'solde', 'loyer');
create type public.payment_status  as enum ('cree', 'en_attente', 'reussi', 'echoue', 'expire', 'rembourse');
create type public.provider_t      as enum ('wave', 'orange_money', 'simulateur');
create type public.payout_kind     as enum ('caution_proprio', 'loyer_proprio', 'remboursement_locataire');
create type public.payout_statut   as enum ('a_faire', 'en_cours', 'reussi', 'echoue', 'manuel');

-- Profils : un par compte Supabase Auth
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  nom         text not null default '',
  tel         text not null default '',
  role        public.role_t not null default 'locataire',
  created_at  timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nom, tel)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'nom', ''), coalesce(new.phone, ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Paramètres de la plateforme (une seule ligne)
create table public.parametres (
  id                        int primary key default 1 check (id = 1),
  caution_mois              int not null default 3,
  acompte_taux              numeric(4,3) not null default 0.25,
  blocage_heures            int not null default 72,
  attente_paiement_minutes  int not null default 35,   -- une session Wave expire après 30 min
  loyer_jour                int not null default 5,
  preavis_mois              int not null default 1,
  commission_loyer_pct      numeric(5,2) not null default 0,  -- commission Neeg Loc retenue sur les loyers reversés
  rappels_h                 int[] not null default '{24,6}'
);
insert into public.parametres (id) values (1);

-- Annonces
create table public.listings (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id),
  proprio_nom text not null default '',
  titre       text not null check (char_length(titre) between 4 and 120),
  type        text not null check (type in ('Chambre', 'Studio', 'Appartement', 'Villa', 'Bureau')),
  quartier    text not null,
  ville       text not null,
  loyer       integer not null check (loyer >= 10000),
  surface     integer check (surface > 0),
  pieces      integer not null default 1 check (pieces between 1 and 50),
  meuble      boolean not null default false,
  features    text[] not null default '{}',
  descr       text not null default '',
  photos      text[] not null default '{}',   -- chemins dans le bucket « photos »
  video       text,
  statut      public.listing_statut not null default 'disponible',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index listings_statut_idx on public.listings (statut);
create index listings_owner_idx on public.listings (owner_id);

-- Le nom affiché du propriétaire est copié depuis son profil
create function public.listings_proprio_nom() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select nom into new.proprio_nom from public.profiles where id = new.owner_id;
  new.updated_at := now();
  return new;
end $$;
create trigger listings_proprio_nom before insert or update on public.listings
  for each row execute function public.listings_proprio_nom();

-- Réservations et baux
create table public.bookings (
  id             text primary key default ('NL-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6))),
  listing_id     uuid not null references public.listings (id),
  locataire_id   uuid not null references public.profiles (id),
  loc_nom        text not null,
  loc_tel        text not null,
  prop_nom       text not null,
  prop_tel       text not null,
  loyer          integer not null,
  caution        integer not null,
  acompte        integer not null,
  etat           public.booking_etat not null default 'attente_paiement',
  attente_jusqua timestamptz,
  bloc_debut     timestamptz,
  prolong_h      int not null default 0,
  rappels        int[] not null default '{}',
  sign_loc       text,
  sign_prop      text,
  rdv_date       timestamptz,
  cles_le        timestamptz,
  fonds          public.fonds_t not null default 'aucun',
  fin            jsonb,
  relances       text[] not null default '{}',
  expire_le      timestamptz,
  created_at     timestamptz not null default now()
);
-- Une seule réservation active par logement : c'est la garantie contre la double réservation
create unique index bookings_un_actif on public.bookings (listing_id)
  where etat in ('attente_paiement', 'bloque', 'caution_payee', 'bail');
create index bookings_locataire_idx on public.bookings (locataire_id);

-- Paiements entrants (un par session de paiement chez l'opérateur)
create table public.payments (
  id          uuid primary key default gen_random_uuid(),
  booking_id  text not null references public.bookings (id) on delete cascade,
  kind        public.payment_kind not null,
  mois        text check (mois ~ '^\d{4}-\d{2}$'),
  provider    public.provider_t not null,
  amount      integer not null check (amount > 0),
  currency    text not null default 'XOF',
  status      public.payment_status not null default 'cree',
  session_id  text,
  tx_id       text,
  checkout_url text,
  action      jsonb,
  payer_tel   text,
  erreur      text,
  expires_at  timestamptz,
  paid_at     timestamptz,
  created_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((kind = 'loyer') = (mois is not null)),
  unique (provider, session_id)
);
create index payments_booking_idx on public.payments (booking_id);
create index payments_attente_idx on public.payments (status) where status in ('cree', 'en_attente');
-- Un loyer ne peut être encaissé qu'une fois par mois
create unique index payments_loyer_unique on public.payments (booking_id, mois)
  where status = 'reussi' and kind = 'loyer';

-- Loyers encaissés (une ligne par mois payé, sert aux quittances)
create table public.loyers (
  booking_id  text not null references public.bookings (id) on delete cascade,
  mois        text not null check (mois ~ '^\d{4}-\d{2}$'),
  montant     integer not null,
  payment_id  uuid not null references public.payments (id),
  paye_le     timestamptz not null default now(),
  primary key (booking_id, mois)
);

-- Versements sortants : caution et loyers au propriétaire, remboursements au locataire
create table public.payouts (
  id               uuid primary key default gen_random_uuid(),
  booking_id       text not null references public.bookings (id) on delete cascade,
  kind             public.payout_kind not null,
  payment_id       uuid references public.payments (id),     -- paiement à l'origine (loyer, remboursement)
  beneficiaire_id  uuid references public.profiles (id),
  nom              text not null,
  tel              text not null,
  montant          integer not null check (montant > 0),
  provider         public.provider_t not null,
  statut           public.payout_statut not null default 'a_faire',
  provider_ref     text,
  idempotency_key  uuid not null default gen_random_uuid(),
  erreur           text,
  created_at       timestamptz not null default now(),
  done_at          timestamptz
);
create unique index payouts_caution_unique on public.payouts (booking_id) where kind = 'caution_proprio';
create unique index payouts_source_unique on public.payouts (payment_id, kind) where payment_id is not null;
create index payouts_statut_idx on public.payouts (statut);

-- Journal des notifications d'opérateur (webhooks), pour l'idempotence et l'audit
create table public.payment_events (
  id        text primary key,           -- « wave:AE_… », « simulateur:SIM_… »
  provider  public.provider_t not null,
  type      text,
  payload   jsonb not null,
  recu_le   timestamptz not null default now(),
  traite    boolean not null default false,
  erreur    text
);

-- Sessions du simulateur d'opérateur (tests sans compte marchand)
create table public.simulateur_sessions (
  id           text primary key,
  payment_id   uuid not null references public.payments (id) on delete cascade,
  amount       integer not null,
  currency     text not null default 'XOF',
  statut       text not null default 'open' check (statut in ('open', 'succeeded', 'failed', 'expired')),
  success_url  text not null,
  error_url    text not null,
  tx_id        text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 minutes'
);

-- Notifications applicatives (l'envoi SMS / WhatsApp viendra se brancher ici)
create table public.notifications (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles (id) on delete cascade,   -- null = gestionnaires
  audience    text not null check (audience in ('locataire', 'proprietaire', 'admin')),
  canal       text not null default 'app',
  texte       text not null,
  booking_id  text references public.bookings (id) on delete set null,
  created_at  timestamptz not null default now(),
  lu_le       timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();
