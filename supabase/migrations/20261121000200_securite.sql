-- Neeg Loc : droits d'accès (Row Level Security) et droits d'exécution.
-- Principe : lecture limitée à ce qui concerne l'utilisateur, aucune écriture directe
-- sur l'argent. Les écritures passent par les fonctions de 20261121000100_metier.sql.

alter table public.profiles            enable row level security;
alter table public.parametres          enable row level security;
alter table public.listings            enable row level security;
alter table public.bookings            enable row level security;
alter table public.payments            enable row level security;
alter table public.loyers              enable row level security;
alter table public.payouts             enable row level security;
alter table public.payment_events      enable row level security;
alter table public.simulateur_sessions enable row level security;
alter table public.notifications       enable row level security;

-- On retire les droits larges accordés par défaut, puis on rend colonne par colonne
revoke all on all tables in schema public from anon, authenticated;

-- Profils : chacun lit et corrige son nom et son téléphone, jamais son rôle
grant select on public.profiles to authenticated;
grant update (nom, tel) on public.profiles to authenticated;
create policy profiles_lecture on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_maj on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Paramètres : lisibles par tous, modifiables par les gestionnaires
grant select on public.parametres to anon, authenticated;
grant update (caution_mois, acompte_taux, blocage_heures, attente_paiement_minutes, loyer_jour, preavis_mois, commission_loyer_pct, rappels_h)
  on public.parametres to authenticated;
create policy parametres_lecture on public.parametres for select using (true);
create policy parametres_admin on public.parametres for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Annonces : publiques ; le propriétaire crée et modifie les siennes, sauf le statut
grant select on public.listings to anon, authenticated;
grant insert (owner_id, titre, type, quartier, ville, loyer, surface, pieces, meuble, features, descr, photos, video)
  on public.listings to authenticated;
grant update (titre, type, quartier, ville, loyer, surface, pieces, meuble, features, descr, photos, video)
  on public.listings to authenticated;
create policy listings_lecture on public.listings for select
  using (statut <> 'suspendu' or owner_id = auth.uid() or public.is_admin());
create policy listings_creation on public.listings for insert to authenticated
  with check (owner_id = auth.uid());
create policy listings_maj on public.listings for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Réservations, paiements, loyers : lecture par les parties et les gestionnaires
grant select on public.bookings, public.payments, public.loyers to authenticated;
create policy bookings_lecture on public.bookings for select to authenticated
  using (public.peut_voir_booking(id));
create policy payments_lecture on public.payments for select to authenticated
  using (public.peut_voir_booking(booking_id));
create policy loyers_lecture on public.loyers for select to authenticated
  using (public.peut_voir_booking(booking_id));

-- Versements : le bénéficiaire et les gestionnaires
grant select on public.payouts to authenticated;
create policy payouts_lecture on public.payouts for select to authenticated
  using (beneficiaire_id = auth.uid() or public.is_admin());

-- Notifications : les siennes ; celles des gestionnaires pour les gestionnaires
grant select on public.notifications to authenticated;
grant update (lu_le) on public.notifications to authenticated;
create policy notifications_lecture on public.notifications for select to authenticated
  using (user_id = auth.uid() or (user_id is null and audience = 'admin' and public.is_admin()));
create policy notifications_maj on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- payment_events et simulateur_sessions : aucune politique = réservé au rôle service

-- ---------- Fonctions ----------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.is_admin(),
  public.peut_voir_booking(text),
  public.fcfa(integer),
  public.reserver(uuid, text, text),
  public.paiements_attendus(text),
  public.prochain_loyer(text),
  public.loyers_dus(text),
  public.signer_contrat(text, text),
  public.fixer_rdv(text, timestamptz),
  public.confirmer_cles(text),
  public.prolonger_blocage(text, int),
  public.donner_conge(text, date),
  public.etat_des_lieux(text, int, text),
  public.repondre_edl(text, boolean, text),
  public.arbitrer(text, int, text),
  public.declarer_restitution(text, text, text),
  public.confirmer_restitution(text),
  public.moderer_annonce(uuid, boolean),
  public.marquer_payout(uuid, text),
  public.notifs_lues()
to authenticated;

-- La règle de lecture des annonces l'utilise aussi pour les visiteurs non connectés
grant execute on function public.is_admin() to anon;

-- Les fonctions d'encaissement ne sont appelables que par les fonctions serveur (rôle service)
grant execute on function
  public.montant_du(text, public.payment_kind, text),
  public.appliquer_paiement(uuid, text, integer),
  public.echec_paiement(uuid, text, boolean, public.payment_status),
  public.payout_termine(uuid, public.payout_statut, text, text),
  public.expirer(),
  public.relancer_loyers()
to service_role;

-- Les déclencheurs gardent leurs droits (ils s'exécutent en security definer)

-- ---------- Temps réel : l'écran de paiement suit le statut en direct ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.payments, public.bookings, public.notifications;
  end if;
end $$;

-- ---------- Stockage des photos ----------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('photos', 'photos', true, 20971520, array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'])
      on conflict (id) do nothing;
    execute $p$create policy photos_depot on storage.objects for insert to authenticated
      with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
    execute $p$create policy photos_suppression on storage.objects for delete to authenticated
      using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)$p$;
  end if;
end $$;
