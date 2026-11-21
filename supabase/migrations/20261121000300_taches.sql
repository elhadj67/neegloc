-- Neeg Loc : tâches planifiées (pg_cron, disponible sur Supabase).
-- Expiration des blocages et rappels toutes les 5 minutes, relances de loyer chaque matin.
-- Le serveur fait ce travail même quand personne n'a l'application ouverte.

create extension if not exists pg_cron;

select cron.schedule('neegloc-expirer',  '*/5 * * * *', $$select public.expirer()$$);
select cron.schedule('neegloc-relances', '0 9 * * *',   $$select public.relancer_loyers()$$);

-- La réconciliation des paiements et l'exécution des versements sont faites par la fonction
-- serveur « paiements-maintenance » ; voir README pour la planifier avec pg_net.
