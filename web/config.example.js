// Copier en config.js et remplir. La clé « anon » est publique par conception :
// la sécurité repose sur les règles d'accès de la base, pas sur le secret de cette clé.
window.NEEGLOC_CONFIG = {
  supabaseUrl: 'https://VOTRE-PROJET.supabase.co',
  supabaseAnonKey: 'VOTRE_CLE_ANON',
  // Doit correspondre à MOYENS_ACTIFS côté serveur
  // Tests avec comptes personnels : ['transfert_wave', 'transfert_om'] ; production : ['wave', 'orange_money']
  moyens: ['transfert_wave', 'transfert_om', 'simulateur'],
};
