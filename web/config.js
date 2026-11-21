// Configuration du site (non versionnée). À compléter avec les valeurs du projet Supabase :
// Supabase > Project Settings > API > Project URL et clé « anon public ».
window.NEEGLOC_CONFIG = {
  supabaseUrl: 'https://dbhqscyhvcusddjamren.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRiaHFzY3lodmN1c2RkamFtcmVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUyNzY1NDgsImV4cCI6MjExMDg1MjU0OH0.DBOWnHua1LQrfbn1H_MbqpDVgqGgJmYuvRWqQEAGuQ4',
  // Transfert manuel (Wave et Orange Money, numéros dans les secrets Supabase) + simulateur pour tester sans argent
  moyens: ['transfert_wave', 'transfert_om', 'simulateur'],
};
