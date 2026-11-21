-- Neeg Loc : règles métier côté serveur.
-- Toute transition d'état passe par ces fonctions : le navigateur ne modifie jamais
-- directement une réservation, un paiement ou un versement.

-- ---------- Outils ----------
create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

create function public.peut_voir_booking(p_booking text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.bookings b join public.listings l on l.id = b.listing_id
    where b.id = p_booking and (b.locataire_id = auth.uid() or l.owner_id = auth.uid())
  ) or public.is_admin()
$$;

create function public.fcfa(n integer) returns text
language sql immutable as $$
  select replace(to_char(n, 'FM999,999,999,990'), ',', ' ') || ' FCFA'
$$;

create function public._notifier(p_user uuid, p_aud text, p_texte text, p_booking text, p_canal text default 'app')
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, audience, texte, booking_id, canal)
  values (p_user, p_aud, p_texte, p_booking, p_canal)
$$;

create function public.total_caution_paye(p_booking text) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0)::int from public.payments
  where booking_id = p_booking and status = 'reussi' and kind in ('acompte', 'caution', 'solde')
$$;

-- Verrouille une réservation et vérifie que l'utilisateur courant y a droit
create function public._booking(p_booking text, p_qui text) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  b  public.bookings;
  ok boolean;
begin
  select * into b from public.bookings where id = p_booking for update;
  if not found then raise exception 'reservation_introuvable'; end if;
  ok := case p_qui
    when 'loc'    then b.locataire_id = auth.uid()
    when 'prop'   then exists (select 1 from public.listings where id = b.listing_id and owner_id = auth.uid())
    when 'admin'  then public.is_admin()
    when 'partie' then b.locataire_id = auth.uid()
                    or exists (select 1 from public.listings where id = b.listing_id and owner_id = auth.uid())
    else false end;
  if not coalesce(ok, false) then raise exception 'acces_refuse'; end if;
  return b;
end $$;

-- ---------- Loyers ----------
create function public.loyers_dus(p_booking text)
returns table (mois text, echeance timestamptz, paye boolean)
language sql stable security definer set search_path = public as $$
  with b as (
    select bk.*, date_trunc('month', bk.cles_le) as debut,
           date_trunc('month', least(now(), coalesce((bk.fin ->> 'sortie')::timestamptz, now()))) as fin_m
    from public.bookings bk where bk.id = p_booking and bk.cles_le is not null
  ), p as (select loyer_jour from public.parametres where id = 1)
  select to_char(m, 'YYYY-MM'),
         greatest(m + make_interval(days => p.loyer_jour - 1, hours => 23, mins => 59),
                  case when m = b.debut then b.cles_le + interval '5 days' else '-infinity'::timestamptz end),
         exists (select 1 from public.loyers lo where lo.booking_id = b.id and lo.mois = to_char(m, 'YYYY-MM'))
  from b, p, generate_series(b.debut, b.fin_m, interval '1 month') as m
  order by m
$$;

create function public.prochain_loyer(p_booking text) returns text
language sql stable security definer set search_path = public as $$
  select d.mois from public.loyers_dus(p_booking) d where not d.paye order by d.mois limit 1
$$;

-- ---------- Réservation ----------
create function public.reserver(p_listing uuid, p_nom text, p_tel text) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  l   public.listings;
  pr  public.profiles;
  p   public.parametres;
  b   public.bookings;
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'non_authentifie'; end if;
  if char_length(trim(coalesce(p_nom, ''))) < 3 or char_length(regexp_replace(coalesce(p_tel, ''), '\D', '', 'g')) < 9 then
    raise exception 'identite_invalide';
  end if;
  select * into l from public.listings where id = p_listing for update;
  if not found then raise exception 'logement_introuvable'; end if;
  if l.owner_id = uid then raise exception 'propre_logement'; end if;
  if l.statut <> 'disponible' then raise exception 'logement_indisponible'; end if;
  select * into pr from public.profiles where id = l.owner_id;
  select * into p from public.parametres where id = 1;
  insert into public.bookings (listing_id, locataire_id, loc_nom, loc_tel, prop_nom, prop_tel, loyer, caution, acompte, attente_jusqua)
  values (l.id, uid, trim(p_nom), trim(p_tel), pr.nom, pr.tel, l.loyer, l.loyer * p.caution_mois,
          (round(l.loyer * p.acompte_taux / 500) * 500)::int,
          now() + make_interval(mins => p.attente_paiement_minutes))
  returning * into b;
  update public.listings set statut = 'bloque' where id = l.id;
  update public.profiles set nom = coalesce(nullif(nom, ''), trim(p_nom)), tel = coalesce(nullif(tel, ''), trim(p_tel)) where id = uid;
  return b;
end $$;

-- Ce que le locataire peut payer maintenant (pour l'interface)
create function public.paiements_attendus(p_booking text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  b public.bookings;
  r jsonb := '[]'::jsonb;
  m text;
begin
  select * into b from public.bookings where id = p_booking;
  if not found or (b.locataire_id is distinct from auth.uid() and not public.is_admin()) then
    raise exception 'reservation_introuvable';
  end if;
  if b.etat = 'attente_paiement' and public.total_caution_paye(b.id) = 0 then
    r := r || jsonb_build_array(jsonb_build_object('kind', 'acompte', 'montant', b.acompte),
                                jsonb_build_object('kind', 'caution', 'montant', b.caution));
  elsif b.etat = 'bloque' then
    r := r || jsonb_build_array(jsonb_build_object('kind', 'solde', 'montant', b.caution - public.total_caution_paye(b.id)));
  elsif b.etat = 'bail' and coalesce(b.fin ->> 'etape', '') not in ('rembourse', 'clos') then
    m := public.prochain_loyer(b.id);
    if m is not null then
      r := r || jsonb_build_array(jsonb_build_object('kind', 'loyer', 'mois', m, 'montant', b.loyer));
    end if;
  end if;
  return r;
end $$;

-- Montant exigible, calculé côté serveur (jamais fourni par le navigateur)
create function public.montant_du(p_booking text, p_kind public.payment_kind, p_mois text default null) returns integer
language plpgsql stable security definer set search_path = public as $$
declare
  b    public.bookings;
  deja int;
begin
  select * into b from public.bookings where id = p_booking;
  if not found then raise exception 'reservation_introuvable'; end if;
  deja := public.total_caution_paye(b.id);
  if p_kind in ('acompte', 'caution') then
    if b.etat <> 'attente_paiement' or deja > 0 then raise exception 'paiement_non_attendu'; end if;
    return case when p_kind = 'acompte' then b.acompte else b.caution end;
  elsif p_kind = 'solde' then
    if b.etat <> 'bloque' or b.caution - deja <= 0 then raise exception 'paiement_non_attendu'; end if;
    return b.caution - deja;
  else
    if b.etat <> 'bail' or coalesce(b.fin ->> 'etape', '') in ('rembourse', 'clos') then
      raise exception 'paiement_non_attendu';
    end if;
    if p_mois is null or p_mois is distinct from public.prochain_loyer(b.id) then raise exception 'mois_non_attendu'; end if;
    return b.loyer;
  end if;
end $$;

-- ---------- Encaissement (appelé uniquement par les fonctions serveur) ----------
create function public.appliquer_paiement(p_payment uuid, p_tx text, p_montant integer) returns text
language plpgsql security definer set search_path = public as $$
declare
  pay     public.payments;
  b       public.bookings;
  l       public.listings;
  p       public.parametres;
  total   int;
  surplus int;
  net     int;
begin
  select * into pay from public.payments where id = p_payment for update;
  if not found then raise exception 'paiement_introuvable'; end if;
  if pay.status = 'reussi' then return 'deja_traite'; end if;
  if p_montant is distinct from pay.amount then
    update public.payments
      set erreur = format('montant_recu_%s_attendu_%s', coalesce(p_montant::text, '?'), pay.amount)
      where id = pay.id;
    perform public._notifier(null, 'admin',
      format('Paiement %s : montant reçu (%s) différent du montant attendu (%s). Vérification manuelle requise.',
             pay.id, coalesce(p_montant::text, '?'), pay.amount), pay.booking_id);
    return 'montant_incorrect';
  end if;

  update public.payments set status = 'reussi', tx_id = coalesce(p_tx, tx_id), paid_at = now(), erreur = null
    where id = pay.id;
  select * into b from public.bookings where id = pay.booking_id for update;
  select * into l from public.listings where id = b.listing_id for update;
  select * into p from public.parametres where id = 1;

  if pay.kind = 'loyer' then
    insert into public.loyers (booking_id, mois, montant, payment_id)
      values (b.id, pay.mois, pay.amount, pay.id) on conflict do nothing;
    net := pay.amount - round(pay.amount * p.commission_loyer_pct / 100)::int;
    insert into public.payouts (booking_id, kind, payment_id, beneficiaire_id, nom, tel, montant, provider)
      values (b.id, 'loyer_proprio', pay.id, l.owner_id, b.prop_nom, b.prop_tel, net, pay.provider)
      on conflict do nothing;
    perform public._notifier(b.locataire_id, 'locataire',
      format('Loyer de %s reçu (%s). Votre quittance est disponible.', pay.mois, public.fcfa(pay.amount)), b.id, 'sms');
    perform public._notifier(l.owner_id, 'proprietaire',
      format('Loyer de %s payé par %s (%s). Versement de %s en cours.', pay.mois, b.loc_nom, public.fcfa(pay.amount), public.fcfa(net)), b.id, 'whatsapp');
    return 'ok';
  end if;

  -- Acompte, caution ou solde arrivés après la fin de la réservation : on rembourse
  if b.etat in ('expire', 'annule', 'clos') then
    insert into public.payouts (booking_id, kind, payment_id, beneficiaire_id, nom, tel, montant, provider)
      values (b.id, 'remboursement_locataire', pay.id, b.locataire_id, b.loc_nom, b.loc_tel, pay.amount, pay.provider)
      on conflict do nothing;
    perform public._notifier(null, 'admin',
      format('Paiement tardif de %s sur la réservation %s (%s) : remboursement programmé.', public.fcfa(pay.amount), b.id, b.etat), b.id);
    perform public._notifier(b.locataire_id, 'locataire',
      format('Votre paiement de %s est arrivé après la fin de la réservation %s. Il vous sera remboursé.', public.fcfa(pay.amount), b.id), b.id, 'sms');
    return 'paiement_tardif';
  end if;

  total := public.total_caution_paye(b.id);
  if total >= b.caution then
    surplus := least(pay.amount, total - b.caution);
    if surplus > 0 then
      insert into public.payouts (booking_id, kind, payment_id, beneficiaire_id, nom, tel, montant, provider)
        values (b.id, 'remboursement_locataire', pay.id, b.locataire_id, b.loc_nom, b.loc_tel, surplus, pay.provider)
        on conflict do nothing;
      perform public._notifier(null, 'admin',
        format('Trop-perçu de %s sur la réservation %s : remboursement programmé.', public.fcfa(surplus), b.id), b.id);
    end if;
    if b.etat in ('attente_paiement', 'bloque') then
      update public.bookings set etat = 'caution_payee', fonds = 'sequestre', attente_jusqua = null where id = b.id;
      perform public._notifier(b.locataire_id, 'locataire',
        format('Caution de %s reçue. Votre contrat %s est prêt à être signé.', public.fcfa(b.caution), b.id), b.id, 'sms');
      perform public._notifier(l.owner_id, 'proprietaire',
        format('Caution de %s reçue de %s pour « %s ». Signez le contrat.', public.fcfa(b.caution), b.loc_nom, l.titre), b.id, 'whatsapp');
      perform public._notifier(null, 'admin',
        format('Caution complète reçue (%s), fonds en séquestre.', b.id), b.id);
    end if;
  elsif pay.kind = 'acompte' and b.etat = 'attente_paiement' then
    update public.bookings set etat = 'bloque', bloc_debut = now(), fonds = 'sequestre', rappels = '{}', attente_jusqua = null
      where id = b.id;
    perform public._notifier(b.locataire_id, 'locataire',
      format('Acompte de %s reçu. « %s » est bloqué pour vous %s h : payez le solde de %s avant le %s.',
             public.fcfa(pay.amount), l.titre, p.blocage_heures, public.fcfa(b.caution - total),
             to_char(now() + make_interval(hours => p.blocage_heures), 'DD/MM/YYYY à HH24:MI')), b.id, 'sms');
    perform public._notifier(l.owner_id, 'proprietaire',
      format('%s a bloqué « %s » pour %s h (acompte reçu).', b.loc_nom, l.titre, p.blocage_heures), b.id, 'whatsapp');
  end if;
  return 'ok';
end $$;

create function public.echec_paiement(p_payment uuid, p_raison text, p_final boolean,
                                      p_statut public.payment_status default 'echoue') returns void
language sql security definer set search_path = public as $$
  update public.payments
    set erreur = left(p_raison, 300),
        status = case when p_final then p_statut else status end
    where id = p_payment and status in ('cree', 'en_attente')
$$;

-- ---------- Versements sortants ----------
create function public._payout_effets(p_payout uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  po public.payouts;
  b  public.bookings;
begin
  select * into po from public.payouts where id = p_payout;
  select * into b from public.bookings where id = po.booking_id for update;
  if po.kind = 'caution_proprio' then
    update public.bookings set fonds = 'verse' where id = b.id and fonds = 'a_verser';
    perform public._notifier(po.beneficiaire_id, 'proprietaire',
      format('Caution de %s versée sur votre compte (réservation %s, réf. %s).', public.fcfa(po.montant), b.id, coalesce(po.provider_ref, '-')), b.id, 'sms');
  elsif po.kind = 'loyer_proprio' then
    perform public._notifier(po.beneficiaire_id, 'proprietaire',
      format('Loyer de %s versé sur votre compte (réservation %s, réf. %s).', public.fcfa(po.montant), b.id, coalesce(po.provider_ref, '-')), b.id, 'sms');
  else
    if b.etat in ('expire', 'annule') then
      update public.bookings set fonds = 'rembourse' where id = b.id and fonds = 'a_rembourser';
    end if;
    perform public._notifier(po.beneficiaire_id, 'locataire',
      format('Neeg Loc vous a remboursé %s (réservation %s, réf. %s).', public.fcfa(po.montant), b.id, coalesce(po.provider_ref, '-')), b.id, 'sms');
  end if;
end $$;

create function public.payout_termine(p_payout uuid, p_statut public.payout_statut, p_ref text, p_erreur text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.payouts
    set statut = p_statut, provider_ref = coalesce(p_ref, provider_ref), erreur = p_erreur,
        done_at = case when p_statut in ('reussi', 'manuel') then now() else done_at end
    where id = p_payout;
  if p_statut in ('reussi', 'manuel') then perform public._payout_effets(p_payout); end if;
  if p_statut = 'echoue' then
    perform public._notifier(null, 'admin', format('Versement %s en échec : %s', p_payout, coalesce(p_erreur, '?')), null);
  end if;
end $$;

-- Versement effectué à la main par le gestionnaire (Orange Money, ou échec côté opérateur)
create function public.marquer_payout(p_payout uuid, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'acces_refuse'; end if;
  if char_length(trim(coalesce(p_ref, ''))) < 6 then raise exception 'reference_invalide'; end if;
  if not exists (select 1 from public.payouts where id = p_payout and statut in ('a_faire', 'echoue')) then
    raise exception 'versement_non_modifiable';
  end if;
  perform public.payout_termine(p_payout, 'manuel', trim(p_ref), null);
end $$;

-- ---------- Tâches planifiées ----------
create function public.expirer() returns jsonb
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
                               and x.created_at > now() - interval '40 minutes')
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

create function public.relancer_loyers() returns integer
language plpgsql security definer set search_path = public as $$
declare
  b public.bookings;
  m text;
  n int := 0;
begin
  for b in select bk.* from public.bookings bk
           where bk.etat = 'bail' and coalesce(bk.fin ->> 'etape', '') not in ('rembourse', 'clos') loop
    for m in select d.mois from public.loyers_dus(b.id) d
             where not d.paye and d.echeance < now() and not (d.mois = any (b.relances)) loop
      update public.bookings set relances = array_append(relances, m) where id = b.id;
      perform public._notifier(b.locataire_id, 'locataire',
        format('Le loyer de %s (%s) n''est pas encore payé. Réglez-le depuis Neeg Loc.', m, public.fcfa(b.loyer)), b.id, 'sms');
      perform public._notifier((select owner_id from public.listings where id = b.listing_id), 'proprietaire',
        format('Loyer de %s non reçu de %s. Un rappel lui a été envoyé.', m, b.loc_nom), b.id, 'whatsapp');
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- ---------- Parcours du bail ----------
create function public.signer_contrat(p_booking text, p_signature text) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  b    public.bookings;
  l    public.listings;
  role text;
begin
  b := public._booking(p_booking, 'partie');
  if b.etat <> 'caution_payee' then raise exception 'signature_non_attendue'; end if;
  if char_length(coalesce(p_signature, '')) < 50 or char_length(p_signature) > 200000 then raise exception 'signature_invalide'; end if;
  select * into l from public.listings where id = b.listing_id;
  role := case when b.locataire_id = auth.uid() then 'loc' else 'prop' end;
  if role = 'loc' then
    update public.bookings set sign_loc = coalesce(sign_loc, p_signature) where id = b.id returning * into b;
  else
    update public.bookings set sign_prop = coalesce(sign_prop, p_signature) where id = b.id returning * into b;
  end if;
  if b.sign_loc is not null and b.sign_prop is not null then
    perform public._notifier(b.locataire_id, 'locataire', format('Contrat %s signé par les deux parties. Choisissez votre créneau de remise des clés.', b.id), b.id, 'email');
    perform public._notifier(l.owner_id, 'proprietaire', format('Contrat %s signé par les deux parties.', b.id), b.id, 'email');
  elsif role = 'loc' then
    perform public._notifier(l.owner_id, 'proprietaire', format('%s a signé le contrat %s. À vous de signer.', b.loc_nom, b.id), b.id, 'whatsapp');
  else
    perform public._notifier(b.locataire_id, 'locataire', format('%s a signé le contrat %s. Il ne manque que votre signature.', b.prop_nom, b.id), b.id, 'sms');
  end if;
  return b;
end $$;

create function public.fixer_rdv(p_booking text, p_date timestamptz) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  b := public._booking(p_booking, 'loc');
  if b.etat <> 'caution_payee' or b.sign_loc is null or b.sign_prop is null then raise exception 'rdv_non_attendu'; end if;
  if p_date < now() then raise exception 'date_passee'; end if;
  update public.bookings set rdv_date = p_date where id = b.id returning * into b;
  perform public._notifier((select owner_id from public.listings where id = b.listing_id), 'proprietaire',
    format('Remise des clés fixée le %s avec %s (réservation %s).', to_char(p_date, 'DD/MM/YYYY à HH24:MI'), b.loc_nom, b.id), b.id, 'whatsapp');
  return b;
end $$;

create function public.confirmer_cles(p_booking text) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  b    public.bookings;
  l    public.listings;
  prov public.provider_t;
begin
  b := public._booking(p_booking, 'loc');
  if b.etat <> 'caution_payee' or b.rdv_date is null then raise exception 'remise_non_attendue'; end if;
  select * into l from public.listings where id = b.listing_id for update;
  select provider into prov from public.payments
    where booking_id = b.id and status = 'reussi' order by paid_at desc limit 1;
  update public.bookings set etat = 'bail', cles_le = now(), fonds = 'a_verser' where id = b.id returning * into b;
  update public.listings set statut = 'loue' where id = l.id;
  insert into public.payouts (booking_id, kind, beneficiaire_id, nom, tel, montant, provider)
    values (b.id, 'caution_proprio', l.owner_id, b.prop_nom, b.prop_tel, b.caution, coalesce(prov, 'wave'))
    on conflict do nothing;
  perform public._notifier(l.owner_id, 'proprietaire',
    format('%s a confirmé la remise des clés. Neeg Loc vous verse la caution de %s.', b.loc_nom, public.fcfa(b.caution)), b.id, 'sms');
  perform public._notifier(null, 'admin', format('Clés remises (%s) : caution de %s à verser à %s.', b.id, public.fcfa(b.caution), b.prop_nom), b.id);
  return b;
end $$;

create function public.prolonger_blocage(p_booking text, p_heures int default 24) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  b := public._booking(p_booking, 'admin');
  if b.etat <> 'bloque' then raise exception 'blocage_inactif'; end if;
  if p_heures not between 1 and 168 then raise exception 'duree_invalide'; end if;
  update public.bookings set prolong_h = prolong_h + p_heures, rappels = '{}' where id = b.id returning * into b;
  perform public._notifier(b.locataire_id, 'locataire', format('Neeg Loc prolonge votre blocage de %s h (réservation %s).', p_heures, b.id), b.id, 'sms');
  return b;
end $$;

create function public._clore(p_booking text) returns void
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  update public.bookings
    set etat = 'clos', fin = coalesce(fin, '{}'::jsonb) || jsonb_build_object('etape', 'clos', 'clos_le', now())
    where id = p_booking returning * into b;
  update public.listings set statut = 'disponible' where id = b.listing_id and statut = 'loue';
  perform public._notifier((select owner_id from public.listings where id = b.listing_id), 'proprietaire',
    format('Bail %s clôturé. Le logement est remis en location.', b.id), b.id, 'sms');
end $$;

create function public.donner_conge(p_booking text, p_sortie date) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  b   public.bookings;
  par text;
begin
  b := public._booking(p_booking, 'partie');
  if b.etat <> 'bail' or b.fin is not null then raise exception 'conge_non_attendu'; end if;
  if p_sortie < current_date then raise exception 'date_passee'; end if;
  par := case when b.locataire_id = auth.uid() then 'loc' else 'prop' end;
  update public.bookings
    set fin = jsonb_build_object('par', par, 'le', now(), 'sortie', p_sortie, 'etape', 'preavis')
    where id = b.id returning * into b;
  if par = 'loc' then
    perform public._notifier((select owner_id from public.listings where id = b.listing_id), 'proprietaire',
      format('%s a donné congé : sortie le %s. Prévoyez l''état des lieux.', b.loc_nom, to_char(p_sortie, 'DD/MM/YYYY')), b.id, 'whatsapp');
  else
    perform public._notifier(b.locataire_id, 'locataire',
      format('%s vous a donné congé : sortie le %s.', b.prop_nom, to_char(p_sortie, 'DD/MM/YYYY')), b.id, 'sms');
  end if;
  return b;
end $$;

create function public.etat_des_lieux(p_booking text, p_retenue int, p_motif text) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  b := public._booking(p_booking, 'prop');
  if coalesce(b.fin ->> 'etape', '') <> 'preavis' then raise exception 'edl_non_attendu'; end if;
  if p_retenue < 0 or p_retenue > b.caution then raise exception 'retenue_invalide'; end if;
  if p_retenue > 0 and char_length(trim(coalesce(p_motif, ''))) < 5 then raise exception 'motif_requis'; end if;
  update public.bookings
    set fin = fin || jsonb_build_object('retenue', p_retenue, 'motif', trim(coalesce(p_motif, '')), 'edl_le', now(), 'etape', 'edl')
    where id = b.id returning * into b;
  perform public._notifier(b.locataire_id, 'locataire',
    format('État des lieux de sortie : retenue de %s, restitution de %s. Acceptez ou contestez dans Neeg Loc.',
           public.fcfa(p_retenue), public.fcfa(b.caution - p_retenue)), b.id, 'sms');
  return b;
end $$;

create function public.repondre_edl(p_booking text, p_accepte boolean, p_motif text default null) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  b := public._booking(p_booking, 'loc');
  if coalesce(b.fin ->> 'etape', '') <> 'edl' then raise exception 'reponse_non_attendue'; end if;
  if p_accepte then
    if b.caution - (b.fin ->> 'retenue')::int = 0 then
      perform public._clore(b.id);
    else
      update public.bookings set fin = fin || '{"etape":"accepte"}'::jsonb where id = b.id;
      perform public._notifier((select owner_id from public.listings where id = b.listing_id), 'proprietaire',
        format('%s accepte l''état des lieux. Restituez %s.', b.loc_nom, public.fcfa(b.caution - (b.fin ->> 'retenue')::int)), b.id, 'whatsapp');
    end if;
  else
    if char_length(trim(coalesce(p_motif, ''))) < 5 then raise exception 'motif_requis'; end if;
    update public.bookings set fin = fin || jsonb_build_object('etape', 'conteste', 'contest', trim(p_motif)) where id = b.id;
    perform public._notifier(null, 'admin', format('%s conteste la retenue (%s) : « %s ». Arbitrage requis.', b.loc_nom, b.id, trim(p_motif)), b.id);
  end if;
  select * into b from public.bookings where id = p_booking;
  return b;
end $$;

create function public.arbitrer(p_booking text, p_retenue int, p_decision text) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  b := public._booking(p_booking, 'admin');
  if coalesce(b.fin ->> 'etape', '') <> 'conteste' then raise exception 'arbitrage_non_attendu'; end if;
  if p_retenue < 0 or p_retenue > b.caution then raise exception 'retenue_invalide'; end if;
  update public.bookings
    set fin = fin || jsonb_build_object('retenue', p_retenue, 'decision', coalesce(p_decision, ''), 'arbitre', true, 'etape', 'accepte')
    where id = b.id;
  perform public._notifier(b.locataire_id, 'locataire',
    format('Décision Neeg Loc (%s) : retenue de %s, restitution de %s. %s', b.id, public.fcfa(p_retenue), public.fcfa(b.caution - p_retenue), coalesce(p_decision, '')), b.id, 'sms');
  perform public._notifier((select owner_id from public.listings where id = b.listing_id), 'proprietaire',
    format('Décision Neeg Loc (%s) : retenue de %s, restitution de %s. %s', b.id, public.fcfa(p_retenue), public.fcfa(b.caution - p_retenue), coalesce(p_decision, '')), b.id, 'whatsapp');
  if b.caution - p_retenue = 0 then perform public._clore(b.id); end if;
  select * into b from public.bookings where id = p_booking;
  return b;
end $$;

create function public.declarer_restitution(p_booking text, p_ref text, p_moyen text) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  b := public._booking(p_booking, 'prop');
  if coalesce(b.fin ->> 'etape', '') <> 'accepte' then raise exception 'restitution_non_attendue'; end if;
  if char_length(trim(coalesce(p_ref, ''))) < 6 then raise exception 'reference_invalide'; end if;
  update public.bookings
    set fin = fin || jsonb_build_object('etape', 'rembourse', 'remb', jsonb_build_object('ref', trim(p_ref), 'moyen', p_moyen, 'le', now()))
    where id = b.id returning * into b;
  perform public._notifier(b.locataire_id, 'locataire',
    format('%s vous a restitué votre caution (%s, réf. %s). Confirmez la réception.', b.prop_nom, p_moyen, trim(p_ref)), b.id, 'sms');
  return b;
end $$;

create function public.confirmer_restitution(p_booking text) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare b public.bookings;
begin
  b := public._booking(p_booking, 'loc');
  if coalesce(b.fin ->> 'etape', '') <> 'rembourse' then raise exception 'confirmation_non_attendue'; end if;
  perform public._clore(b.id);
  select * into b from public.bookings where id = p_booking;
  return b;
end $$;

create function public.moderer_annonce(p_listing uuid, p_suspendre boolean) returns void
language plpgsql security definer set search_path = public as $$
declare l public.listings;
begin
  if not public.is_admin() then raise exception 'acces_refuse'; end if;
  update public.listings
    set statut = case when p_suspendre then 'suspendu'::public.listing_statut else 'disponible'::public.listing_statut end
    where id = p_listing and statut in ('disponible', 'suspendu') returning * into l;
  if not found then raise exception 'annonce_non_modifiable'; end if;
  perform public._notifier(l.owner_id, 'proprietaire',
    format('Votre annonce « %s » a été %s par Neeg Loc.', l.titre, case when p_suspendre then 'suspendue' else 'réactivée' end), null, 'email');
end $$;

create function public.notifs_lues() returns void
language sql security definer set search_path = public as $$
  update public.notifications set lu_le = now() where user_id = auth.uid() and lu_le is null
$$;
