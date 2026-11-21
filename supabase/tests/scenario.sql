-- Scénario de bout en bout du cycle de l'argent, sur une base locale :
--   supabase start && supabase db reset
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/scenario.sql
-- Tout se passe dans une transaction annulée à la fin : la base reste propre.
-- Chaque vérification affiche « OK … » ou interrompt le script avec « ÉCHEC … ».

\set ON_ERROR_STOP on
\set PROP '''11111111-1111-1111-1111-111111111111'''
\set LOC  '''22222222-2222-2222-2222-222222222222'''
\set ADM  '''33333333-3333-3333-3333-333333333333'''
\set AUTRE '''44444444-4444-4444-4444-444444444444'''
\set LST  '''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'''
\set en_prop  'reset role; select set_config(''request.jwt.claims'', format(''{"sub":"%s","role":"authenticated"}'', ' :PROP '), false); set role authenticated;'
\set en_loc   'reset role; select set_config(''request.jwt.claims'', format(''{"sub":"%s","role":"authenticated"}'', ' :LOC '), false); set role authenticated;'
\set en_adm   'reset role; select set_config(''request.jwt.claims'', format(''{"sub":"%s","role":"authenticated"}'', ' :ADM '), false); set role authenticated;'
\set en_autre 'reset role; select set_config(''request.jwt.claims'', format(''{"sub":"%s","role":"authenticated"}'', ' :AUTRE '), false); set role authenticated;'
\set en_serveur 'reset role; set role service_role;'

begin;

create function public._test_ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ÉCHEC : %', msg; end if;
  raise notice 'OK %', msg;
end $$;

-- Comptes et annonce
insert into auth.users (id, email) values (:PROP, 'proprio@test.sn'), (:LOC, 'loc@test.sn'), (:ADM, 'admin@test.sn'), (:AUTRE, 'autre@test.sn');
update public.profiles set nom = 'Awa Ndiaye', tel = '77 412 58 90', role = 'proprietaire' where id = :PROP;
update public.profiles set nom = 'Aminata Diallo', tel = '77 000 11 22' where id = :LOC;
update public.profiles set nom = 'Gestion Neeg Loc', role = 'admin' where id = :ADM;
insert into public.listings (id, owner_id, titre, type, quartier, ville, loyer) values (:LST, :PROP, 'Studio test Mermoz', 'Studio', 'Mermoz', 'Dakar', 200000);

-- ===== 1. Réservation avec acompte =====
:en_loc
select set_config('t.bk', (select id from public.reserver(:LST, 'Aminata Diallo', '77 000 11 22')), false);
do $$ begin
  update public.bookings set etat = 'bail';
  raise exception 'ÉCHEC : écriture directe sur une réservation autorisée';
exception when insufficient_privilege then raise notice 'OK le locataire ne peut pas modifier une réservation directement';
end $$;
do $$ begin
  perform public.appliquer_paiement(gen_random_uuid(), 'X', 1);
  raise exception 'ÉCHEC : encaissement appelable par un utilisateur';
exception when insufficient_privilege then raise notice 'OK l''encaissement est réservé au serveur';
end $$;

:en_serveur
select public._test_ok((select statut from public.listings where id = :LST) = 'bloque', 'logement bloqué pendant le paiement');
select public._test_ok(public.montant_du(current_setting('t.bk'), 'acompte') = 50000, 'acompte = 25 % du loyer');
insert into public.payments (id, booking_id, kind, provider, amount, status, session_id)
  values ('b0000000-0000-0000-0000-000000000001', current_setting('t.bk'), 'acompte', 'simulateur', 50000, 'en_attente', 'sim_1');
select public._test_ok(public.appliquer_paiement('b0000000-0000-0000-0000-000000000001', 'TX1', 49000) = 'montant_incorrect', 'montant différent refusé');
select public._test_ok(public.appliquer_paiement('b0000000-0000-0000-0000-000000000001', 'TX1', 50000) = 'ok', 'acompte encaissé');
select public._test_ok(public.appliquer_paiement('b0000000-0000-0000-0000-000000000001', 'TX1', 50000) = 'deja_traite', 'second webhook ignoré (idempotence)');
select public._test_ok((select etat from public.bookings where id = current_setting('t.bk')) = 'bloque', 'réservation bloquée');
select public._test_ok(public.montant_du(current_setting('t.bk'), 'solde') = 550000, 'solde = caution - acompte');

-- ===== 2. Rappels puis expiration du blocage =====
update public.bookings set bloc_debut = now() - interval '70 hours' where id = current_setting('t.bk');
select public.expirer();
select public._test_ok((select rappels from public.bookings where id = current_setting('t.bk')) @> '{6,24}', 'rappels 24 h et 6 h envoyés');
update public.bookings set bloc_debut = now() - interval '73 hours' where id = current_setting('t.bk');
select public.expirer();
select public._test_ok((select etat = 'expire' and fonds = 'a_rembourser' from public.bookings where id = current_setting('t.bk')), 'blocage expiré, acompte à rembourser');
select public._test_ok((select statut from public.listings where id = :LST) = 'disponible', 'logement remis en ligne');
select public._test_ok(exists (select 1 from public.payouts where booking_id = current_setting('t.bk') and kind = 'remboursement_locataire' and montant = 50000), 'remboursement programmé');
select public.payout_termine((select id from public.payouts where booking_id = current_setting('t.bk')), 'reussi', 'PT_REMB', null);
select public._test_ok((select fonds from public.bookings where id = current_setting('t.bk')) = 'rembourse', 'remboursement effectué');

-- ===== 3. Nouvelle réservation : caution complète, trop-perçu, contrat, clés =====
:en_loc
select set_config('t.bk2', (select id from public.reserver(:LST, 'Aminata Diallo', '77 000 11 22')), false);
:en_serveur
insert into public.payments (id, booking_id, kind, provider, amount, status, session_id) values
  ('b0000000-0000-0000-0000-000000000002', current_setting('t.bk2'), 'caution', 'simulateur', 600000, 'en_attente', 'sim_2'),
  ('b0000000-0000-0000-0000-000000000003', current_setting('t.bk2'), 'caution', 'simulateur', 600000, 'expire', 'sim_3');
select public.appliquer_paiement('b0000000-0000-0000-0000-000000000002', 'TX2', 600000);
select public._test_ok((select etat from public.bookings where id = current_setting('t.bk2')) = 'caution_payee', 'caution complète encaissée');
select public.appliquer_paiement('b0000000-0000-0000-0000-000000000003', 'TX3', 600000);
select public._test_ok(exists (select 1 from public.payouts where payment_id = 'b0000000-0000-0000-0000-000000000003' and montant = 600000), 'double paiement : trop-perçu remboursé');

:en_loc
select public.signer_contrat(current_setting('t.bk2'), repeat('s', 60));
:en_prop
select public.signer_contrat(current_setting('t.bk2'), repeat('p', 60));
:en_loc
select public.fixer_rdv(current_setting('t.bk2'), now() + interval '1 day');
select public.confirmer_cles(current_setting('t.bk2'));
:en_serveur
select public._test_ok((select etat = 'bail' and fonds = 'a_verser' from public.bookings where id = current_setting('t.bk2')), 'bail actif, caution à verser');
select public._test_ok(exists (select 1 from public.payouts where booking_id = current_setting('t.bk2') and kind = 'caution_proprio' and montant = 600000), 'versement de la caution programmé');
select public.payout_termine((select id from public.payouts where booking_id = current_setting('t.bk2') and kind = 'caution_proprio'), 'reussi', 'PT_CAU', null);
select public._test_ok((select fonds from public.bookings where id = current_setting('t.bk2')) = 'verse', 'caution versée au propriétaire');

-- ===== 4. Loyer =====
select set_config('t.mois', public.prochain_loyer(current_setting('t.bk2')), false);
select public._test_ok(current_setting('t.mois') = to_char(now(), 'YYYY-MM'), 'premier loyer = mois en cours');
insert into public.payments (id, booking_id, kind, mois, provider, amount, status, session_id)
  values ('b0000000-0000-0000-0000-000000000004', current_setting('t.bk2'), 'loyer', current_setting('t.mois'), 'simulateur',
          public.montant_du(current_setting('t.bk2'), 'loyer', current_setting('t.mois')), 'en_attente', 'sim_4');
select public.appliquer_paiement('b0000000-0000-0000-0000-000000000004', 'TX4', 200000);
select public._test_ok(exists (select 1 from public.loyers where booking_id = current_setting('t.bk2') and mois = current_setting('t.mois')), 'loyer enregistré (quittance)');
select public._test_ok(exists (select 1 from public.payouts where payment_id = 'b0000000-0000-0000-0000-000000000004' and kind = 'loyer_proprio'), 'loyer reversé au propriétaire');
do $$ begin
  perform public.montant_du(current_setting('t.bk2'), 'loyer', current_setting('t.mois'));
  raise exception 'ÉCHEC : un loyer déjà payé est encore exigible';
exception when raise_exception then
  if sqlerrm like 'ÉCHEC%' then raise; end if;
  raise notice 'OK un même loyer ne peut pas être payé deux fois (%)', sqlerrm;
end $$;

-- ===== 5. Fin de bail avec contestation et arbitrage =====
:en_loc
select public.donner_conge(current_setting('t.bk2'), current_date + 30);
:en_prop
select public.etat_des_lieux(current_setting('t.bk2'), 50000, 'Peinture du salon');
:en_loc
select public.repondre_edl(current_setting('t.bk2'), false, 'Déjà abîmé à l''entrée');
:en_adm
select public.arbitrer(current_setting('t.bk2'), 20000, 'Retenue partagée');
:en_prop
select public.declarer_restitution(current_setting('t.bk2'), 'T_REST01', 'Wave');
:en_loc
select public.confirmer_restitution(current_setting('t.bk2'));
:en_serveur
select public._test_ok((select etat from public.bookings where id = current_setting('t.bk2')) = 'clos', 'bail clôturé');
select public._test_ok((select statut from public.listings where id = :LST) = 'disponible', 'logement remis en location');

-- ===== 5 bis. Transfert manuel (comptes personnels) =====
:en_loc
select set_config('t.bk3', (select id from public.reserver(:LST, 'Aminata Diallo', '77 000 11 22')), false);
:en_serveur
insert into public.payments (id, booking_id, kind, provider, amount, status, session_id)
  values ('b0000000-0000-0000-0000-000000000005', current_setting('t.bk3'), 'acompte', 'transfert_om', 50000, 'en_attente', 'tr_5');
:en_loc
select public.declarer_transfert('b0000000-0000-0000-0000-000000000005', 'MP261121.1012.C55318', '77 000 11 22', 'Vous avez envoyé 50 000 FCFA');
do $$ begin
  perform public.valider_transfert('b0000000-0000-0000-0000-000000000005', true);
  raise exception 'ÉCHEC : un locataire peut valider son propre transfert';
exception when raise_exception then
  if sqlerrm like 'ÉCHEC%' then raise; end if;
  raise notice 'OK seul un gestionnaire valide un transfert (%)', sqlerrm;
end $$;
:en_serveur
-- Le délai de paiement est dépassé, mais le transfert déclaré suspend l'annulation
update public.bookings set attente_jusqua = now() - interval '1 minute' where id = current_setting('t.bk3');
select public.expirer();
select public._test_ok((select etat from public.bookings where id = current_setting('t.bk3')) = 'attente_paiement', 'transfert déclaré : la réservation n''est pas annulée pendant la vérification');
:en_adm
select set_config('t.val', public.valider_transfert('b0000000-0000-0000-0000-000000000005', true), false);
:en_serveur
select public._test_ok(current_setting('t.val') = 'ok' and (select etat from public.bookings where id = current_setting('t.bk3')) = 'bloque', 'transfert validé : logement bloqué');
select public._test_ok(exists (select 1 from public.notifications where audience = 'admin' and texte like 'Transfert de 50 000 FCFA%'), 'gestionnaire prévenu de la déclaration');

-- ===== 6. Confidentialité =====
:en_autre
select set_config('t.vus', (select count(*)::text from public.bookings), false);
select set_config('t.pay', (select count(*)::text from public.payments), false);
:en_serveur
select public._test_ok(current_setting('t.vus') = '0' and current_setting('t.pay') = '0', 'un tiers ne voit ni réservations ni paiements');

reset role;
rollback;
\echo 'Scénario terminé : toutes les vérifications sont passées.'
