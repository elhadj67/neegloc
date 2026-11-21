/* Neeg Loc · application locataire, propriétaire et gestionnaire, branchée sur Supabase.
 * Les montants, les statuts et l'argent ne sont jamais décidés ici : tout passe par les
 * fonctions SQL (sb.rpc) et les fonctions serveur (paiements). La page ne fait qu'afficher. */
(() => {
'use strict';
const cfg = window.NEEGLOC_CONFIG;
const sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
NeegPay.init(sb, { moyens: cfg.moyens });
const PHOTO_BASE = `${cfg.supabaseUrl}/storage/v1/object/public/photos/`;
const MAX_PHOTOS = 8;
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');

/* ============ Mise en forme ============ */
const fmt = (n) => Math.round(n || 0).toLocaleString('fr-FR') + ' FCFA';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dfmt = (d, o) => new Date(d).toLocaleDateString('fr-FR', o || { day: 'numeric', month: 'long', year: 'numeric' });
const dtfmt = (d) => new Date(d).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const moisLabel = (k) => { const [a, m] = String(k).split('-'); return new Date(+a, +m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); };
const initiales = (n) => String(n || '?').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
const digits = (t) => String(t || '').replace(/\D/g, '');
const pl = (n, s, p) => `${n} ${n > 1 ? (p || s + 's') : s}`;
function left(ms) {
  if (ms <= 0) return 'expiré';
  const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
  return h >= 24 ? `${Math.floor(h / 24)} j ${h % 24} h` : h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}
const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;

const ERR = {
  identite_invalide: 'Indiquez votre nom complet et un numéro à 9 chiffres.',
  logement_indisponible: 'Ce logement vient d’être réservé par quelqu’un d’autre.',
  logement_introuvable: 'Ce logement n’existe plus.',
  propre_logement: 'Vous ne pouvez pas réserver votre propre logement.',
  non_authentifie: 'Connectez-vous pour continuer.',
  acces_refuse: 'Action non autorisée pour votre compte.',
  signature_invalide: 'Signature trop courte : tracez-la à nouveau.',
  date_passee: 'Choisissez une date à venir.',
  reference_invalide: 'Recopiez l’identifiant complet de la transaction.',
  rien_a_valider: 'Ce transfert a déjà été traité.',
  annonce_non_modifiable: 'Cette annonce ne peut pas être modifiée maintenant (réservée ou louée).',
  'Invalid login credentials': 'E-mail ou mot de passe incorrect.',
  'Email not confirmed': 'Confirmez d’abord votre adresse e-mail (lien reçu par e-mail).',
  'User already registered': 'Un compte existe déjà avec cet e-mail : connectez-vous.',
  'Password should be at least': 'Choisissez un mot de passe d’au moins 8 caractères.',
};
function errMsg(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  const k = Object.keys(ERR).find((k) => m.includes(k));
  return k ? ERR[k] : m;
}
async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) { toast(errMsg(error)); throw error; }
  return data;
}

/* ============ Libellés ============ */
const LIB = {
  kind: { acompte: 'Acompte', caution: 'Caution', solde: 'Solde de caution', loyer: 'Loyer' },
  statut: { cree: 'Créé', en_attente: 'En attente', reussi: 'Payé', echoue: 'Échoué', expire: 'Expiré', rembourse: 'Remboursé' },
  moyen: { wave: 'Wave', orange_money: 'Orange Money', simulateur: 'Simulateur (test)', transfert_wave: 'Wave (transfert)', transfert_om: 'Orange Money (transfert)' },
  versement: { caution_proprio: 'Caution au propriétaire', loyer_proprio: 'Loyer au propriétaire', remboursement_locataire: 'Remboursement au locataire' },
  vstatut: { a_faire: 'À faire', en_cours: 'En cours', reussi: 'Effectué', echoue: 'Échoué', manuel: 'Fait à la main' },
  canal: { sms: 'SMS', whatsapp: 'WhatsApp', email: 'e-mail' },
  role: { locataire: 'Locataire', proprietaire: 'Propriétaire', admin: 'Gestionnaire' },
};
const lib = (g, v) => esc(LIB[g]?.[v] ?? v);
const statutPill = (s) => ({
  disponible: '<span class="pill p-ok">Disponible</span>', bloque: '<span class="pill p-warn">Réservé</span>',
  suspendu: '<span class="pill p-mute">Suspendu</span>', loue: '<span class="pill p-info">Loué</span>',
}[s] || '');

/* ============ État ============ */
const S = { params: { caution_mois: 3, acompte_taux: 0.25, blocage_heures: 72, loyer_jour: 5, preavis_mois: 1 }, listings: [], bookings: [], payouts: [], notifs: [], ready: false };
let ME = null, PROFIL = null;
const isAdmin = () => PROFIL?.role === 'admin';
const L = (id) => S.listings.find((l) => l.id === id);
const B = (id) => S.bookings.find((b) => b.id === id);
const lg = (b) => L(b.listing_id) || { id: b.listing_id, titre: 'Logement', type: '', quartier: '', ville: '', photos: [], surface: null, pieces: 1, meuble: false, owner_id: null };
const caution = (l) => l.loyer * S.params.caution_mois;
const acompte = (l) => Math.round((l.loyer * S.params.acompte_taux) / 500) * 500;
const paid = (b) => (b.payments || []).filter((p) => p.status === 'reussi' && p.kind !== 'loyer').reduce((a, p) => a + p.amount, 0);
const enVerif = (b) => (b.payments || []).find((p) => p.status === 'en_attente' && p.declare_le);
const expOf = (b) => new Date(b.bloc_debut).getTime() + (S.params.blocage_heures + (b.prolong_h || 0)) * 3600e3;
const isOwner = (b) => ME && lg(b).owner_id === ME.id;
const isTenant = (b) => ME && b.locataire_id === ME.id;

async function load() {
  const q = [
    sb.from('parametres').select('*').maybeSingle(),
    sb.from('listings').select('*').order('created_at', { ascending: false }),
  ];
  if (ME) {
    q.push(
      sb.from('profiles').select('*').eq('id', ME.id).maybeSingle(),
      sb.from('bookings').select('*, payments(*), loyers(*)').order('created_at', { ascending: false }),
      sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(150),
      sb.from('payouts').select('*').order('created_at', { ascending: false }),
    );
  }
  const r = await Promise.all(q);
  if (r[0].data) S.params = r[0].data;
  S.listings = r[1].data || [];
  if (ME) {
    PROFIL = r[2].data;
    S.bookings = r[3].data || []; S.notifs = r[4].data || []; S.payouts = r[5].data || [];
    // Téléphone saisi à l'inscription : recopié dans le profil au premier passage
    const t = ME.user_metadata?.tel;
    if (PROFIL && !PROFIL.tel && t) { await sb.from('profiles').update({ tel: t }).eq('id', ME.id); PROFIL.tel = t; }
  } else { PROFIL = null; S.bookings = []; S.notifs = []; S.payouts = []; }
  S.ready = true;
}
let rlT = null;
function reload() { clearTimeout(rlT); rlT = setTimeout(async () => { await load(); refresh(); }, 250); }

let chan = null;
function subscribe() {
  if (chan) { sb.removeChannel(chan); chan = null; }
  if (!ME) return;
  chan = sb.channel('neegloc-' + ME.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, reload)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, reload)
    .subscribe();
}

/* Rafraîchit l'affichage sans perdre une saisie en cours */
let rT = null, held = false;
const typing = () => { const a = document.activeElement; return !!a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
function refresh() {
  clearTimeout(rT);
  rT = setTimeout(() => { if (typing() || !$('#overlay').hidden) { held = true; return; } held = false; route(false); }, 60);
}
document.addEventListener('focusout', () => setTimeout(() => { if (held && !typing()) refresh(); }, 0));

/* ============ Photos ============ */
const photoUrl = (p) => (!p ? null : /^https?:/.test(p) ? p : PHOTO_BASE + p.split('/').map(encodeURIComponent).join('/'));
function hue(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function art(l, variant = 0) {
  const h = (hue(l.id) + variant * 18) % 360, g = 'g' + Math.random().toString(36).slice(2, 8);
  let scene;
  if (variant === 1) {
    scene = `<rect x="0" y="190" width="400" height="110" fill="hsl(${h},18%,38%)" opacity=".35"/><rect x="60" y="150" width="200" height="60" rx="14" fill="hsl(${h},30%,32%)"/><rect x="60" y="130" width="200" height="34" rx="12" fill="hsl(${h},30%,40%)"/><rect x="290" y="60" width="70" height="100" rx="4" fill="hsl(${h},50%,92%)" opacity=".8"/><circle cx="320" cy="230" r="22" fill="hsl(${(h + 120) % 360},35%,35%)"/>`;
  } else if (variant === 2) {
    scene = `<rect x="0" y="200" width="400" height="100" fill="hsl(${h},18%,38%)" opacity=".3"/><rect x="80" y="150" width="240" height="70" rx="10" fill="hsl(${h},20%,95%)"/><rect x="80" y="110" width="240" height="50" rx="10" fill="hsl(${h},30%,35%)"/><rect x="160" y="40" width="80" height="50" rx="4" fill="hsl(${h},50%,92%)" opacity=".7"/>`;
  } else if (l.type === 'Chambre') {
    scene = `<rect x="110" y="110" width="180" height="150" fill="hsl(${h},25%,96%)"/><path d="M95 115 L200 50 L305 115 Z" fill="hsl(${h},35%,30%)"/><rect x="135" y="140" width="50" height="45" rx="3" fill="hsl(${h},45%,70%)"/><rect x="215" y="140" width="50" height="45" rx="3" fill="hsl(${h},45%,70%)"/><rect x="180" y="205" width="40" height="55" rx="3" fill="hsl(${h},35%,30%)"/><circle cx="70" cy="230" r="34" fill="hsl(${(h + 110) % 360},30%,34%)"/>`;
  } else {
    const floors = l.type === 'Studio' || l.type === 'Chambre' ? 3 : 5;
    let win = '';
    for (let f = 0; f < floors; f++) for (let c = 0; c < 4; c++) win += `<rect x="${128 + c * 38}" y="${235 - (f + 1) * 36}" width="24" height="22" rx="2" fill="hsl(${h},45%,${(f + c) % 3 ? 72 : 85}%)"/>`;
    scene = `<rect x="110" y="${250 - floors * 36 - 10}" width="180" height="${floors * 36 + 10}" fill="hsl(${h},20%,96%)"/><rect x="104" y="${250 - floors * 36 - 18}" width="192" height="10" fill="hsl(${h},35%,30%)"/>${win}<rect x="185" y="226" width="30" height="24" fill="hsl(${h},35%,30%)"/><rect x="20" y="170" width="70" height="80" fill="hsl(${h},15%,88%)" opacity=".6"/><rect x="310" y="150" width="70" height="100" fill="hsl(${h},15%,88%)" opacity=".6"/>`;
  }
  return `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${h},45%,84%)"/><stop offset="1" stop-color="hsl(${(h + 25) % 360},38%,66%)"/></linearGradient></defs><rect width="400" height="300" fill="url(#${g})"/><circle cx="330" cy="60" r="26" fill="#fff" opacity=".55"/>${scene}</svg>`;
}
const picRef = (p, l, v = 0, lazy = true) => (p ? `<img class="ph-img" src="${esc(photoUrl(p))}" alt=""${lazy ? ' loading="lazy"' : ''}>` : art(l, v % 3));
const pic = (l) => picRef((l.photos || [])[0], l, 0);

async function toJpeg(file, max = 1600, q = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas');
    c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('image'))), 'image/jpeg', q));
  } finally { URL.revokeObjectURL(url); }
}
async function uploadPhoto(file) {
  const blob = await toJpeg(file);
  const path = `${ME.id}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from('photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return path;
}
async function uploadVideo(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('Vidéo trop lourde (20 Mo maximum)');
  const ext = /webm/i.test(file.type) ? 'webm' : 'mp4';
  const path = `${ME.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('photos').upload(path, file, { contentType: ext === 'webm' ? 'video/webm' : 'video/mp4' });
  if (error) throw error;
  return path;
}
const dropFile = (p) => { if (p && ME && p.startsWith(ME.id + '/')) sb.storage.from('photos').remove([p]).catch(() => {}); };

/* ============ Étapes d'une réservation ============ */
const STEPS = ['Acompte', 'Caution', 'Contrat', 'Rendez-vous', 'Clés'];
function stepOf(b) {
  if (b.etat === 'expire' || b.etat === 'annule') return 0;
  if (b.etat === 'attente_paiement' || b.etat === 'bloque') return 1;
  if (b.etat === 'caution_payee') return !(b.sign_loc && b.sign_prop) ? 2 : !b.rdv_date ? 3 : 4;
  return 5;
}
function stepper(b) {
  const s = stepOf(b);
  if (!s) return '';
  return `<div class="steps">${STEPS.map((n, i) => {
    const done = i === 0 ? (b.etat !== 'attente_paiement' || s >= 2) : i < s;
    return `<div class="st ${done ? 'done' : i === s ? 'now' : ''}"><i></i><span>${n}</span></div>`;
  }).join('')}</div>`;
}
const FIN_PILL = {
  preavis: '<span class="pill p-warn">Congé donné</span>', edl: '<span class="pill p-info">État des lieux à valider</span>',
  conteste: '<span class="pill p-warn">Retenue contestée</span>', accepte: '<span class="pill p-info">Caution à restituer</span>',
  rembourse: '<span class="pill p-info">Restitution à confirmer</span>', clos: '<span class="pill p-mute">Bail clôturé</span>',
};
function stagePill(b) {
  if (b.etat === 'expire') return '<span class="pill p-mute">Blocage expiré</span>';
  if (b.etat === 'annule') return '<span class="pill p-mute">Annulée</span>';
  if (enVerif(b)) return '<span class="pill p-warn">Paiement en vérification</span>';
  if (b.etat === 'attente_paiement') return '<span class="pill p-warn">Paiement attendu</span>';
  if (b.etat === 'bloque') return `<span class="pill p-warn">Réservé · reste <span data-exp="${expOf(b)}">${left(expOf(b) - Date.now())}</span></span>`;
  if (b.etat === 'caution_payee') return ['', '', '<span class="pill p-info">Contrat à signer</span>', '<span class="pill p-info">Rendez-vous à fixer</span>', '<span class="pill p-info">Remise des clés prévue</span>'][stepOf(b)];
  if (b.fin?.etape) return FIN_PILL[b.fin.etape] || '';
  if (b.fonds === 'a_verser') return '<span class="pill p-info">Bail en cours · caution en versement</span>';
  return '<span class="pill p-ok">Bail en cours</span>';
}

/* ============ Navigation ============ */
const IC = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};
const SPACES = {
  loc: { tag: '', aud: 'locataire', tabs: [['annonces', 'Annonces', IC.home], ['locations', 'Mes locations', IC.cal], ['alertes', 'Alertes', IC.bell]] },
  pro: { tag: 'Pro', aud: 'proprietaire', tabs: [['dashboard', 'Accueil', IC.chart], ['reservations', 'Réservations', IC.cal], ['logements', 'Logements', IC.home], ['alertes', 'Alertes', IC.bell]] },
  adm: { tag: 'Admin', aud: 'admin', tabs: [['overview', 'Vue d’ensemble', IC.chart], ['paiements', 'Paiements', IC.list], ['reservations', 'Réservations', IC.cal], ['annonces', 'Annonces', IC.home], ['journal', 'Journal', IC.list]] },
};
let space = null;
const filter = { type: 'Tous', ville: 'Toutes' };
const loadingHTML = '<div class="loading"><div class="spinner"></div><div>Chargement…</div></div>';
function go(h) { if (location.hash === '#' + h || (!h && !location.hash)) route(); else location.hash = h; }
window.addEventListener('hashchange', () => route(true));
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go]');
  if (!t) return;
  e.preventDefault();
  $('#drawer').hidden = true;
  go(t.dataset.go);
});

function header() {
  const btn = $('#accountBtn');
  btn.innerHTML = ME ? `<span class="av">${esc(initiales(PROFIL?.nom || ME.email))}</span><span class="lbl">${esc((PROFIL?.nom || ME.email).split(' ')[0])}</span>` : 'Se connecter';
  $('#bellBtn').hidden = !ME || !space;
  updateBell();
}

function route(scroll = true) {
  const h = location.hash.slice(1);
  const m = h.match(/^(loc|pro|adm)-(.+)$/);
  const tabs = $('#tabs'), bottom = $('#bottom'), tag = $('#spaceTag');
  if (!m) {
    space = null; document.body.dataset.space = '';
    tabs.innerHTML = ''; bottom.innerHTML = ''; tag.hidden = true;
    const sw = $('#switchBtn'); sw.hidden = h === 'espaces'; sw.textContent = 'Espace propriétaire'; sw.dataset.go = 'pro-dashboard';
    $('#brand').setAttribute('href', '#');
    header(); if (h === 'espaces') renderPortal(); else renderHome(); if (scroll) scrollTo(0, 0); return;
  }
  space = m[1];
  const sec = m[2], sp = SPACES[space];
  document.body.dataset.space = space;
  tag.hidden = !sp.tag; tag.textContent = sp.tag;
  { const sw = $('#switchBtn'); sw.hidden = false; sw.textContent = 'Changer d’espace'; sw.dataset.go = 'espaces'; }
  $('#brand').setAttribute('href', '#' + space + '-' + sp.tabs[0][0]);
  const cur = sec.startsWith('annonce-') ? 'annonces' : sec;
  tabs.innerHTML = sp.tabs.map(([id, lab]) => `<button class="tab" data-go="${space}-${id}" ${id === cur ? 'aria-current="page"' : ''}>${lab}</button>`).join('');
  bottom.innerHTML = sp.tabs.map(([id, lab, ic]) => `<button data-go="${space}-${id}" ${id === cur ? 'aria-current="page"' : ''}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ic}</svg>${lab}</button>`).join('');
  header();
  if (!S.ready) { app.innerHTML = loadingHTML; return; }
  if (space === 'loc' && (sec === 'annonces' || sec.startsWith('annonce-'))) {
    const l = sec.startsWith('annonce-') && L(sec.slice(8));
    if (l) renderDetail(l); else renderListings();
  } else if (!ME) {
    renderNeedLogin();
  } else if (space === 'loc') {
    if (sec === 'alertes') renderAlerts(); else renderLocations();
  } else if (space === 'pro') {
    if (sec === 'alertes') renderAlerts(); else renderOwner(['dashboard', 'reservations', 'logements'].includes(sec) ? sec : 'dashboard');
  } else if (!isAdmin()) {
    app.innerHTML = `<div class="box empty" style="max-width:560px;margin:24px auto"><h2>Espace réservé au gestionnaire</h2>
      <p class="muted">La vérification des paiements, les versements et l’arbitrage des litiges sont réservés aux gestionnaires de Neeg Loc.</p>
      <button class="btn btn-primary" data-go="">Retour à l’accueil</button></div>`;
  } else {
    renderAdmin(['overview', 'paiements', 'reservations', 'annonces', 'journal'].includes(sec) ? sec : 'overview');
  }
  if (scroll) scrollTo(0, 0);
}

/* ============ Accueil ============ */
function heroArt() {
  return `<svg viewBox="0 0 560 420" role="img" aria-label="Maison au Sénégal sous le soleil, avec un baobab" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="hsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FCE3B0"/><stop offset=".6" stop-color="#F8C98A"/><stop offset="1" stop-color="#F3B26E"/></linearGradient>
      <linearGradient id="hsea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3C8FB0"/><stop offset="1" stop-color="#2A6F8C"/></linearGradient>
      <linearGradient id="hsand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EBCF9C"/><stop offset="1" stop-color="#DDB97C"/></linearGradient>
    </defs>
    <rect width="560" height="420" fill="url(#hsky)"/>
    <circle cx="410" cy="120" r="62" fill="#FFB300" opacity=".95"/><circle cx="410" cy="120" r="88" fill="#FFB300" opacity=".18"/>
    <path d="M300 74 q8 -7 16 0 q8 -7 16 0" fill="none" stroke="#5B3A1A" stroke-width="3" stroke-linecap="round"/>
    <path d="M345 96 q6 -5 12 0 q6 -5 12 0" fill="none" stroke="#5B3A1A" stroke-width="2.5" stroke-linecap="round"/>
    <rect y="262" width="560" height="44" fill="url(#hsea)"/>
    <path d="M0 270 q40 -6 80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="2"/>
    <path d="M0 300 C120 286 260 292 560 300 V420 H0 Z" fill="url(#hsand)"/>
    <path d="M96 300 C100 250 104 220 96 190 L122 190 C116 222 118 254 124 300 Z" fill="#6B4423"/>
    <path d="M100 196 C70 180 40 186 26 172 M110 192 C110 168 96 150 84 140 M116 194 C140 172 168 174 186 160 M106 192 C122 160 140 150 150 136" stroke="#6B4423" stroke-width="7" stroke-linecap="round" fill="none"/>
    <ellipse cx="44" cy="160" rx="40" ry="16" fill="#4F7A2A"/><ellipse cx="96" cy="132" rx="44" ry="18" fill="#5E8C33"/><ellipse cx="164" cy="146" rx="44" ry="17" fill="#4F7A2A"/>
    <rect x="240" y="196" width="220" height="122" rx="6" fill="#FFFDF7"/>
    <path d="M226 204 L350 120 L474 204 Z" fill="#0B5A32"/><path d="M226 204 L350 120 L360 127 L244 206 Z" fill="#0E7040"/>
    <rect x="262" y="224" width="52" height="44" rx="4" fill="#F7C548"/><path d="M288 224 V268 M262 246 H314" stroke="#E0A81C" stroke-width="3"/>
    <rect x="386" y="224" width="52" height="44" rx="4" fill="#F7C548"/><path d="M412 224 V268 M386 246 H438" stroke="#E0A81C" stroke-width="3"/>
    <rect x="330" y="240" width="42" height="78" rx="4" fill="#C8102E"/><circle cx="363" cy="282" r="3" fill="#FCE3B0"/>
    <rect x="236" y="314" width="228" height="8" rx="3" fill="#C9A66B"/>
    <path d="M150 352 C230 330 330 334 430 352" stroke="#00853F" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M150 364 C230 342 330 346 430 364" stroke="#FDEF42" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M150 376 C230 354 330 358 430 376" stroke="#E31B23" stroke-width="7" fill="none" stroke-linecap="round"/>
  </svg>`;
}
const STEP_IC = {
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
};
const ico = (p) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
function renderHome() {
  const dispo = S.listings.filter((l) => l.statut === 'disponible');
  const vitrine = [...dispo, ...S.listings.filter((l) => l.statut !== 'disponible' && l.statut !== 'suspendu')].slice(0, 6);
  const villes = [...new Set(S.listings.map((l) => l.ville))];
  const carte = (l) => `<a class="card" href="#loc-annonce-${esc(l.id)}" data-go="loc-annonce-${esc(l.id)}" style="text-decoration:none;color:inherit">
      <div class="art">${pic(l)}${statutPill(l.statut)}</div>
      <div class="card-b"><div class="price">${fmt(l.loyer)} <small>/ mois</small></div><div class="card-t">${esc(l.titre)}</div>
      <div class="meta"><span>${esc(l.quartier)}, ${esc(l.ville)}</span><span>${l.meuble ? 'Meublé' : 'Vide'}</span></div></div></a>`;
  app.innerHTML = `
  <section class="home-hero">
    <div class="home-txt">
      <div class="eyebrow">Location immobilière au Sénégal</div>
      <h1>Trouvez votre logement, payez en toute sécurité</h1>
      <p>Chambres, studios, appartements et villas. Réservez avec un acompte, payez par Wave ou Orange Money.</p>
      <form class="search" id="homeSearch">
        <select class="input" id="hVille" aria-label="Ville"><option value="Toutes">Toutes les villes</option>${villes.map((v) => `<option>${esc(v)}</option>`).join('')}</select>
        <select class="input" id="hType" aria-label="Type"><option value="Tous">Tous les logements</option>${['Chambre', 'Studio', 'Appartement', 'Villa'].map((t) => `<option>${t}</option>`).join('')}</select>
        <button class="btn btn-red" type="submit">Rechercher</button>
      </form>
    </div>
    <div class="home-art">${heroArt()}</div>
  </section>

  <section class="home-sec">
    <div class="section-h"><h2 class="h2" style="margin:0">Logements disponibles</h2><a class="btn btn-ghost btn-sm" href="#loc-annonces" data-go="loc-annonces">Voir toutes les annonces</a></div>
    ${vitrine.length ? `<div class="grid">${vitrine.map(carte).join('')}</div>` : '<div class="box empty"><h2>Les premières annonces arrivent</h2><p class="muted">Vous êtes propriétaire ? Publiez votre logement, il apparaîtra ici.</p></div>'}
  </section>

  <section class="home-sec">
    <h2 class="h2">Comment ça marche</h2>
    <div class="how">
      <div class="how-c"><span class="how-i">${ico(STEP_IC.shield)}</span><b>1. Réservez</b><p>Bloquez le logement ${S.params.blocage_heures} h avec un acompte, déduit de la caution.</p></div>
      <div class="how-c"><span class="how-i">${ico(STEP_IC.phone)}</span><b>2. Payez par mobile</b><p>Caution par Wave ou Orange Money, gardée par Neeg Loc jusqu’aux clés.</p></div>
      <div class="how-c"><span class="how-i">${ico(STEP_IC.key)}</span><b>3. Recevez vos clés</b><p>Contrat signé en ligne, puis loyers et quittances dans l’appli.</p></div>
    </div>
  </section>

  <section class="home-pro">
    <div><div class="eyebrow" style="color:#F7C548">Neeg Loc Pro</div><h2>Vous êtes propriétaire ?</h2><p>Publiez votre logement avec ses photos. Neeg Loc s’occupe des paiements, du contrat et des loyers.</p>
      <button class="btn btn-gold" data-go="pro-dashboard">Publier mon logement</button></div>
    <div class="home-pro-art">${art({ id: 'vitrine-pro', type: 'Appartement' })}</div>
  </section>
  ${isAdmin() ? '<p class="center" style="margin-top:22px"><a href="#adm-overview" data-go="adm-overview">Espace gestionnaire →</a></p>' : ''}`;
  $('#homeSearch').onsubmit = (e) => { e.preventDefault(); filter.ville = $('#hVille').value; filter.type = $('#hType').value; go('loc-annonces'); };
}

function renderPortal() {
  const adm = isAdmin() ? `<div class="space" style="--c:#2B2622"><div class="eyebrow" style="color:#8A6A2E">Neeg Loc Admin</div><h2>Gestionnaire</h2>
      <ul><li>Vérification des paiements, fonds en séquestre</li><li>Versements, remboursements et litiges de fin de bail</li><li>Modération des annonces, journal des envois</li></ul>
      <button class="btn" data-go="adm-overview">Ouvrir l’espace gestionnaire</button></div>` : '';
  app.innerHTML = `<div class="portal">
    <img class="logo-lg" src="logo.png" alt="Neeg Loc, location immobilière au Sénégal">
    <h1>Louez en toute confiance au Sénégal</h1>
    <p class="lead">Réservez un logement avec un acompte, payez la caution par Wave ou Orange Money : Neeg Loc garde les fonds jusqu’à la remise des clés, puis suit vos loyers et vos quittances.</p>
    <div class="spaces">
      <div class="space" style="--c:#0B5A32"><div class="eyebrow" style="color:#0B5A32">Application</div><h2>Locataire</h2>
        <ul><li>Annonces avec photos</li><li>Acompte ou caution par Wave et Orange Money</li><li>Contrat signé en ligne, clés, loyers et quittances</li></ul>
        <button class="btn" data-go="loc-annonces">Voir les annonces</button></div>
      <div class="space" style="--c:#1E3A5F"><div class="eyebrow" style="color:#1E3A5F">Neeg Loc Pro</div><h2>Propriétaire</h2>
        <ul><li>Publication des logements et photos</li><li>Réservations, contrats, cautions et loyers reçus</li><li>État des lieux et fin de bail</li></ul>
        <button class="btn" data-go="pro-dashboard">Ouvrir l’espace propriétaire</button></div>
      ${adm}
    </div></div>`;
}
function renderNeedLogin() {
  app.innerHTML = `<div class="box empty" style="max-width:520px;margin:24px auto">
    <h2>${space === 'pro' ? 'Neeg Loc Pro' : 'Votre espace'}</h2>
    <p class="muted">Connectez-vous ou créez un compte gratuit pour ${space === 'pro' ? 'publier vos logements et suivre vos locations' : 'suivre vos réservations, vos loyers et vos quittances'}.</p>
    <button class="btn btn-primary" id="needLogin">Se connecter</button></div>`;
  $('#needLogin').onclick = () => openAuth();
}

/* ============ Connexion ============ */
function openAuth(raison) {
  let mode = 'in';
  const draw = (msg = '') => {
    openModal(`<div class="m-h"><h2>${mode === 'in' ? 'Connexion' : 'Créer un compte'}</h2><button class="x" aria-label="Fermer">×</button></div>
    <div class="m-b">${raison ? `<p class="muted" style="margin-top:0">${esc(raison)}</p>` : ''}
      <div class="seg" role="group"><button data-mode="in" aria-pressed="${mode === 'in'}">J’ai un compte</button><button data-mode="up" aria-pressed="${mode === 'up'}">Nouveau compte</button></div>
      <form id="authF" novalidate>
        ${mode === 'up' ? `<div class="form-grid"><div class="field"><label for="aNom">Nom complet</label><input class="input" id="aNom" autocomplete="name" placeholder="Ex. Aminata Diallo"></div>
          <div class="field"><label for="aTel">Téléphone</label><input class="input" id="aTel" inputmode="tel" autocomplete="tel" placeholder="77 000 00 00"></div></div>` : ''}
        <div class="field"><label for="aEm">E-mail</label><input class="input" id="aEm" type="email" autocomplete="email"></div>
        <div class="field"><label for="aPw">Mot de passe</label><input class="input" id="aPw" type="password" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}" placeholder="${mode === 'up' ? '8 caractères minimum' : ''}"></div>
        <p class="err" id="aErr">${esc(msg)}</p>
        <button class="btn btn-primary btn-block" type="submit" id="aGo">${mode === 'in' ? 'Se connecter' : 'Créer mon compte'}</button>
      </form></div>`);
    $('#modal').querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { mode = b.dataset.mode; draw(); }));
    $('#authF').onsubmit = async (e) => {
      e.preventDefault();
      const email = $('#aEm').value.trim(), password = $('#aPw').value, err = $('#aErr'), btn = $('#aGo');
      if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Indiquez une adresse e-mail valide.'; return; }
      if (password.length < 8) { err.textContent = 'Le mot de passe doit faire au moins 8 caractères.'; return; }
      btn.disabled = true;
      if (mode === 'in') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) { btn.disabled = false; err.textContent = errMsg(error); return; }
        closeModal(); toast('Bienvenue sur Neeg Loc');
      } else {
        const nom = $('#aNom').value.trim(), tel = $('#aTel').value.trim();
        if (nom.length < 3) { btn.disabled = false; err.textContent = 'Indiquez votre nom complet.'; return; }
        if (digits(tel).length < 9) { btn.disabled = false; err.textContent = 'Indiquez un numéro à 9 chiffres.'; return; }
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { nom, tel }, emailRedirectTo: location.href.split('#')[0] } });
        if (error) { btn.disabled = false; err.textContent = errMsg(error); return; }
        if (!data.session) {
          openModal(`<div class="m-b center" style="padding-top:30px"><div class="success">✉</div><h2>Confirmez votre e-mail</h2>
            <p class="muted" style="max-width:40ch;margin:10px auto 18px">Un lien de confirmation a été envoyé à <b>${esc(email)}</b>. Cliquez dessus puis connectez-vous.</p>
            <button class="btn btn-primary btn-block" id="okMail">Compris</button></div>`);
          $('#okMail').onclick = closeModal;
        } else { closeModal(); toast('Compte créé, bienvenue !'); }
      }
    };
  };
  draw();
}
function openAccount() {
  if (!ME) return openAuth();
  openModal(`<div class="m-h"><h2>Mon compte</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><p class="muted" style="margin-top:0">${esc(ME.email)} · ${lib('role', PROFIL?.role || 'locataire')}</p>
    <form id="profF"><div class="form-grid">
      <div class="field"><label for="pNom">Nom complet</label><input class="input" id="pNom" value="${esc(PROFIL?.nom)}" autocomplete="name"></div>
      <div class="field"><label for="pTel">Téléphone Wave / Orange Money</label><input class="input" id="pTel" value="${esc(PROFIL?.tel)}" inputmode="tel"></div></div>
      <p class="hint" style="margin-top:-4px">Ce numéro reçoit vos remboursements et, si vous êtes propriétaire, vos cautions et loyers.</p>
      <p class="err" id="pErr"></p>
      <div style="display:flex;gap:10px"><button class="btn btn-primary" style="flex:1" type="submit">Enregistrer</button><button class="btn btn-ghost" type="button" id="logout">Se déconnecter</button></div>
    </form></div>`);
  $('#profF').onsubmit = async (e) => {
    e.preventDefault();
    const nom = $('#pNom').value.trim(), tel = $('#pTel').value.trim();
    if (nom.length < 3 || digits(tel).length < 9) { $('#pErr').textContent = 'Nom complet et numéro à 9 chiffres requis.'; return; }
    const { error } = await sb.from('profiles').update({ nom, tel }).eq('id', ME.id);
    if (error) { $('#pErr').textContent = errMsg(error); return; }
    PROFIL = { ...PROFIL, nom, tel }; closeModal(); toast('Profil enregistré'); header(); reload();
  };
  $('#logout').onclick = async () => { closeModal(); await sb.auth.signOut(); toast('À bientôt'); go(''); };
}
$('#accountBtn').onclick = openAccount;

/** Nom et téléphone sont nécessaires pour réserver ou publier. */
function ensureIdentity(pourquoi) {
  if (PROFIL && PROFIL.nom.trim().length >= 3 && digits(PROFIL.tel).length >= 9) return Promise.resolve(true);
  return new Promise((resolve) => {
    openModal(`<div class="m-h"><h2>Vos coordonnées</h2><button class="x" aria-label="Fermer">×</button></div>
    <div class="m-b"><p class="muted" style="margin-top:0">${esc(pourquoi)}</p>
      <form id="idF"><div class="form-grid">
        <div class="field"><label for="iNom">Nom complet</label><input class="input" id="iNom" value="${esc(PROFIL?.nom)}" autocomplete="name"></div>
        <div class="field"><label for="iTel">Téléphone Wave / Orange Money</label><input class="input" id="iTel" value="${esc(PROFIL?.tel)}" inputmode="tel" placeholder="77 000 00 00"></div></div>
        <p class="err" id="iErr"></p><button class="btn btn-primary btn-block" type="submit">Continuer</button></form></div>`, false, () => resolve(false));
    $('#idF').onsubmit = async (e) => {
      e.preventDefault();
      const nom = $('#iNom').value.trim(), tel = $('#iTel').value.trim();
      if (nom.length < 3 || digits(tel).length < 9) { $('#iErr').textContent = 'Nom complet et numéro à 9 chiffres requis.'; return; }
      const { error } = await sb.from('profiles').update({ nom, tel }).eq('id', ME.id);
      if (error) { $('#iErr').textContent = errMsg(error); return; }
      PROFIL = { ...PROFIL, nom, tel }; closeModal(true); resolve(true);
    };
  });
}

/* ============ Notifications ============ */
const SEEN_KEY = 'neegloc-vu-admin';
const seenAdmin = () => { try { return +localStorage.getItem(SEEN_KEY) || 0; } catch { return 0; } };
function myNotifs() {
  const aud = SPACES[space]?.aud;
  return S.notifs.filter((n) => !aud || n.audience === aud);
}
const isNew = (n) => (n.user_id ? !n.lu_le : new Date(n.created_at).getTime() > seenAdmin());
function updateBell() {
  const n = ME && space ? myNotifs().filter(isNew).length : 0, d = $('#bellDot');
  d.hidden = !n; d.textContent = n > 99 ? '99+' : n;
}
async function markSeen() {
  if (space === 'adm') { try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* navigation privée */ } }
  if (myNotifs().some((n) => n.user_id && !n.lu_le)) {
    await sb.rpc('notifs_lues');
    S.notifs.forEach((n) => { if (n.user_id === ME.id && !n.lu_le) n.lu_le = new Date().toISOString(); });
  }
  updateBell();
}
const CH = { sms: 'SMS', whatsapp: 'WA', email: '@', app: 'NL' };
function notifHTML(n) {
  return `<div class="notif ${isNew(n) ? 'new' : ''}"><span class="ch">${CH[n.canal] || 'NL'}</span><div><p>${esc(n.texte)}</p>
    <small>${new Date(n.created_at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${LIB.canal[n.canal] ? ` · envoi par ${LIB.canal[n.canal]} pas encore activé` : ''}</small></div></div>`;
}
function renderAlerts() {
  const list = myNotifs();
  app.innerHTML = `<div class="section-h"><div><div class="eyebrow">${space === 'loc' ? 'Espace locataire' : 'Neeg Loc Pro'}</div><h1>Alertes</h1></div></div>
    <div class="box" style="padding:0">${list.map(notifHTML).join('') || '<p class="muted" style="padding:18px;margin:0">Aucune alerte pour le moment.</p>'}</div>`;
  markSeen();
}
$('#bellBtn').onclick = () => {
  const d = $('#drawer');
  d.innerHTML = `<div class="m-h" style="padding-bottom:14px;border-bottom:1px solid var(--line)"><h2 style="font-size:20px">${space === 'adm' ? 'Notifications gestionnaire' : 'Mes notifications'}</h2><button class="x" id="dClose" aria-label="Fermer">×</button></div>
    <div style="overflow:auto;flex:1">${myNotifs().map(notifHTML).join('') || '<p class="muted" style="padding:18px">Aucune notification.</p>'}</div>`;
  d.hidden = false; markSeen();
  $('#dClose').onclick = () => (d.hidden = true);
};

/* ============ Annonces ============ */
function renderListings() {
  const types = ['Tous', 'Chambre', 'Studio', 'Appartement', 'Villa'];
  const villes = ['Toutes', ...new Set(S.listings.map((l) => l.ville))];
  if (!villes.includes(filter.ville)) filter.ville = 'Toutes';
  const list = S.listings.filter((l) => l.statut !== 'suspendu' && (filter.type === 'Tous' || l.type === filter.type) && (filter.ville === 'Toutes' || l.ville === filter.ville));
  const dispo = S.listings.filter((l) => l.statut === 'disponible').length;
  app.innerHTML = `
  <div class="hero">
    <div><div class="eyebrow">Location au Sénégal</div><h1>Trouvez votre néeg, réservez en toute sécurité</h1>
    <p>Bloquez un logement avec un acompte, réglez la caution par Wave ou Orange Money. Neeg Loc garde les fonds jusqu’à la remise des clés.</p></div>
    <span class="pill p-ok num">${pl(dispo, 'logement disponible', 'logements disponibles')}</span>
  </div>
  <div class="filters" role="group" aria-label="Filtres">
    ${types.map((t) => `<button class="chip" aria-pressed="${filter.type === t}" data-type="${t}">${t}</button>`).join('')}
    <select class="select" id="villeSel" aria-label="Ville">${villes.map((v) => `<option ${filter.ville === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
  </div>
  <div class="grid">${list.map((l) => `
    <a class="card" href="#loc-annonce-${esc(l.id)}" data-go="loc-annonce-${esc(l.id)}" style="text-decoration:none;color:inherit">
      <div class="art">${pic(l)}${statutPill(l.statut)}</div>
      <div class="card-b">
        <div class="price">${fmt(l.loyer)} <small>/ mois</small></div>
        <div class="card-t">${esc(l.titre)}</div>
        <div class="meta"><span>${esc(l.quartier)}, ${esc(l.ville)}</span>${l.surface ? `<span class="num">${l.surface} m²</span>` : ''}<span>${l.meuble ? 'Meublé' : 'Vide'}</span>${(l.photos || []).length > 1 ? `<span>${l.photos.length} photos</span>` : ''}${l.video ? '<span>▶ Vidéo</span>' : ''}</div>
      </div>
    </a>`).join('') || `<div class="box empty" style="grid-column:1/-1"><h2>${S.listings.length ? 'Aucune annonce pour ces filtres' : 'Aucune annonce publiée pour l’instant'}</h2>
      <p class="muted">${S.listings.length ? 'Changez de type ou de ville.' : 'Les propriétaires publient leurs logements depuis Neeg Loc Pro.'}</p></div>`}
  </div>`;
  app.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => { filter.type = b.dataset.type; renderListings(); }));
  $('#villeSel').onchange = (e) => { filter.ville = e.target.value; e.target.blur(); renderListings(); };
}

let GAL = { id: null, i: 0 };
function renderDetail(l) {
  if (GAL.id !== l.id) GAL = { id: l.id, i: 0 };
  const dispo = l.statut === 'disponible', mien = ME && l.owner_id === ME.id;
  const items = (l.photos || []).map((r) => ({ k: 'img', r })).concat(l.video ? [{ k: 'vid', r: l.video }] : []);
  const cur = items[GAL.i] || items[0];
  const main = !cur ? art(l) : cur.k === 'vid' ? `<video src="${esc(photoUrl(cur.r))}" controls playsinline preload="metadata"></video>` : picRef(cur.r, l, 0, false);
  const thumbs = items.length > 1 ? `<div class="thumbs">${items.map((it, i) => `<button class="art" data-gi="${i}" aria-pressed="${it === cur}" aria-label="${it.k === 'vid' ? 'Vidéo' : 'Photo ' + (i + 1)}">${it.k === 'vid' ? '<span class="vid">▶ Vidéo</span>' : picRef(it.r, l, i, false)}</button>`).join('')}</div>`
    : items.length ? '' : `<div class="thumbs" style="grid-template-columns:repeat(3,1fr)"><div class="art">${art(l, 1)}</div><div class="art">${art(l, 2)}</div><div class="art">${art(l)}</div></div>`;
  app.innerHTML = `
  <button class="back" data-go="loc-annonces">← Toutes les annonces</button>
  <div class="detail">
    <div>
      <div class="art main-art">${main}</div>${thumbs}
      ${items.length ? '' : '<p class="hint" style="margin:6px 0 0">Illustrations : le propriétaire n’a pas encore ajouté de photos.</p>'}
      <div style="margin-top:24px">
        <div class="eyebrow">${esc(l.type)} · ${esc(l.quartier)}, ${esc(l.ville)}</div>
        <h1 style="font-size:clamp(26px,3.6vw,36px);margin-top:6px">${esc(l.titre)}</h1>
        <div class="meta" style="margin-top:10px">${l.surface ? `<span class="num">${l.surface} m²</span>` : ''}<span>${pl(l.pieces, 'pièce')}</span><span>${l.meuble ? 'Meublé' : 'Non meublé'}</span>${statutPill(l.statut)}</div>
        <p style="max-width:66ch;margin-top:14px">${esc(l.descr || 'Logement proposé sur Neeg Loc.')}</p>
        <div class="feat">${(l.features || []).map((f) => `<span>${esc(f)}</span>`).join('')}</div>
      </div>
    </div>
    <aside class="box sticky">
      <div class="price" style="font-size:30px">${fmt(l.loyer)} <small>/ mois</small></div>
      <div class="rows">
        <div class="row"><span class="muted">Caution (${S.params.caution_mois} mois)</span><b>${fmt(caution(l))}</b></div>
        <div class="row"><span class="muted">Acompte de blocage (${S.params.blocage_heures} h)</span><b>${fmt(acompte(l))}</b></div>
        <div class="sep"></div>
        <div class="row"><span class="muted">Frais de dossier</span><b>0 FCFA</b></div>
      </div>
      ${mien ? '<p class="note" style="margin-top:0">C’est votre annonce : gérez-la depuis Neeg Loc Pro.</p><button class="btn btn-ghost btn-block" data-go="pro-logements">Ouvrir Neeg Loc Pro</button>' : `
      <div style="display:grid;gap:10px">
        <button class="btn btn-red btn-block" id="payFull" ${dispo ? '' : 'disabled'}>Payer la caution · ${fmt(caution(l))}</button>
        <button class="btn btn-ghost btn-block" id="payDep" ${dispo ? '' : 'disabled'}>Bloquer avec un acompte · ${fmt(acompte(l))}</button>
      </div>
      ${dispo ? '' : `<p class="note">Ce logement est ${l.statut === 'bloque' ? 'réservé par un autre locataire' : l.statut === 'suspendu' ? 'momentanément retiré' : 'déjà loué'}.</p>`}`}
      <p class="note"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none;margin-top:2px"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      L’acompte bloque le logement ${S.params.blocage_heures} h et sera déduit de la caution ; sans solde à temps, le blocage expire et l’acompte vous est remboursé. Neeg Loc garde la caution jusqu’à ce que vous confirmiez la remise des clés.</p>
      <div class="owner"><div class="avatar">${esc(initiales(l.proprio_nom))}</div><div><b>${esc(l.proprio_nom || 'Propriétaire')}</b><div class="muted" style="font-size:13px">Propriétaire</div></div></div>
    </aside>
  </div>`;
  app.querySelectorAll('[data-gi]').forEach((b) => (b.onclick = () => { GAL.i = +b.dataset.gi; renderDetail(L(l.id) || l); }));
  if (!mien && dispo) {
    $('#payFull').onclick = () => startBooking(l, 'caution');
    $('#payDep').onclick = () => startBooking(l, 'acompte');
  }
}

async function startBooking(l, kind) {
  if (!ME) return openAuth('Connectez-vous ou créez un compte pour réserver ce logement.');
  if (!(await ensureIdentity('Votre nom et votre numéro figurent sur le contrat et servent aux remboursements.'))) return;
  let resa;
  try { resa = await rpc('reserver', { p_listing: l.id, p_nom: PROFIL.nom, p_tel: PROFIL.tel }); } catch { reload(); return; }
  await load();
  const fin = () => { reload(); go('loc-locations'); };
  NeegPay.payer({ bookingId: resa.id, kind, montant: kind === 'acompte' ? resa.acompte : resa.caution, libelle: l.titre, tel: PROFIL.tel, onSucces: fin, onFermer: fin });
}
function payer(b, x) {
  NeegPay.payer({ bookingId: b.id, kind: x.kind, mois: x.mois || null, montant: x.montant, libelle: lg(b).titre, tel: PROFIL?.tel, onSucces: reload, onFermer: reload });
}

/* ============ Mes locations ============ */
function renderLocations() {
  const mine = S.bookings.filter(isTenant);
  app.innerHTML = `<div class="section-h"><div><div class="eyebrow">Espace locataire</div><h1>Mes locations</h1></div></div>
  ${mine.length ? mine.map(tenantCard).join('') : `<div class="box empty"><h2>Aucune réservation pour l’instant</h2>
    <p class="muted">Choisissez un logement puis bloquez-le avec un acompte ou réglez directement la caution.</p>
    <button class="btn btn-primary" data-go="loc-annonces">Voir les annonces</button></div>`}`;
  fillAsync();
}
function tenantCard(b) {
  const l = lg(b), s = stepOf(b), v = enVerif(b);
  let action = '';
  if (b.etat === 'expire' || b.etat === 'annule') {
    const amt = paid(b);
    action = `<p>${b.etat === 'expire' ? `Le blocage a expiré${b.expire_le ? ' le ' + dfmt(b.expire_le) : ''} faute de paiement du solde.` : 'Réservation annulée.'} ${amt ? (b.fonds === 'rembourse' ? `Votre paiement de <b class="num">${fmt(amt)}</b> vous a été remboursé.` : `Neeg Loc vous rembourse <b class="num">${fmt(amt)}</b>.`) : ''}</p>
      ${L(b.listing_id)?.statut === 'disponible' ? `<button class="btn btn-ghost" data-go="loc-annonce-${esc(b.listing_id)}">Réserver à nouveau</button>` : ''}`;
  } else if (v) {
    action = `<p>Votre transfert de <b class="num">${fmt(v.amount)}</b> (${lib('moyen', v.provider)}, réf. ${esc(v.tx_id)}) est en cours de vérification par Neeg Loc. Vous serez prévenu dès sa validation.</p>`;
  } else if (b.etat === 'attente_paiement') {
    action = `<p>Logement réservé pour vous pendant le paiement${b.attente_jusqua ? `, jusqu’à ${new Date(b.attente_jusqua).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : ''}. Finalisez l’acompte ou la caution.</p><div class="row" style="gap:8px;flex-wrap:wrap" data-att="${b.id}"></div>`;
  } else if (b.etat === 'bloque') {
    action = `<p>Logement bloqué encore <b data-exp="${expOf(b)}">${left(expOf(b) - Date.now())}</b>, jusqu’au ${dtfmt(expOf(b))}. Payez le reste de la caution pour recevoir le contrat.</p><div data-att="${b.id}"></div>`;
  } else if (s === 2 && !b.sign_loc) {
    action = `<p>Caution reçue. Le contrat de bail est prêt : signez-le en ligne.</p><button class="btn btn-primary" data-act="contrat" data-id="${b.id}">Signer le contrat</button>`;
  } else if (s === 2) {
    action = `<p>Vous avez signé. En attente de la signature de <b>${esc(b.prop_nom)}</b>.</p><button class="btn btn-ghost" data-act="contrat" data-id="${b.id}">Voir le contrat</button>`;
  } else if (s === 3) {
    action = `<p>Contrat signé par les deux parties. Choisissez quand récupérer vos clés.</p><button class="btn btn-primary" data-act="rdv" data-id="${b.id}">Choisir un créneau</button>`;
  } else if (s === 4) {
    action = `<p>Remise des clés le <b>${dtfmt(b.rdv_date)}</b>, ${esc(l.quartier)}. Une fois les clés en main, confirmez ici.</p>
      <button class="btn btn-gold" data-act="cles" data-id="${b.id}">J’ai reçu mes clés</button><button class="btn btn-ghost" data-act="rdv" data-id="${b.id}">Déplacer</button>`;
  } else {
    action = `<p>Location ${b.etat === 'clos' ? 'terminée' : 'en cours'} depuis le ${dfmt(b.cles_le)}. ${b.fonds === 'verse' ? 'La caution a été versée au propriétaire.' : b.fonds === 'a_verser' ? 'La caution est en cours de versement au propriétaire.' : ''}</p><button class="btn btn-ghost" data-act="contrat" data-id="${b.id}">Voir le contrat</button>`;
  }
  return `<article class="box bk">
    <div class="art">${pic(l)}</div>
    <div>
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
        <div><div class="card-t">${esc(l.titre)}</div><div class="muted" style="font-size:13px">${esc(l.quartier)}${l.ville ? ', ' + esc(l.ville) : ''} · Réf. ${esc(b.id)}</div></div>
        ${stagePill(b)}
      </div>
      ${stepper(b)}
      <div class="meta" style="margin-bottom:12px"><span>Loyer <b class="num">${fmt(b.loyer)}</b></span><span>Caution <b class="num">${fmt(b.caution)}</b></span><span>Payé <b class="num">${fmt(paid(b))}</b></span></div>
      <div class="action">${action}</div>
      ${s === 5 ? `<div data-bail="${b.id}" data-role="loc"></div>` : ''}
    </div>
  </article>`;
}

/* Contenus calculés par le serveur : paiements attendus et loyers dus */
async function fillAsync() {
  for (const el of app.querySelectorAll('[data-att]')) {
    const { data } = await sb.rpc('paiements_attendus', { p_booking: el.dataset.att });
    const b = B(el.dataset.att); if (!b) continue;
    el.innerHTML = (data || []).map((x, i) => `<button class="btn ${i ? 'btn-ghost' : 'btn-red'}" data-pay="${b.id}" data-i="${i}">${x.kind === 'acompte' ? 'Payer l’acompte' : x.kind === 'caution' ? 'Payer la caution' : x.kind === 'solde' ? 'Payer le solde' : 'Payer le loyer de ' + moisLabel(x.mois)} · ${fmt(x.montant)}</button>`).join(' ');
    el.querySelectorAll('[data-pay]').forEach((btn) => (btn.onclick = () => payer(b, data[+btn.dataset.i])));
  }
  for (const el of app.querySelectorAll('[data-bail]')) {
    const b = B(el.dataset.bail); if (!b) continue;
    const { data } = await sb.rpc('loyers_dus', { p_booking: b.id });
    el.innerHTML = bailHTML(b, el.dataset.role, data || []);
  }
  bindActions();
}

/* ============ Bail : loyers, quittances, fin de bail ============ */
function bailHTML(b, role, dus) {
  const next = (dus.find((m) => !m.paye) || {}).mois;
  const finie = ['rembourse', 'clos'].includes(b.fin?.etape);
  const rows = dus.slice().reverse().slice(0, 12).map((m) => {
    const rec = (b.loyers || []).find((x) => x.mois === m.mois);
    const retard = !m.paye && Date.now() > new Date(m.echeance).getTime();
    let st, act = '';
    if (m.paye) { st = '<span class="pill p-ok">Payé</span>'; act = `<button class="btn btn-ghost btn-sm" data-act="quittance" data-id="${b.id}" data-k="${m.mois}">Quittance</button>`; }
    else {
      st = retard ? '<span class="pill p-warn">En retard</span>' : '<span class="pill p-mute">À payer</span>';
      act = role === 'loc' && m.mois === next && !finie ? `<button class="btn btn-red btn-sm" data-act="loyer" data-id="${b.id}" data-k="${m.mois}">Payer</button>` : `<span class="hint">avant le ${dfmt(m.echeance, { day: 'numeric', month: 'short' })}</span>`;
    }
    return `<tr><td>${moisLabel(m.mois)}</td><td class="r num">${fmt(rec?.montant || b.loyer)}</td><td>${st}</td><td style="white-space:nowrap">${act}</td></tr>`;
  }).join('');
  return `<div class="bail"><h3>Loyers</h3>
    <div class="tbl-wrap"><table class="ltab"><thead><tr><th>Mois</th><th class="r">Montant</th><th>Statut</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">Aucun loyer dû pour le moment.</td></tr>'}</tbody></table></div>
    <p class="hint" style="margin:-4px 0 14px">Loyer payable au plus tard le ${S.params.loyer_jour} du mois via Neeg Loc, qui le reverse au propriétaire. La quittance est disponible dès le paiement confirmé.</p>
    <h3>Fin de bail</h3>${finHTML(b, role)}</div>`;
}
function finHTML(b, role) {
  const f = b.fin;
  if (b.etat !== 'bail' && b.etat !== 'clos') return '';
  if (!f) return `<div class="action"><p>Bail en cours. Chaque partie peut donner congé avec un préavis de ${pl(S.params.preavis_mois, 'mois', 'mois')}.</p>${role !== 'admin' ? `<button class="btn btn-ghost" data-act="conge" data-id="${b.id}">Donner congé</button>` : ''}</div>`;
  const restit = Math.max(0, b.caution - (f.retenue || 0));
  const head = `Congé donné par ${esc(f.par === 'loc' ? b.loc_nom : b.prop_nom)}${f.le ? ' le ' + dfmt(f.le) : ''} · sortie le <b>${dfmt(f.sortie)}</b>.`;
  const edl = f.retenue != null ? ` Retenue : <b class="num">${fmt(f.retenue)}</b>${f.motif ? ` (${esc(f.motif)})` : ''} · à restituer : <b class="num">${fmt(restit)}</b>.` : '';
  let act = '';
  switch (f.etape) {
    case 'preavis': act = role === 'prop' ? `<button class="btn btn-primary" data-act="edl" data-id="${b.id}">Faire l’état des lieux de sortie</button>` : '<span class="hint">En attente de l’état des lieux de sortie par le propriétaire.</span>'; break;
    case 'edl': act = role === 'loc' ? `<button class="btn btn-primary" data-act="fin-ok" data-id="${b.id}">Accepter</button><button class="btn btn-ghost" data-act="fin-ko" data-id="${b.id}">Contester</button>` : '<span class="hint">En attente de la réponse du locataire.</span>'; break;
    case 'conteste': act = role === 'admin' ? `<button class="btn btn-primary" data-act="arbitre" data-id="${b.id}">Arbitrer</button>` : `<span class="hint">Contestation : « ${esc(f.contest)} ». Le gestionnaire Neeg Loc arbitre et fixe la retenue définitive.</span>`; break;
    case 'accepte': act = role === 'prop' ? `<button class="btn btn-gold" data-act="remb" data-id="${b.id}">Restituer ${fmt(restit)}</button>` : `<span class="hint">${esc(b.prop_nom)} doit restituer ${fmt(restit)}${f.arbitre ? ' (montant fixé par Neeg Loc)' : ''}.</span>`; break;
    case 'rembourse': act = role === 'loc' ? `<button class="btn btn-gold" data-act="fin-recu" data-id="${b.id}">J’ai reçu ${fmt(restit)}</button>` : `<span class="hint">Restitution envoyée (${esc(f.remb?.moyen)}, ${esc(f.remb?.ref)}), en attente de confirmation du locataire.</span>`; break;
    case 'clos': act = `<span class="hint">Bail clôturé${f.clos_le ? ' le ' + dfmt(f.clos_le) : ''}. Le logement est remis en location.</span>`; break;
  }
  return `<div class="action"><p>${head}${edl}${f.decision ? ` Décision Neeg Loc : ${esc(f.decision)}` : ''}</p>${act}</div>`;
}

function bindActions() {
  app.querySelectorAll('[data-act]').forEach((btn) => (btn.onclick = () => {
    const b = B(btn.dataset.id); if (!b) return;
    const k = btn.dataset.k;
    ({
      contrat: () => openContract(b),
      rdv: () => openRdv(b),
      cles: () => confirmKeys(b),
      loyer: () => payer(b, { kind: 'loyer', mois: k, montant: b.loyer }),
      quittance: () => quittance(b, k),
      conge: () => conge(b),
      edl: () => edlSortie(b),
      'fin-ok': () => finOk(b),
      'fin-ko': () => finKo(b),
      arbitre: () => arbitrer(b),
      remb: () => restituer(b),
      'fin-recu': () => finRecu(b),
      prolong: () => prolonger(b),
    }[btn.dataset.act] || (() => {}))();
  }));
}

function printable(html, titre) {
  const w = window.open('', '_blank');
  if (!w) { toast('Autorisez les fenêtres pour imprimer'); return; }
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(titre)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Manrope:wght@400;700&display=swap" rel="stylesheet">
    <style>body{font:14px/1.7 Manrope,system-ui,sans-serif;color:#13221E;max-width:720px;margin:40px auto;padding:0 24px}h3{font:600 22px Fraunces,Georgia,serif;text-align:center;margin:0}h4{font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin:18px 0 4px}.center{text-align:center}.muted{color:#5E6B66}img{max-height:90px}.sigs{display:flex;gap:24px;margin-top:24px}.sigs>div{flex:1;border-top:1px solid #ccc;padding-top:8px}</style></head>
    <body><img src="${location.href.split('#')[0].replace(/[^/]*$/, '')}logo.png" alt="Neeg Loc" style="height:54px;display:block;margin:0 auto 18px">${html}<script>window.onload=()=>setTimeout(()=>print(),400)<\/script></body></html>`);
  w.document.close();
}
function quittance(b, k) {
  const l = lg(b), rec = (b.loyers || []).find((x) => x.mois === k), pay = (b.payments || []).find((p) => p.id === rec?.payment_id);
  if (!rec) return;
  const html = `<h3>Quittance de loyer</h3><p class="center muted">${moisLabel(k)} · réf. ${esc(b.id)}-${k}</p>
    <p>Neeg Loc, pour le compte de <b>${esc(b.prop_nom)}</b>, bailleur du logement ${esc((l.type || '').toLowerCase())} situé ${esc(l.quartier)}, ${esc(l.ville)}, déclare avoir reçu de <b>${esc(b.loc_nom)}</b> la somme de <b>${fmt(rec.montant)}</b> au titre du loyer de ${moisLabel(k)}, et lui en donne quittance, sous réserve de tous droits.</p>
    <p>Paiement ${pay ? `par ${lib('moyen', pay.provider)}${pay.tx_id ? ', transaction ' + esc(pay.tx_id) : ''}` : ''}, reçu le ${dfmt(rec.paye_le)}.</p>
    <p class="muted">Quittance établie via Neeg Loc le ${dfmt(Date.now())}.</p>`;
  openModal(`<div class="m-h"><h2>Quittance de loyer</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><div class="contract">${html}</div>
    <div style="display:flex;gap:10px;margin-top:14px"><button class="btn btn-primary" style="flex:1" id="qPrint">Imprimer ou enregistrer en PDF</button></div></div>`);
  $('#qPrint').onclick = () => printable(html, `Quittance ${moisLabel(k)} ${b.id}`);
}
function conge(b) {
  const d = new Date(); d.setMonth(d.getMonth() + S.params.preavis_mois);
  openModal(`<div class="m-h"><h2>Donner congé</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><p class="muted" style="margin-top:0">${esc(lg(b).titre)} · ${isTenant(b) ? 'le propriétaire' : 'le locataire'} sera prévenu immédiatement.</p>
    <div class="field"><label for="cDate">Date de sortie</label><input class="input" type="date" id="cDate" min="${iso(new Date())}" value="${iso(d)}"></div>
    <p class="hint" style="margin-top:-4px">Préavis prévu au contrat : ${pl(S.params.preavis_mois, 'mois', 'mois')}.</p>
    <p class="err" id="cErr"></p><button class="btn btn-primary btn-block" id="cGo">Confirmer le congé</button></div>`);
  $('#cGo').onclick = async () => {
    const v = $('#cDate').value;
    if (!v) { $('#cErr').textContent = 'Choisissez une date de sortie.'; return; }
    try { await rpc('donner_conge', { p_booking: b.id, p_sortie: v }); closeModal(true); toast('Congé enregistré'); reload(); } catch { /* message affiché */ }
  };
}
function edlSortie(b) {
  const held = b.caution;
  openModal(`<div class="m-h"><h2>État des lieux de sortie</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><p class="muted" style="margin-top:0">${esc(lg(b).titre)} · caution : <b class="num">${fmt(held)}</b></p>
    <div class="field"><label for="eRet">Retenue sur la caution (FCFA)</label><input class="input num" type="number" id="eRet" min="0" max="${held}" step="500" value="0"></div>
    <div class="field"><label for="eMot">Motif de la retenue</label><textarea class="input" id="eMot" rows="3" placeholder="Ex. peinture du salon à refaire"></textarea></div>
    <p class="muted" id="eInfo" style="font-size:13px"></p><p class="err" id="eErr"></p>
    <button class="btn btn-primary btn-block" id="eGo">Envoyer au locataire</button></div>`);
  const upd = () => { $('#eInfo').textContent = `À restituer au locataire : ${fmt(Math.max(0, held - (+$('#eRet').value || 0)))}`; };
  $('#eRet').oninput = upd; upd();
  $('#eGo').onclick = async () => {
    const r = Math.round(+$('#eRet').value || 0), mot = $('#eMot').value.trim();
    if (r < 0 || r > held) { $('#eErr').textContent = `La retenue doit être comprise entre 0 et ${fmt(held)}.`; return; }
    if (r > 0 && mot.length < 5) { $('#eErr').textContent = 'Expliquez le motif de la retenue.'; return; }
    try { await rpc('etat_des_lieux', { p_booking: b.id, p_retenue: r, p_motif: mot }); closeModal(true); toast('État des lieux envoyé'); reload(); } catch { /* affiché */ }
  };
}
async function finOk(b) { try { await rpc('repondre_edl', { p_booking: b.id, p_accepte: true }); toast('Réponse envoyée'); reload(); } catch { /* affiché */ } }
function finKo(b) {
  openModal(`<div class="m-h"><h2>Contester la retenue</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><div class="field"><label for="kMot">Pourquoi contestez-vous ?</label><textarea class="input" id="kMot" rows="4" placeholder="Ex. la peinture était déjà abîmée à l’entrée"></textarea></div>
    <p class="err" id="kErr"></p><button class="btn btn-primary btn-block" id="kGo">Envoyer au gestionnaire</button></div>`);
  $('#kGo').onclick = async () => {
    const mot = $('#kMot').value.trim();
    if (mot.length < 5) { $('#kErr').textContent = 'Décrivez brièvement votre désaccord.'; return; }
    try { await rpc('repondre_edl', { p_booking: b.id, p_accepte: false, p_motif: mot }); closeModal(true); toast('Contestation envoyée'); reload(); } catch { /* affiché */ }
  };
}
function arbitrer(b) {
  const held = b.caution;
  openModal(`<div class="m-h"><h2>Arbitrer · ${esc(b.id)}</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><p style="margin-top:0">Retenue demandée : <b class="num">${fmt(b.fin.retenue)}</b>${b.fin.motif ? ` · « ${esc(b.fin.motif)} »` : ''}<br>Contestation : « ${esc(b.fin.contest)} »</p>
    <div class="field"><label for="aRet">Retenue définitive (FCFA)</label><input class="input num" type="number" id="aRet" min="0" max="${held}" step="500" value="${b.fin.retenue}"></div>
    <div class="field"><label for="aNote">Décision (envoyée aux deux parties)</label><textarea class="input" id="aNote" rows="3"></textarea></div>
    <p class="err" id="aErr"></p><button class="btn btn-primary btn-block" id="aGo">Rendre la décision</button></div>`);
  $('#aGo').onclick = async () => {
    const r = Math.round(+$('#aRet').value || 0);
    if (r < 0 || r > held) { $('#aErr').textContent = `Montant entre 0 et ${fmt(held)}.`; return; }
    try { await rpc('arbitrer', { p_booking: b.id, p_retenue: r, p_decision: $('#aNote').value.trim() }); closeModal(true); toast('Décision envoyée'); reload(); } catch { /* affiché */ }
  };
}
function transferModal({ title, intro, amount, onDone }) {
  openModal(`<div class="m-h"><h2>${esc(title)}</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><p>${intro}</p>
    <div class="field"><label for="poMoyen">Moyen utilisé</label><select class="input" id="poMoyen"><option>Wave</option><option>Orange Money</option></select></div>
    <div class="field"><label for="poRef">Identifiant de la transaction</label><input class="input" id="poRef" autocomplete="off" placeholder="Ex. T_8KQ2M4XAPL ou MP251121.1012.C55318"></div>
    <p class="err" id="poErr"></p><button class="btn btn-primary btn-block" id="poGo">Confirmer l’envoi${amount ? ' de ' + fmt(amount) : ''}</button></div>`);
  $('#poGo').onclick = async () => {
    const ref = $('#poRef').value.trim();
    if (ref.length < 6) { $('#poErr').textContent = 'Recopiez l’identifiant complet du transfert.'; return; }
    $('#poGo').disabled = true;
    try { await onDone(ref, $('#poMoyen').value); closeModal(true); reload(); } catch { $('#poGo').disabled = false; }
  };
}
function restituer(b) {
  const restit = Math.max(0, b.caution - (b.fin.retenue || 0));
  transferModal({ title: 'Restituer la caution', amount: restit,
    intro: `Envoyez <b class="num">${fmt(restit)}</b> à <b>${esc(b.loc_nom)}</b> au <b class="num">${esc(b.loc_tel)}</b> par Wave ou Orange Money, puis recopiez l’identifiant de la transaction.`,
    onDone: async (ref, m) => { await rpc('declarer_restitution', { p_booking: b.id, p_ref: ref, p_moyen: m }); toast('Restitution enregistrée'); } });
}
async function finRecu(b) { try { await rpc('confirmer_restitution', { p_booking: b.id }); toast('Bail clôturé'); reload(); } catch { /* affiché */ } }
async function prolonger(b) { try { await rpc('prolonger_blocage', { p_booking: b.id, p_heures: 24 }); toast('Blocage prolongé de 24 h'); reload(); } catch { /* affiché */ } }

/* ============ Contrat et signature ============ */
function contractHTML(b) {
  const l = lg(b);
  const debut = b.rdv_date ? dfmt(b.rdv_date) : 'la date de remise des clés';
  const caut = b.payments?.find((p) => p.status === 'reussi' && p.kind !== 'loyer');
  return `<h3>Contrat de bail à usage d’habitation</h3>
    <p class="center muted">Référence ${esc(b.id)} · établi via Neeg Loc le ${dfmt(b.created_at)}</p>
    <h4>Entre les soussignés</h4>
    <p><b>${esc(b.prop_nom)}</b>, tél. ${esc(b.prop_tel)}, ci-après « le Bailleur »,</p>
    <p>et <b>${esc(b.loc_nom)}</b>, tél. ${esc(b.loc_tel)}, ci-après « le Preneur ».</p>
    <h4>1. Désignation du bien</h4>
    <p>${esc(l.type)} ${l.meuble ? 'meublé' : 'non meublé'}${l.surface ? ` de ${l.surface} m²` : ''} (${pl(l.pieces || 1, 'pièce')}), situé ${esc(l.quartier)}, ${esc(l.ville)}, Sénégal.</p>
    <h4>2. Durée</h4><p>Le bail est consenti pour une durée d’un (1) an à compter de ${debut}, renouvelable par tacite reconduction.</p>
    <h4>3. Loyer</h4><p>Le loyer mensuel est fixé à <b>${fmt(b.loyer)}</b>, payable d’avance au plus tard le ${S.params.loyer_jour} de chaque mois via Neeg Loc, qui le reverse au Bailleur. Une quittance est délivrée pour chaque loyer reçu.</p>
    <h4>4. Dépôt de garantie</h4><p>Le Preneur verse un dépôt de garantie de <b>${fmt(b.caution)}</b>, soit ${pl(S.params.caution_mois, 'mois', 'mois')} de loyer${caut ? `, réglé par ${lib('moyen', caut.provider)}` : ''}. Ce montant est gardé en séquestre par Neeg Loc et versé au Bailleur dès que le Preneur confirme la remise des clés. Il est restitué au Preneur en fin de bail, déduction faite des sommes dues et des retenues justifiées par l’état des lieux de sortie.</p>
    <h4>5. Obligations des parties</h4><p>Le Bailleur délivre un logement décent et en bon état d’usage. Le Preneur use paisiblement des lieux, paie le loyer aux termes convenus et répond des dégradations survenues pendant la location.</p>
    <h4>6. État des lieux</h4><p>Un état des lieux contradictoire est établi lors de la remise des clés et lors de leur restitution.</p>
    <h4>7. Congé</h4><p>Chaque partie peut mettre fin au bail en notifiant son congé via Neeg Loc, moyennant un préavis de ${pl(S.params.preavis_mois, 'mois', 'mois')}. En cas de désaccord sur les retenues, Neeg Loc propose un arbitrage amiable.</p>
    <h4>8. Droit applicable</h4><p>Le présent contrat est soumis au droit sénégalais, notamment aux dispositions du Code des obligations civiles et commerciales relatives au bail.</p>`;
}
function sigBlock(qui, label, b, signer) {
  const val = qui === 'loc' ? b.sign_loc : b.sign_prop, nom = qui === 'loc' ? b.loc_nom : b.prop_nom;
  if (val) return `<div class="sig"><div class="sig-h">${label}<span class="pill p-ok">Signé</span></div><img src="${esc(val)}" alt="Signature de ${esc(nom)}"></div>`;
  if (qui === signer) return `<div class="sig"><div class="sig-h">${label}<button class="btn btn-ghost btn-sm" id="padClear">Effacer</button></div><canvas class="pad" id="pad" aria-label="Zone de signature"></canvas><div class="muted" style="font-size:12px;margin-top:6px">Signez avec le doigt ou la souris · ${esc(nom)}</div></div>`;
  return `<div class="sig"><div class="sig-h">${label}<span class="pill p-warn">En attente</span></div><div class="sig-wait">En attente de la signature de ${esc(nom)}</div></div>`;
}
function openContract(b) {
  const both = b.sign_loc && b.sign_prop;
  const signer = b.etat === 'caution_payee' && !both ? (isTenant(b) && !b.sign_loc ? 'loc' : isOwner(b) && !b.sign_prop ? 'prop' : '') : '';
  const sigs = `<div class="sigs">${sigBlock('prop', 'Le Bailleur', b, signer)}${sigBlock('loc', 'Le Preneur', b, signer)}</div>`;
  openModal(`<div class="m-h"><h2>${both ? 'Contrat signé' : 'Contrat de bail'}</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><div class="contract">${contractHTML(b)}</div>${sigs}
    <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
      ${signer ? '<button class="btn btn-primary" style="flex:1" id="signGo">Signer le contrat</button>' : ''}
      <button class="btn btn-ghost" style="flex:${signer ? '0 1 auto' : '1'}" id="printC">Imprimer ou enregistrer en PDF</button>
    </div></div>`, true);
  $('#printC').onclick = () => printable(contractHTML(b) + `<div class="sigs"><div><b>Le Bailleur</b><br>${b.sign_prop ? `<img src="${esc(b.sign_prop)}" alt="">` : '<span class="muted">non signé</span>'}</div><div><b>Le Preneur</b><br>${b.sign_loc ? `<img src="${esc(b.sign_loc)}" alt="">` : '<span class="muted">non signé</span>'}</div></div>`, `Contrat ${b.id}`);
  if (!signer) return;
  const pad = initPad($('#pad'));
  $('#padClear').onclick = pad.clear;
  $('#signGo').onclick = async () => {
    if (!pad.drawn()) { toast('Tracez votre signature dans le cadre'); return; }
    $('#signGo').disabled = true;
    try { await rpc('signer_contrat', { p_booking: b.id, p_signature: pad.data() }); toast('Signature enregistrée'); closeModal(true); await load(); refresh(); }
    catch { $('#signGo').disabled = false; }
  };
}
function initPad(c) {
  const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr); x.lineWidth = 2.2; x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = '#13221E';
  let down = false, n = 0;
  const p = (e) => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  c.addEventListener('pointerdown', (e) => { down = true; c.setPointerCapture(e.pointerId); x.beginPath(); x.moveTo(...p(e)); });
  c.addEventListener('pointermove', (e) => { if (!down) return; x.lineTo(...p(e)); x.stroke(); n++; });
  c.addEventListener('pointerup', () => (down = false));
  return {
    clear() { x.clearRect(0, 0, c.width, c.height); n = 0; },
    drawn() { return n > 8; },
    data() { const o = document.createElement('canvas'); o.width = Math.round(r.width); o.height = Math.round(r.height); o.getContext('2d').drawImage(c, 0, 0, o.width, o.height); return o.toDataURL('image/png'); },
  };
}

/* ============ Rendez-vous et remise des clés ============ */
const SLOTS = ['09:00', '10:30', '12:00', '15:00', '16:30', '18:00'];
function openRdv(b) {
  const l = lg(b), days = [];
  let d = new Date(); d.setHours(0, 0, 0, 0);
  while (days.length < 12) { d = new Date(d.getTime() + 86400e3); if (d.getDay() !== 0) days.push(d.getTime()); }
  let selD = days[0], selS = null;
  if (b.rdv_date) { const r = new Date(b.rdv_date); selD = days.find((x) => new Date(x).toDateString() === r.toDateString()) || days[0]; selS = r.toTimeString().slice(0, 5); if (!SLOTS.includes(selS)) selS = null; }
  const draw = () => {
    openModal(`<div class="m-h"><h2>Remise des clés</h2><button class="x" aria-label="Fermer">×</button></div>
    <div class="m-b"><p class="muted" style="margin:0">${esc(l.titre)} · ${esc(l.quartier)}, ${esc(l.ville)}<br>Sur place avec ${esc(b.prop_nom)} (environ 30 min, état des lieux compris).</p>
      <div class="days" role="group" aria-label="Jour">${days.map((t) => { const dd = new Date(t); return `<button class="day" data-d="${t}" aria-pressed="${t === selD}"><small>${dd.toLocaleDateString('fr-FR', { weekday: 'short' })}</small><b>${dd.getDate()}</b><small>${dd.toLocaleDateString('fr-FR', { month: 'short' })}</small></button>`; }).join('')}</div>
      <div class="field"><label>Heure</label></div>
      <div class="slots" role="group" aria-label="Heure">${SLOTS.map((s) => `<button class="slot" data-s="${s}" aria-pressed="${s === selS}">${s.replace(':', ' h ')}</button>`).join('')}</div>
      <button class="btn btn-primary btn-block" style="margin-top:18px" id="rdvGo" ${selS ? '' : 'disabled'}>Confirmer le rendez-vous</button></div>`);
    $('#modal').querySelectorAll('.day').forEach((x) => (x.onclick = () => { selD = +x.dataset.d; draw(); }));
    $('#modal').querySelectorAll('.slot').forEach((x) => (x.onclick = () => { selS = x.dataset.s; draw(); }));
    $('#rdvGo').onclick = async () => {
      const [h, m] = selS.split(':').map(Number), when = new Date(selD); when.setHours(h, m, 0, 0);
      try { await rpc('fixer_rdv', { p_booking: b.id, p_date: when.toISOString() }); closeModal(true); toast('Rendez-vous confirmé'); reload(); } catch { /* affiché */ }
    };
  };
  draw();
}
function confirmKeys(b) {
  openModal(`<div class="m-h"><h2>Confirmer la remise des clés</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><p>En confirmant, vous attestez avoir reçu les clés de <b>${esc(lg(b).titre)}</b> et vérifié l’état des lieux.</p>
    <div class="box" style="box-shadow:none;background:var(--surface-2)"><div class="row"><span class="muted">Caution versée à ${esc(b.prop_nom)}</span><b class="num">${fmt(paid(b))}</b></div></div>
    <p class="note">Neeg Loc reverse alors la caution au propriétaire. Vos loyers se paient ensuite chaque mois depuis Mes locations. En cas de problème sur place, ne confirmez pas et contactez Neeg Loc.</p>
    <div style="display:flex;gap:10px;margin-top:16px"><button class="btn btn-ghost" style="flex:1" id="kNo">Pas encore</button><button class="btn btn-gold" style="flex:1" id="kYes">Oui, j’ai mes clés</button></div></div>`);
  $('#kNo').onclick = () => closeModal();
  $('#kYes').onclick = async () => {
    try { await rpc('confirmer_cles', { p_booking: b.id }); closeModal(true); toast('Bienvenue chez vous !'); reload(); } catch { /* affiché */ }
  };
}

/* ============ Espace propriétaire ============ */
function ownerTodo(b) {
  if (b.etat === 'caution_payee' && !b.sign_prop) return true;
  return ['preavis', 'accepte'].includes(b.fin?.etape);
}
function ownerCard(b) {
  const l = lg(b), s = stepOf(b);
  let act;
  if (b.etat === 'expire' || b.etat === 'annule') act = `<p>${b.etat === 'expire' ? 'Blocage expiré' : 'Réservation annulée'}. Le logement est de nouveau en ligne.</p>`;
  else if (b.etat === 'attente_paiement' || enVerif(b)) act = `<p>${esc(b.loc_nom)} est en train de payer. Le logement est réservé pendant la vérification.</p>`;
  else if (b.etat === 'bloque') act = `<p>${esc(b.loc_nom)} a bloqué ce logement (acompte de ${fmt(paid(b))}). Solde attendu d’ici <b data-exp="${expOf(b)}">${left(expOf(b) - Date.now())}</b>.</p>`;
  else if (s === 2 && !b.sign_prop) act = `<p>Caution reçue de ${esc(b.loc_nom)} et gardée par Neeg Loc. Signez le contrat pour finaliser.</p><button class="btn btn-primary" data-act="contrat" data-id="${b.id}">Signer le contrat</button>`;
  else if (s === 2) act = `<p>Vous avez signé. En attente de la signature de ${esc(b.loc_nom)}.</p><button class="btn btn-ghost" data-act="contrat" data-id="${b.id}">Voir le contrat</button>`;
  else if (s === 3) act = `<p>Contrat signé. ${esc(b.loc_nom)} va choisir un créneau de remise des clés.</p><button class="btn btn-ghost" data-act="contrat" data-id="${b.id}">Voir le contrat</button>`;
  else if (s === 4) act = `<p>Remise des clés le <b>${dtfmt(b.rdv_date)}</b>. La caution vous sera versée dès que le locataire confirme.</p>`;
  else {
    const po = S.payouts.find((p) => p.booking_id === b.id && p.kind === 'caution_proprio');
    act = `<p>Clés remises le ${dfmt(b.cles_le)}. ${po && ['reussi', 'manuel'].includes(po.statut) ? `Caution de <b class="num">${fmt(po.montant)}</b> versée sur votre compte${po.provider_ref ? ` (réf. ${esc(po.provider_ref)})` : ''}.` : `Neeg Loc vous verse la caution de <b class="num">${fmt(paid(b))}</b>.`}</p><button class="btn btn-ghost" data-act="contrat" data-id="${b.id}">Voir le contrat</button>`;
  }
  return `<article class="box bk"><div class="art">${pic(l)}</div><div>
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><div><div class="card-t">${esc(l.titre)}</div><div class="muted" style="font-size:13px">${esc(b.loc_nom)} · ${esc(b.loc_tel)} · Réf. ${esc(b.id)}</div></div>${stagePill(b)}</div>
    ${stepper(b)}<div class="action">${act}</div>${s === 5 ? `<div data-bail="${b.id}" data-role="prop"></div>` : ''}</div></article>`;
}
function renderOwner(sec) {
  const mineL = S.listings.filter((l) => l.owner_id === ME.id);
  const mineB = S.bookings.filter(isOwner);
  const done = (p) => ['reussi', 'manuel'].includes(p.statut);
  const cautions = S.payouts.filter((p) => p.kind === 'caution_proprio' && done(p)).reduce((a, p) => a + p.montant, 0);
  const loyers = S.payouts.filter((p) => p.kind === 'loyer_proprio' && done(p)).reduce((a, p) => a + p.montant, 0);
  const seq = mineB.filter((b) => ['sequestre', 'a_verser'].includes(b.fonds)).reduce((a, b) => a + paid(b), 0);
  const todo = mineB.filter(ownerTodo);
  const prenom = (PROFIL?.nom || '').split(' ')[0];
  const head = (t) => `<div class="section-h"><div><div class="eyebrow">Neeg Loc Pro${PROFIL?.nom ? ' · ' + esc(PROFIL.nom) : ''}</div><h1>${t}</h1></div><button class="btn btn-primary" id="newL">Publier une annonce</button></div>`;
  let body;
  if (sec === 'dashboard') {
    body = head(prenom ? `Bonjour, ${esc(prenom)}` : 'Neeg Loc Pro') + `
    <div class="kpis">
      <div class="box kpi"><span class="muted">Logements</span><b class="num">${mineL.length}</b></div>
      <div class="box kpi"><span class="muted">En séquestre chez Neeg Loc</span><b class="num">${fmt(seq)}</b></div>
      <div class="box kpi"><span class="muted">Cautions reçues</span><b class="num">${fmt(cautions)}</b></div>
      <div class="box kpi"><span class="muted">Loyers reçus</span><b class="num">${fmt(loyers)}</b></div>
    </div>
    <h2 class="h2">À traiter</h2>
    ${todo.length ? todo.map(ownerCard).join('') : `<div class="box empty"><p class="muted" style="margin:0">${mineL.length ? 'Rien à traiter pour le moment.' : 'Publiez votre premier logement avec ses photos : il apparaît aussitôt dans les annonces.'}</p></div>`}`;
  } else if (sec === 'reservations') {
    body = head('Réservations et baux') + (mineB.length ? mineB.map(ownerCard).join('') : '<div class="box empty"><p class="muted" style="margin:0">Aucune réservation sur vos logements pour le moment.</p></div>');
  } else {
    body = head('Mes logements') + (mineL.length ? `<div class="tbl-wrap"><table><thead><tr><th>Logement</th><th>Quartier</th><th class="r">Loyer</th><th>Photos</th><th>Statut</th><th></th></tr></thead>
    <tbody>${mineL.map((l) => `<tr><td><div style="display:flex;gap:12px;align-items:center"><div class="art" style="width:68px;flex:none;border-radius:8px">${pic(l)}</div><div><b>${esc(l.titre)}</b><div class="sub">${esc(l.type)}${l.surface ? ' · ' + l.surface + ' m²' : ''}</div></div></div></td>
      <td>${esc(l.quartier)}, ${esc(l.ville)}</td><td class="r num">${fmt(l.loyer)}</td><td>${(l.photos || []).length}${l.video ? ' + vidéo' : ''}</td><td>${statutPill(l.statut)}</td>
      <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-edit="${l.id}">Modifier</button> <button class="btn btn-ghost btn-sm" data-ph="${l.id}">Photos</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="box empty"><h2>Aucun logement publié</h2><p class="muted">Publiez votre premier logement avec ses photos : il apparaît aussitôt dans les annonces.</p></div>');
  }
  app.innerHTML = body;
  $('#newL').onclick = () => listingForm(null);
  app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => listingForm(L(b.dataset.edit))));
  app.querySelectorAll('[data-ph]').forEach((b) => (b.onclick = () => managePhotos(b.dataset.ph)));
  fillAsync();
}

async function listingForm(l) {
  if (!(await ensureIdentity('Votre nom figure sur l’annonce et le contrat ; votre numéro reçoit les cautions et les loyers.'))) return;
  let files = [], vfile = null;
  const TYPES = ['Chambre', 'Studio', 'Appartement', 'Villa', 'Bureau'];
  openModal(`<div class="m-h"><h2>${l ? 'Modifier l’annonce' : 'Publier une annonce'}</h2><button class="x" aria-label="Fermer">×</button></div>
  <div class="m-b"><form id="nlf" novalidate>
    <div class="field"><label for="f1">Titre</label><input class="input" id="f1" value="${esc(l?.titre)}" placeholder="Ex. Studio meublé avec balcon"></div>
    <div class="form-grid">
      <div class="field"><label for="f2">Type</label><select class="input" id="f2">${TYPES.map((t) => `<option ${l?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label for="f3">Loyer mensuel (FCFA)</label><input class="input num" id="f3" type="number" min="10000" step="5000" value="${l?.loyer || 150000}"></div>
      <div class="field"><label for="f4">Quartier</label><input class="input" id="f4" value="${esc(l?.quartier)}" placeholder="Ex. Ouakam"></div>
      <div class="field"><label for="f5">Ville</label><input class="input" id="f5" value="${esc(l?.ville || 'Dakar')}"></div>
      <div class="field"><label for="f6">Surface (m²)</label><input class="input num" id="f6" type="number" min="5" value="${l?.surface || 30}"></div>
      <div class="field"><label for="fP">Pièces</label><input class="input num" id="fP" type="number" min="1" max="50" value="${l?.pieces || 1}"></div>
      <div class="field"><label for="f7">Meublé</label><select class="input" id="f7"><option value="1" ${l?.meuble ? 'selected' : ''}>Oui</option><option value="0" ${l && !l.meuble ? 'selected' : ''}>Non</option></select></div>
    </div>
    <div class="field"><label for="f8">Équipements (séparés par des virgules)</label><input class="input" id="f8" value="${esc((l?.features || []).join(', '))}" placeholder="Climatisation, Wi-Fi, Parking"></div>
    <div class="field"><label for="f9">Description</label><textarea class="input" id="f9" rows="3">${esc(l?.descr)}</textarea></div>
    ${l ? '' : `<div class="field"><label>Photos (${MAX_PHOTOS} max., la première sert de couverture) et vidéo</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="btn btn-ghost btn-sm">Ajouter des photos<input type="file" id="fPh" accept="image/*" multiple hidden></label>
        <label class="btn btn-ghost btn-sm">Ajouter une vidéo<input type="file" id="fVid" accept="video/mp4,video/webm" hidden></label>
      </div><div class="pgrid" id="prev"></div>
      <span class="hint">Les photos sont réduites automatiquement avant l’envoi. Vidéo MP4 ou WebM de 20 Mo maximum.</span></div>`}
    <p class="muted" style="font-size:13px" id="calc"></p><p class="err" id="nErr"></p>
    <button class="btn btn-primary btn-block" type="submit" id="nGo">${l ? 'Enregistrer' : 'Publier'}</button></form></div>`, true);
  const f = (id) => $('#' + id);
  const draw = () => {
    f('prev').innerHTML = files.map((x, i) => `<figure><img src="${URL.createObjectURL(x)}" alt="Photo ${i + 1}">${i === 0 ? '<span class="cover">Couverture</span>' : ''}<div class="tools"><button type="button" data-rm="${i}">Retirer</button></div></figure>`).join('')
      + (vfile ? `<figure><div class="vtile">▶ ${esc(vfile.name)}</div><div class="tools"><button type="button" data-rmv="1">Retirer</button></div></figure>` : '');
    f('prev').querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { files.splice(+b.dataset.rm, 1); draw(); }));
    f('prev').querySelectorAll('[data-rmv]').forEach((b) => (b.onclick = () => { vfile = null; draw(); }));
  };
  if (!l) {
    f('fPh').onchange = (e) => { files = [...files, ...e.target.files].slice(0, MAX_PHOTOS); e.target.value = ''; draw(); };
    f('fVid').onchange = (e) => { const v = e.target.files[0]; e.target.value = ''; if (!v) return; if (v.size > 20 * 1024 * 1024) { toast('Vidéo trop lourde (20 Mo maximum)'); return; } vfile = v; draw(); };
  }
  const upd = () => { const v = +f('f3').value || 0; f('calc').textContent = `Caution demandée : ${fmt(v * S.params.caution_mois)} · Acompte de blocage : ${fmt(Math.round((v * S.params.acompte_taux) / 500) * 500)}`; };
  f('f3').oninput = upd; upd();
  f('nlf').onsubmit = async (e) => {
    e.preventDefault();
    const v = (id) => f(id).value.trim(), err = f('nErr');
    if (v('f1').length < 4 || !v('f4') || !v('f5')) { err.textContent = 'Renseignez le titre (4 caractères minimum), le quartier et la ville.'; return; }
    if ((+f('f3').value || 0) < 10000) { err.textContent = 'Indiquez un loyer d’au moins 10 000 FCFA.'; return; }
    const btn = f('nGo'); btn.disabled = true; err.textContent = '';
    const row = { titre: v('f1'), type: f('f2').value, quartier: v('f4'), ville: v('f5'), loyer: Math.round(+f('f3').value), surface: Math.max(5, +f('f6').value || 0) || null,
      pieces: Math.max(1, Math.min(50, +f('fP').value || 1)), meuble: f('f7').value === '1', features: v('f8').split(',').map((s) => s.trim()).filter(Boolean), descr: v('f9') };
    if (l) {
      const { error } = await sb.from('listings').update(row).eq('id', l.id);
      if (error) { btn.disabled = false; err.textContent = errMsg(error); return; }
      closeModal(true); toast('Annonce mise à jour'); reload(); return;
    }
    const photos = [];
    for (const [i, x] of files.entries()) {
      btn.textContent = `Envoi des photos ${i + 1}/${files.length}…`;
      try { photos.push(await uploadPhoto(x)); } catch (ex) { toast('Photo ignorée : ' + errMsg(ex)); }
    }
    let video = null;
    if (vfile) { btn.textContent = 'Envoi de la vidéo…'; try { video = await uploadVideo(vfile); } catch (ex) { toast('Vidéo ignorée : ' + errMsg(ex)); } }
    const { error } = await sb.from('listings').insert({ ...row, owner_id: ME.id, photos, video });
    if (error) { btn.disabled = false; btn.textContent = 'Publier'; err.textContent = errMsg(error); photos.forEach(dropFile); return; }
    closeModal(true); toast('Annonce publiée'); await load(); go('pro-logements'); refresh();
  };
}
function managePhotos(lid) {
  const draw = (msg = '') => {
    const l = L(lid); if (!l) { closeModal(); return; }
    const ph = l.photos || [], full = ph.length >= MAX_PHOTOS;
    openModal(`<div class="m-h"><h2>Photos · ${esc(l.titre)}</h2><button class="x" aria-label="Fermer">×</button></div>
    <div class="m-b"><p class="muted" style="margin:0;font-size:13px">${ph.length}/${MAX_PHOTOS} photos. La première sert de couverture dans les annonces.</p>
      <div class="pgrid">${ph.map((r, i) => `<figure><img src="${esc(photoUrl(r))}" alt="Photo ${i + 1}">${i === 0 ? '<span class="cover">Couverture</span>' : ''}<div class="tools">${i ? `<button data-cv="${i}">Couverture</button>` : ''}<button data-rm="${i}">Retirer</button></div></figure>`).join('')}
        ${l.video ? `<figure><video src="${esc(photoUrl(l.video))}" muted playsinline preload="metadata"></video><div class="tools"><button data-rmv="1">Retirer la vidéo</button></div></figure>` : ''}</div>
      ${ph.length || l.video ? '' : '<p class="muted">Aucune photo : l’annonce affiche une illustration.</p>'}
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <label class="btn btn-primary" ${full ? 'style="opacity:.45;pointer-events:none" aria-disabled="true"' : ''}>Ajouter des photos<input type="file" id="mpAdd" accept="image/*" multiple hidden></label>
        <label class="btn btn-ghost">${l.video ? 'Remplacer' : 'Ajouter'} la vidéo<input type="file" id="mpVid" accept="video/mp4,video/webm" hidden></label>
      </div><p class="muted" id="mpMsg" style="font-size:13px;min-height:1em;margin:10px 0 0">${esc(msg)}</p></div>`, true);
    const save = async (patch) => {
      const { error } = await sb.from('listings').update(patch).eq('id', lid);
      if (error) { toast(errMsg(error)); return false; }
      Object.assign(L(lid), patch); return true;
    };
    $('#modal').querySelectorAll('[data-cv]').forEach((b) => (b.onclick = async () => { const p = [...ph]; const [r] = p.splice(+b.dataset.cv, 1); p.unshift(r); if (await save({ photos: p })) draw(); }));
    $('#modal').querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { const p = [...ph]; const [r] = p.splice(+b.dataset.rm, 1); if (await save({ photos: p })) { dropFile(r); draw(); } }));
    $('#modal').querySelectorAll('[data-rmv]').forEach((b) => (b.onclick = async () => { const r = l.video; if (await save({ video: null })) { dropFile(r); draw(); } }));
    $('#mpAdd').onchange = async (e) => {
      const list = [...e.target.files].slice(0, MAX_PHOTOS - ph.length); e.target.value = '';
      const refs = [];
      for (const [i, x] of list.entries()) { $('#mpMsg').textContent = `Envoi ${i + 1}/${list.length}…`; try { refs.push(await uploadPhoto(x)); } catch (ex) { toast('Photo ignorée : ' + errMsg(ex)); } }
      if (refs.length && await save({ photos: [...ph, ...refs].slice(0, MAX_PHOTOS) })) draw(`${pl(refs.length, 'photo ajoutée', 'photos ajoutées')}`); else draw();
    };
    $('#mpVid').onchange = async (e) => {
      const v = e.target.files[0]; e.target.value = ''; if (!v) return;
      $('#mpMsg').textContent = 'Envoi de la vidéo…';
      try { const p = await uploadVideo(v), old = l.video; if (await save({ video: p })) { dropFile(old); draw('Vidéo ajoutée'); } }
      catch (ex) { draw('Vidéo refusée : ' + errMsg(ex)); }
    };
  };
  draw();
}

/* ============ Espace gestionnaire ============ */
const isTransfer = (p) => p.provider === 'transfert_wave' || p.provider === 'transfert_om';
function renderAdmin(sec) {
  const all = S.bookings;
  const seq = all.filter((b) => ['sequestre', 'a_verser', 'a_rembourser'].includes(b.fonds)).reduce((a, b) => a + paid(b), 0);
  const verse = S.payouts.filter((p) => p.kind === 'caution_proprio' && ['reussi', 'manuel'].includes(p.statut)).reduce((a, p) => a + p.montant, 0);
  const toCheck = all.flatMap((b) => (b.payments || []).filter((p) => isTransfer(p) && p.declare_le && ['en_attente', 'expire'].includes(p.status)).map((p) => ({ b, p })));
  const toPay = S.payouts.filter((p) => ['a_faire', 'echoue'].includes(p.statut));
  const litiges = all.filter((b) => b.fin?.etape === 'conteste');
  const head = (t, extra = '') => `<div class="section-h"><div><div class="eyebrow">Neeg Loc Admin</div><h1>${t}</h1></div>${extra}</div>`;
  const alertBox = (n, txt, to) => (n ? `<button class="alert" data-go="${to}"><span>${txt}</span><span>Ouvrir →</span></button>` : '');
  let body = '';
  if (sec === 'overview') {
    const counts = [1, 2, 3, 4, 5].map((s) => all.filter((b) => stepOf(b) === s && b.etat !== 'clos').length);
    const labels = ['Réservées', 'Contrat à signer', 'Rendez-vous à fixer', 'Clés à remettre', 'Baux en cours'];
    body = head('Vue d’ensemble')
      + alertBox(toCheck.length, `${pl(toCheck.length, 'transfert')} à vérifier`, 'adm-paiements')
      + alertBox(toPay.length, `${pl(toPay.length, 'versement')} à effectuer (cautions, loyers, remboursements)`, 'adm-paiements')
      + alertBox(litiges.length, `${pl(litiges.length, 'litige')} de fin de bail à arbitrer`, 'adm-paiements') + `
    <div class="kpis">
      <div class="box kpi"><span class="muted">Fonds en séquestre</span><b class="num">${fmt(seq)}</b></div>
      <div class="box kpi"><span class="muted">Cautions versées</span><b class="num">${fmt(verse)}</b></div>
      <div class="box kpi"><span class="muted">Annonces en ligne</span><b class="num">${S.listings.filter((l) => l.statut !== 'suspendu').length}</b></div>
      <div class="box kpi"><span class="muted">Propriétaires</span><b class="num">${new Set(S.listings.map((l) => l.owner_id)).size}</b></div>
    </div>
    <h2 class="h2">Réservations par étape</h2>
    <div class="funnel">${counts.map((c, i) => `<div class="box"><span class="muted" style="font-size:13px">${labels[i]}</span><b class="num">${c}</b></div>`).join('')}</div>
    <h2 class="h2">Dernières notifications</h2>
    <div class="box" style="padding:0">${myNotifs().slice(0, 6).map(notifHTML).join('') || '<p class="muted" style="padding:18px;margin:0">Aucune notification.</p>'}</div>`;
  } else if (sec === 'paiements') {
    body = head('Paiements', '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost" id="mnt">Réconcilier les paiements</button><button class="btn btn-primary" id="run">Exécuter les versements</button></div>') + `
    <h2 class="h2">Transferts à vérifier</h2>
    <p class="muted" style="margin:-4px 0 12px;font-size:14px">Retrouvez chaque transfert dans l’historique de votre compte (montant, numéro, référence) avant de le valider.</p>
    <div class="tbl-wrap"><table><thead><tr><th>Réservation</th><th>Locataire</th><th>Objet</th><th class="r">Montant</th><th>Moyen</th><th>Référence</th><th>Expéditeur</th><th></th></tr></thead>
    <tbody>${toCheck.map(({ b, p }) => `<tr><td class="num"><b>${esc(b.id)}</b><div class="sub">${new Date(p.declare_le).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></td>
      <td>${esc(b.loc_nom)}</td><td>${esc(LIB.kind[p.kind])}${p.mois ? ' ' + moisLabel(p.mois) : ''}${p.status === 'expire' ? '<div class="sub">délai dépassé</div>' : ''}</td><td class="r num"><b>${fmt(p.amount)}</b></td>
      <td>${lib('moyen', p.provider)}</td><td class="num">${esc(p.tx_id)}${p.declare_sms ? `<div class="sub" title="${esc(p.declare_sms)}">${esc(p.declare_sms.slice(0, 70))}</div>` : ''}</td><td class="num">${esc(p.payer_tel)}</td>
      <td style="white-space:nowrap"><button class="btn btn-primary btn-sm" data-tv="${p.id}">Reçu</button> <button class="btn btn-ghost btn-sm" data-tr="${p.id}">Non reçu</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">Aucun transfert en attente.</td></tr>'}</tbody></table></div>
    <h2 class="h2" style="margin-top:26px">Versements à effectuer</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Type</th><th>Bénéficiaire</th><th class="r">Montant</th><th>Moyen</th><th>Statut</th><th></th></tr></thead>
    <tbody>${toPay.map((x) => `<tr><td>${lib('versement', x.kind)}<div class="sub">${esc(x.booking_id)}</div></td><td>${esc(x.nom)}<div class="sub num">${esc(x.tel)}</div></td><td class="r num"><b>${fmt(x.montant)}</b></td>
      <td>${lib('moyen', x.provider)}</td><td>${lib('vstatut', x.statut)}${x.erreur ? `<div class="sub">${esc(x.erreur)}</div>` : ''}</td>
      <td><button class="btn btn-primary btn-sm" data-man="${x.id}">Marquer fait</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucun versement en attente.</td></tr>'}</tbody></table></div>
    <h2 class="h2" style="margin-top:26px">Litiges de fin de bail</h2>
    <div class="tbl-wrap"><table><thead><tr><th>Réservation</th><th>Locataire</th><th>Propriétaire</th><th class="r">Retenue</th><th>Contestation</th><th></th></tr></thead>
    <tbody>${litiges.map((b) => `<tr><td class="num"><b>${esc(b.id)}</b></td><td>${esc(b.loc_nom)}</td><td>${esc(b.prop_nom)}</td><td class="r num">${fmt(b.fin.retenue)}<div class="sub">sur ${fmt(b.caution)}</div></td><td style="max-width:280px">${esc(b.fin.contest)}</td>
      <td><button class="btn btn-primary btn-sm" data-act="arbitre" data-id="${b.id}">Arbitrer</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Aucun litige.</td></tr>'}</tbody></table></div>`;
  } else if (sec === 'reservations') {
    body = head('Réservations et baux') + `<div class="tbl-wrap"><table><thead><tr><th>Réf.</th><th>Logement</th><th>Locataire</th><th>Propriétaire</th><th class="r">Payé</th><th>Étape</th><th></th></tr></thead>
    <tbody>${all.map((b) => { const l = lg(b); return `<tr><td class="num"><b>${esc(b.id)}</b><div class="sub">${dfmt(b.created_at, { day: 'numeric', month: 'short' })}</div></td>
      <td>${esc(l.titre)}<div class="sub">${esc(l.quartier)}</div></td><td>${esc(b.loc_nom)}<div class="sub num">${esc(b.loc_tel)}</div></td><td>${esc(b.prop_nom)}</td>
      <td class="r num">${fmt(paid(b))}<div class="sub">sur ${fmt(b.caution)}</div></td><td>${stagePill(b)}</td>
      <td style="white-space:nowrap">${stepOf(b) >= 2 ? `<button class="btn btn-ghost btn-sm" data-act="contrat" data-id="${b.id}">Contrat</button>` : ''}${b.etat === 'bloque' ? ` <button class="btn btn-ghost btn-sm" data-act="prolong" data-id="${b.id}">+24 h</button>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">Aucune réservation.</td></tr>'}</tbody></table></div>`;
  } else if (sec === 'annonces') {
    body = head('Annonces') + `<div class="tbl-wrap"><table><thead><tr><th>Logement</th><th>Propriétaire</th><th>Ville</th><th class="r">Loyer</th><th>Photos</th><th>Statut</th><th></th></tr></thead>
    <tbody>${S.listings.map((l) => `<tr><td><b>${esc(l.titre)}</b><div class="sub">${esc(l.type)} · ${esc(l.quartier)}</div></td><td>${esc(l.proprio_nom)}</td><td>${esc(l.ville)}</td><td class="r num">${fmt(l.loyer)}</td><td>${(l.photos || []).length}</td><td>${statutPill(l.statut)}</td>
      <td>${l.statut === 'disponible' ? `<button class="btn btn-ghost btn-sm" data-mod="${l.id}" data-s="1">Suspendre</button>` : l.statut === 'suspendu' ? `<button class="btn btn-ghost btn-sm" data-mod="${l.id}" data-s="0">Réactiver</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Aucune annonce.</td></tr>'}</tbody></table></div>`;
  } else {
    body = head('Journal des notifications') + `<p class="muted" style="margin:-6px 0 12px;font-size:14px">Messages prévus pour les gestionnaires.</p>
      <div class="box" style="padding:0">${myNotifs().map(notifHTML).join('') || '<p class="muted" style="padding:18px;margin:0">Aucune notification.</p>'}</div>`;
    markSeen();
  }
  app.innerHTML = body;
  app.querySelectorAll('[data-mod]').forEach((btn) => (btn.onclick = async () => {
    try { await rpc('moderer_annonce', { p_listing: btn.dataset.mod, p_suspendre: btn.dataset.s === '1' }); toast(btn.dataset.s === '1' ? 'Annonce suspendue' : 'Annonce réactivée'); reload(); } catch { /* affiché */ }
  }));
  app.querySelectorAll('[data-tv]').forEach((btn) => (btn.onclick = async () => {
    btn.disabled = true;
    try { const r = await rpc('valider_transfert', { p_payment: btn.dataset.tv, p_ok: true }); toast(r === 'ok' ? 'Transfert validé' : r === 'paiement_tardif' ? 'Validé : réservation terminée, remboursement programmé' : 'Résultat : ' + r); reload(); } catch { btn.disabled = false; }
  }));
  app.querySelectorAll('[data-tr]').forEach((btn) => (btn.onclick = () => {
    openModal(`<div class="m-h"><h2>Transfert non reçu</h2><button class="x" aria-label="Fermer">×</button></div>
      <div class="m-b"><div class="field"><label for="trNote">Motif envoyé au locataire</label><textarea class="input" id="trNote" rows="3">Transfert introuvable dans l’historique.</textarea></div>
      <button class="btn btn-red btn-block" id="trGo">Refuser le transfert</button></div>`);
    $('#trGo').onclick = async () => { try { await rpc('valider_transfert', { p_payment: btn.dataset.tr, p_ok: false, p_note: $('#trNote').value.trim() }); closeModal(true); toast('Transfert refusé'); reload(); } catch { /* affiché */ } };
  }));
  app.querySelectorAll('[data-man]').forEach((btn) => (btn.onclick = () => {
    const x = S.payouts.find((p) => p.id === btn.dataset.man);
    transferModal({ title: lib('versement', x.kind), amount: x.montant,
      intro: `Envoyez <b class="num">${fmt(x.montant)}</b> à <b>${esc(x.nom)}</b>, au <b class="num">${esc(x.tel)}</b>, depuis votre compte Wave ou Orange Money, puis recopiez l’identifiant de la transaction.`,
      onDone: async (ref) => { await rpc('marquer_payout', { p_payout: x.id, p_ref: ref }); toast('Versement enregistré'); } });
  }));
  const run = $('#run'), mnt = $('#mnt');
  if (run) run.onclick = async () => { run.disabled = true; const { data, error } = await sb.functions.invoke('payouts-run', { body: {} }); run.disabled = false; toast(error ? 'Versements automatiques indisponibles' : `${pl(data.versements.length, 'versement traité', 'versements traités')}`); reload(); };
  if (mnt) mnt.onclick = async () => { mnt.disabled = true; const { data, error } = await sb.functions.invoke('paiements-maintenance', { body: {} }); mnt.disabled = false; toast(error ? 'Réconciliation indisponible' : `${pl(data.reconcilies.length, 'paiement vérifié', 'paiements vérifiés')}`); reload(); };
  fillAsync();
}

/* ============ Modale et toast ============ */
const overlay = $('#overlay'), modal = $('#modal');
let onCancel = null;
function openModal(html, wide, cancel) {
  modal.className = 'modal' + (wide ? ' wide' : ''); modal.innerHTML = html; overlay.hidden = false;
  onCancel = cancel || null;
  const x = modal.querySelector('.x'); if (x) x.onclick = () => closeModal();
  const first = modal.querySelector('input:not([type=file]),textarea,select'); if (first && matchMedia('(pointer:fine)').matches) setTimeout(() => first.focus(), 30);
}
function closeModal(ok) {
  overlay.hidden = true; modal.innerHTML = '';
  const c = onCancel; onCancel = null; if (!ok && c) c();
  if (held) refresh();
}
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeModal(); });
let tT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(tT); tT = setTimeout(() => (t.hidden = true), 3200); }

/* Compte à rebours des blocages */
setInterval(() => document.querySelectorAll('[data-exp]').forEach((e) => { e.textContent = left(+e.dataset.exp - Date.now()); }), 30e3);

/* ============ Démarrage ============ */
let started = false;
sb.auth.onAuthStateChange((_ev, session) => setTimeout(async () => {
  const u = session?.user ?? null;
  if (started && (u?.id ?? null) === (ME?.id ?? null)) return;
  started = true; ME = u;
  await load(); subscribe(); route(false);
}, 0));
})();
