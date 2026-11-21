-- Mode test « transfert manuel » : paiement par transfert Wave / Orange Money vers un numéro
-- (personnel ou professionnel), déclaré par le locataire et validé par un gestionnaire.
-- Les nouvelles valeurs d'énumération sont dans un fichier à part : PostgreSQL interdit de les
-- utiliser dans la transaction qui les crée.

alter type public.provider_t add value if not exists 'transfert_wave';
alter type public.provider_t add value if not exists 'transfert_om';
