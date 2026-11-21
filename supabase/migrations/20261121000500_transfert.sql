-- Mode test « transfert manuel » : déclaration par le locataire, validation par un gestionnaire.

alter table public.payments
  add column declare_le  timestamptz,
  add column declare_sms text;

-- Une même référence de transaction ne peut servir qu'une fois
create unique index payments_tx_unique on public.payments (provider, tx_id) where tx_id is not null;

create function public.est_transfert(p public.provider_t) returns boolean
language sql immutable as $$ select p::text like 'transfert\_%' $$;

-- Le locataire déclare avoir envoyé le transfert
create function public.declarer_transfert(p_payment uuid, p_tx text, p_from text, p_sms text default null) returns text
language plpgsql security definer set search_path = public as $$
declare
  pay public.payments;
  b   public.bookings;
begin
  select * into pay from public.payments where id = p_payment for update;
  if not found then raise exception 'paiement_introuvable'; end if;
  select * into b from public.bookings where id = pay.booking_id;
  if b.locataire_id is distinct from auth.uid() then raise exception 'paiement_introuvable'; end if;
  if not public.est_transfert(pay.provider) then raise exception 'paiement_non_transfert'; end if;
  if pay.status <> 'en_attente' then raise exception 'paiement_non_attendu'; end if;
  if char_length(trim(coalesce(p_tx, ''))) < 6 then raise exception 'reference_invalide'; end if;
  if char_length(regexp_replace(coalesce(p_from, ''), '\D', '', 'g')) < 9 then raise exception 'numero_invalide'; end if;
  if exists (select 1 from public.payments where provider = pay.provider and tx_id = trim(p_tx) and id <> pay.id) then
    raise exception 'reference_deja_utilisee';
  end if;
  update public.payments
    set tx_id = trim(p_tx), payer_tel = trim(p_from), declare_sms = left(p_sms, 2000), declare_le = now()
    where id = pay.id;
  perform public._notifier(null, 'admin',
    format('Transfert de %s déclaré par %s (%s, réf. %s, depuis %s). À vérifier dans votre historique.',
           public.fcfa(pay.amount), b.loc_nom, case when pay.provider::text = 'transfert_wave' then 'Wave' else 'Orange Money' end,
           trim(p_tx), trim(p_from)), b.id, 'whatsapp');
  return 'ok';
end $$;

-- Le gestionnaire valide (argent bien reçu) ou refuse (transfert introuvable)
create function public.valider_transfert(p_payment uuid, p_ok boolean, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare
  pay public.payments;
  b   public.bookings;
begin
  if not public.is_admin() then raise exception 'acces_refuse'; end if;
  select * into pay from public.payments where id = p_payment for update;
  if not found or not public.est_transfert(pay.provider) then raise exception 'paiement_introuvable'; end if;
  if pay.declare_le is null or pay.status not in ('en_attente', 'expire') then raise exception 'rien_a_valider'; end if;
  if p_ok then
    -- Un transfert reçu compte même si la réservation a expiré entre-temps : appliquer_paiement le rembourse alors
    return public.appliquer_paiement(pay.id, pay.tx_id, pay.amount);
  end if;
  select * into b from public.bookings where id = pay.booking_id;
  update public.payments set status = 'echoue', erreur = left('transfert_non_recu ' || coalesce(p_note, ''), 300) where id = pay.id;
  perform public._notifier(b.locataire_id, 'locataire',
    format('Transfert %s non retrouvé (%s). Vérifiez votre envoi ou contactez Neeg Loc.%s', pay.tx_id, public.fcfa(pay.amount),
           case when p_note is not null then ' ' || p_note else '' end), b.id, 'sms');
  return 'refuse';
end $$;

-- expirer() : un transfert déclaré et en cours de vérification suspend les délais
create or replace function public.expirer() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p     public.parametres;
  b     public.bookings;
  n_att int := 0;
  n_exp int := 0;
  n_rap int := 0;
  deja  int;
  src   uuid;
  dl    timestamptz;
  due   int[];
  manq  int[];
begin
  select * into p from public.parametres where id = 1;

  -- 1. Premier paiement jamais abouti : on libère le logement
  for b in select bk.* from public.bookings bk
           where bk.etat = 'attente_paiement' and bk.attente_jusqua < now()
             and not exists (select 1 from public.payments x
                             where x.booking_id = bk.id and x.status = 'en_attente' and x.declare_le is not null)
           for update skip locked loop
    update public.payments set status = 'expire', erreur = coalesce(erreur, 'delai_depasse')
      where booking_id = b.id and status in ('cree', 'en_attente');
    update public.bookings set etat = 'annule' where id = b.id;
    update public.listings set statut = 'disponible' where id = b.listing_id and statut = 'bloque';
    perform public._notifier(b.locataire_id, 'locataire',
      format('Le paiement de la réservation %s n''a pas abouti à temps : le logement a été remis en ligne.', b.id), b.id, 'sms');
    n_att := n_att + 1;
  end loop;

  -- 2. Blocage de 72 h écoulé sans solde
  for b in select bk.* from public.bookings bk
           where bk.etat = 'bloque'
             and bk.bloc_debut + make_interval(hours => p.blocage_heures + bk.prolong_h) < now()
             and not exists (select 1 from public.payments x
                             where x.booking_id = bk.id and x.status = 'en_attente'
                               and (x.created_at > now() - interval '40 minutes' or x.declare_le is not null))
           for update skip locked loop
    deja := public.total_caution_paye(b.id);
    update public.payments set status = 'expire', erreur = coalesce(erreur, 'blocage_expire')
      where booking_id = b.id and status in ('cree', 'en_attente');
    update public.bookings
      set etat = 'expire', expire_le = now(),
          fonds = case when deja > 0 then 'a_rembourser'::public.fonds_t else 'rembourse'::public.fonds_t end
      where id = b.id;
    update public.listings set statut = 'disponible' where id = b.listing_id and statut = 'bloque';
    if deja > 0 then
      select id into src from public.payments
        where booking_id = b.id and status = 'reussi' and kind in ('acompte', 'caution', 'solde')
        order by paid_at limit 1;
      insert into public.payouts (booking_id, kind, payment_id, beneficiaire_id, nom, tel, montant, provider)
        select b.id, 'remboursement_locataire', src, b.locataire_id, b.loc_nom, b.loc_tel, deja, x.provider
        from public.payments x where x.id = src
        on conflict do nothing;
    end if;
    perform public._notifier(b.locataire_id, 'locataire',
      format('Le blocage de la réservation %s a expiré faute de solde. Votre acompte de %s vous sera remboursé.', b.id, public.fcfa(deja)), b.id, 'sms');
    perform public._notifier((select owner_id from public.listings where id = b.listing_id), 'proprietaire',
      format('Le blocage de %s (réservation %s) a expiré. Le logement est de nouveau en ligne.', b.loc_nom, b.id), b.id, 'whatsapp');
    perform public._notifier(null, 'admin',
      format('Blocage %s expiré : remboursement de %s programmé pour %s.', b.id, public.fcfa(deja), b.loc_nom), b.id);
    n_exp := n_exp + 1;
  end loop;

  -- 3. Rappels avant la fin du blocage
  for b in select bk.* from public.bookings bk where bk.etat = 'bloque' loop
    dl := b.bloc_debut + make_interval(hours => p.blocage_heures + b.prolong_h);
    select coalesce(array_agg(h), '{}') into due from unnest(p.rappels_h) h where dl - now() <= make_interval(hours => h);
    select coalesce(array_agg(h), '{}') into manq from unnest(due) h where not (h = any (b.rappels));
    if cardinality(manq) > 0 then
      update public.bookings set rappels = (select array_agg(distinct x) from unnest(b.rappels || due) x) where id = b.id;
      perform public._notifier(b.locataire_id, 'locataire',
        format('Rappel : payez le solde de %s avant le %s, sinon le logement sera remis en ligne (réservation %s).',
               public.fcfa(b.caution - public.total_caution_paye(b.id)), to_char(dl, 'DD/MM/YYYY à HH24:MI'), b.id), b.id, 'sms');
      n_rap := n_rap + 1;
    end if;
  end loop;

  return jsonb_build_object('attente_annulees', n_att, 'blocages_expires', n_exp, 'rappels', n_rap);
end $$;

revoke execute on function public.expirer() from public, anon, authenticated;
grant execute on function public.expirer() to service_role;
revoke execute on function public.est_transfert(public.provider_t), public.declarer_transfert(uuid, text, text, text),
  public.valider_transfert(uuid, boolean, text) from public, anon;
grant execute on function public.est_transfert(public.provider_t), public.declarer_transfert(uuid, text, text, text),
  public.valider_transfert(uuid, boolean, text) to authenticated;
