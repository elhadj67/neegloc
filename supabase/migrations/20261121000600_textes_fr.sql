-- Dates et mois en toutes lettres dans les notifications.
-- Toutes les notifications passent par _notifier : on y convertit
--   « 2026-11 »             → « novembre 2026 »
--   « 24/11/2026 »          → « 24 novembre 2026 »  (« 1er » pour le premier du mois)
--   « à 18:51 »             → « à 18 h 51 »
-- sans toucher aux fonctions métier qui écrivent ces textes.

create function public.mois_fr(p_mois int) returns text
language sql immutable set search_path = public as $$
  select (array['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
                'septembre', 'octobre', 'novembre', 'décembre'])[p_mois]
$$;

create function public.texte_fr(p_texte text) returns text
language plpgsql immutable set search_path = public as $$
declare
  t text := p_texte;
  m text[];
  remplace text;
begin
  if t is null then return null; end if;
  -- Dates JJ/MM/AAAA
  loop
    m := regexp_match(t, '(\d{2})/(0[1-9]|1[0-2])/(\d{4})');
    exit when m is null;
    remplace := (m[1]::int)::text || case when m[1]::int = 1 then 'er' else '' end
                || ' ' || public.mois_fr(m[2]::int) || ' ' || m[3];
    t := overlay(t placing remplace from strpos(t, m[1] || '/' || m[2] || '/' || m[3]) for char_length(m[1] || '/' || m[2] || '/' || m[3]));
  end loop;
  -- Heures « à HH:MI »
  loop
    m := regexp_match(t, 'à (\d{2}):(\d{2})');
    exit when m is null;
    remplace := 'à ' || (m[1]::int)::text || ' h ' || m[2];
    t := overlay(t placing remplace from strpos(t, 'à ' || m[1] || ':' || m[2]) for char_length('à ' || m[1] || ':' || m[2]));
  end loop;
  -- Mois AAAA-MM (pas une date AAAA-MM-JJ)
  loop
    m := regexp_match(t, '(?<![\d-])(\d{4})-(0[1-9]|1[0-2])(?![-\d])');
    exit when m is null;
    remplace := public.mois_fr(m[2]::int) || ' ' || m[1];
    t := regexp_replace(t, '(?<![\d-])' || m[1] || '-' || m[2] || '(?![-\d])', remplace);
  end loop;
  return t;
end $$;

create or replace function public._notifier(p_user uuid, p_aud text, p_texte text, p_booking text, p_canal text default 'app')
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, audience, texte, booking_id, canal)
  values (p_user, p_aud, public.texte_fr(p_texte), p_booking, p_canal)
$$;

-- Notifications déjà enregistrées
update public.notifications set texte = public.texte_fr(texte) where texte is distinct from public.texte_fr(texte);

-- Fonctions internes : pas d'appel direct depuis l'application
revoke execute on function public.mois_fr(int), public.texte_fr(text) from public, anon, authenticated;
revoke execute on function public._notifier(uuid, text, text, text, text) from public, anon, authenticated;
