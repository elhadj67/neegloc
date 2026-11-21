/* NeegPay : fenêtre de paiement Neeg Loc (Wave, Orange Money, simulateur).
 * Parcours inspiré des pages de paiement des agrégateurs : choix de l'opérateur, numéro,
 * validation chez l'opérateur, suivi du statut en direct, reçu.
 *
 *   NeegPay.init(supabaseClient, { moyens: ['wave', 'orange_money', 'simulateur'] });
 *   NeegPay.payer({ bookingId, kind: 'acompte', montant: 75000, libelle: 'Studio Mermoz', tel: '77…', onSucces });
 *
 * Le montant affiché n'est qu'indicatif : le serveur recalcule toujours le montant exigible.
 */
(function () {
  const MOYENS = {
    wave:         { nom: 'Wave',              sigle: 'W',   couleur: '#1BA6E0', aide: 'Vous validez le paiement dans l’application Wave.' },
    orange_money: { nom: 'Orange Money',      sigle: 'OM',  couleur: '#F07A10', aide: 'Scannez le QR code ou ouvrez Max It pour valider.' },
    simulateur:   { nom: 'Simulateur (test)', sigle: 'SIM', couleur: '#5D6B65', aide: 'Paiement fictif : aucun argent ne circule.' },
    transfert_wave: { nom: 'Wave (transfert)',         sigle: 'W',  couleur: '#1BA6E0', aide: 'Transfert depuis l’app Wave, vérifié par Neeg Loc.' },
    transfert_om:   { nom: 'Orange Money (transfert)', sigle: 'OM', couleur: '#F07A10', aide: 'Transfert par Max It ou #144#, vérifié par Neeg Loc.' },
  };
  // Extrait la référence et le montant d'un SMS / d'une notification de confirmation
  function lireSms(t) {
    t = t || '';
    const tx = (t.match(/\b(MP\d{6}\.\d{4}\.[A-Z0-9]+)\b/i) || t.match(/\b(T_[A-Z0-9]{6,})\b/i)
      || t.match(/(?:\bID\b|Trans(?:action)?|R[ée]f(?:[ée]rence)?)\s*(?:ID)?\s*[:#]?\s*([A-Z0-9][A-Z0-9._-]{5,})/i) || [])[1] || null;
    const am = (t.match(/(\d{1,3}(?:[\s.  ]\d{3})+|\d{4,})\s*(?:F\s?CFA|XOF|F\b)/i) || [])[1];
    return { tx, montant: am ? +am.replace(/\D/g, '') : null };
  }
  const KIND = { acompte: 'Acompte de blocage', caution: 'Caution', solde: 'Solde de caution', loyer: 'Loyer' };
  const ERREURS = {
    non_authentifie: 'Votre session a expiré : reconnectez-vous.',
    moyen_indisponible: 'Ce moyen de paiement n’est pas disponible pour le moment.',
    reservation_introuvable: 'Réservation introuvable.',
    paiement_non_attendu: 'Ce paiement n’est plus attendu (il a peut-être déjà été réglé).',
    mois_non_attendu: 'Ce loyer n’est pas le prochain à régler.',
    numero_invalide: 'Numéro de téléphone invalide (9 chiffres).',
    operateur_indisponible: 'Le service de paiement ne répond pas. Réessayez dans un instant.',
    transfert_en_verification: 'Un transfert déjà déclaré est en cours de vérification par Neeg Loc.',
    reference_invalide: 'Recopiez l’identifiant complet de la transaction.',
    reference_deja_utilisee: 'Cette référence de transaction a déjà été déclarée.',
  };
  const CSS = `
  .np-ov{position:fixed;inset:0;z-index:9999;background:rgba(8,14,12,.55);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Manrope,system-ui,-apple-system,"Segoe UI",sans-serif}
  .np{background:#fff;color:#14231F;border-radius:20px;width:min(440px,100%);max-height:94vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)}
  .np-h{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid #E1E6E1}
  .np-h b{font-size:15px}.np-x{border:0;background:#F4F6F3;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer}
  .np-b{padding:18px}
  .np-sum{background:#F4F6F3;border-radius:14px;padding:14px 16px;margin-bottom:16px}
  .np-sum small{display:block;color:#5D6B65;font-size:12.5px}.np-amt{font-size:30px;font-weight:700;letter-spacing:-.01em;margin-top:2px;font-variant-numeric:tabular-nums}
  .np-l{font-size:13px;font-weight:700;margin:0 0 8px}
  .np-ops{display:grid;gap:10px;margin-bottom:14px}
  .np-op{display:flex;gap:12px;align-items:center;border:2px solid #E1E6E1;border-radius:14px;padding:12px;background:#fff;cursor:pointer;text-align:left;font:inherit}
  .np-op[aria-pressed=true]{border-color:#0B5A32;background:#E1EFE6}
  .np-logo{width:40px;height:40px;border-radius:11px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:13px;flex:none}
  .np-op span{display:block;font-size:12.5px;color:#5D6B65}
  .np-in{width:100%;border:1px solid #E1E6E1;border-radius:10px;padding:11px 12px;font:inherit;background:#F4F6F3;box-sizing:border-box}
  .np-btn{width:100%;border:0;border-radius:12px;padding:14px;font:inherit;font-weight:700;color:#fff;background:#C8102E;cursor:pointer;margin-top:14px}
  .np-btn[disabled]{opacity:.5;cursor:wait}.np-btn.np-g{background:#fff;color:#14231F;border:1px solid #E1E6E1}
  .np-err{color:#A8680F;font-size:13px;min-height:1em;margin:8px 0 0}
  .np-c{text-align:center}.np-spin{width:46px;height:46px;border-radius:50%;border:4px solid #E1E6E1;border-top-color:#0B5A32;animation:np-s .9s linear infinite;margin:10px auto 14px}
  @keyframes np-s{to{transform:rotate(360deg)}}
  .np-ok{width:64px;height:64px;border-radius:50%;background:#E3F2E8;color:#2F7F52;display:grid;place-items:center;margin:6px auto 12px}
  .np-ko{background:#FBF0DE;color:#A8680F}
  .np-qr{width:220px;height:220px;margin:6px auto;display:block;image-rendering:pixelated}
  .np-secu{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#5D6B65;margin-top:14px}
  .np-row{display:flex;justify-content:space-between;font-size:13.5px;padding:6px 0;border-bottom:1px solid #E1E6E1}
  @media (max-width:520px){.np-ov{align-items:flex-end;padding:0}.np{border-radius:20px 20px 0 0}}
  @media (prefers-color-scheme:dark){.np{background:#151F1C;color:#E8EFEB}.np-h{border-color:#24312D}.np-sum,.np-in,.np-x{background:#0D1412;color:#E8EFEB;border-color:#24312D}
    .np-op{background:#151F1C;border-color:#24312D;color:#E8EFEB}.np-op[aria-pressed=true]{background:#1A2D27;border-color:#58B892}.np-btn.np-g{background:#151F1C;color:#E8EFEB;border-color:#24312D}}
  @media (prefers-reduced-motion:reduce){.np-spin{animation:none}}`;

  let sb = null, cfg = { moyens: ['wave'] };
  const fmt = (n) => Math.round(n).toLocaleString('fr-FR') + ' FCFA';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || matchMedia('(pointer:coarse)').matches;
  const ICON_OK = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12l5 5L20 7"/></svg>';
  const ICON_KO = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  async function codeErreur(error) {
    try { const j = await error.context.json(); return j.error || 'erreur'; } catch { return 'erreur'; }
  }

  function init(supabaseClient, config = {}) {
    sb = supabaseClient;
    cfg = { ...cfg, ...config };
    if (!document.getElementById('np-css')) {
      const st = document.createElement('style'); st.id = 'np-css'; st.textContent = CSS; document.head.appendChild(st);
    }
  }

  function payer(o) {
    if (!sb) throw new Error('NeegPay.init() doit être appelé avant payer()');
    const ov = document.createElement('div'); ov.className = 'np-ov';
    ov.innerHTML = '<div class="np" role="dialog" aria-modal="true" aria-label="Paiement Neeg Loc"></div>';
    document.body.appendChild(ov);
    const box = ov.firstChild;
    let moyen = cfg.moyens[0], stop = () => {};
    const fermer = () => { stop(); ov.remove(); o.onFermer && o.onFermer(); };
    const titre = `${KIND[o.kind] || 'Paiement'}${o.mois ? ' · ' + o.mois : ''}`;
    const head = `<div class="np-h"><b>Paiement sécurisé · Neeg Loc</b><button class="np-x" aria-label="Fermer">×</button></div>`;
    const resume = `<div class="np-sum"><small>${esc(titre)}${o.libelle ? ' · ' + esc(o.libelle) : ''}</small><div class="np-amt">${o.montant ? fmt(o.montant) : '…'}</div><small>Réservation ${esc(o.bookingId)}</small></div>`;
    const render = (html) => { box.innerHTML = head + `<div class="np-b">${html}</div>`; box.querySelector('.np-x').onclick = fermer; };
    ov.addEventListener('click', (e) => { if (e.target === ov) fermer(); });

    const choix = (err = '') => {
      render(`${resume}<p class="np-l">Choisissez votre moyen de paiement</p>
        <div class="np-ops">${cfg.moyens.map((m) => `<button class="np-op" data-m="${m}" aria-pressed="${m === moyen}">
          <span class="np-logo" style="background:${MOYENS[m].couleur}">${MOYENS[m].sigle}</span>
          <div><b>${MOYENS[m].nom}</b><span>${MOYENS[m].aide}</span></div></button>`).join('')}</div>
        <label class="np-l" for="np-tel">Votre numéro ${esc(MOYENS[moyen]?.nom || '')}</label>
        <input class="np-in" id="np-tel" inputmode="tel" autocomplete="tel" placeholder="77 000 00 00" value="${esc(o.tel || '')}">
        <p class="np-err" role="alert">${esc(err)}</p>
        <button class="np-btn" id="np-go">Payer ${o.montant ? fmt(o.montant) : ''}</button>
        <div class="np-secu"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Vous validez le paiement chez l’opérateur, avec votre code secret. Neeg Loc ne voit jamais votre code et reçoit la confirmation directement de l’opérateur.</div>`);
      box.querySelectorAll('.np-op').forEach((b) => b.onclick = () => { o.tel = box.querySelector('#np-tel').value; moyen = b.dataset.m; choix(); });
      box.querySelector('#np-go').onclick = lancer;
    };

    async function lancer() {
      const tel = box.querySelector('#np-tel').value.trim();
      if (tel.replace(/\D/g, '').length < 9) return choix('Indiquez votre numéro à 9 chiffres.');
      o.tel = tel;
      const btn = box.querySelector('#np-go'); btn.disabled = true; btn.textContent = 'Connexion à ' + MOYENS[moyen].nom + '…';
      const { data, error } = await sb.functions.invoke('payments-create', {
        body: { booking_id: o.bookingId, kind: o.kind, mois: o.mois || null, provider: moyen, payer_tel: tel },
      });
      if (error) { const c = await codeErreur(error); return choix(ERREURS[c] || 'Paiement impossible pour le moment (' + c + ').'); }
      o.montant = data.amount;
      try { sessionStorage.setItem('neegpay-en-cours', JSON.stringify({ id: data.payment_id, retour: location.href })); } catch { /* navigation privée */ }
      attente(data);
    }

    function transfert(d) {
      const a = d.action, wave = a.operateur === 'Wave';
      render(`${resume}<ol style="padding-left:20px;margin:0 0 12px;display:grid;gap:8px;font-size:14px">
          <li>${wave ? 'Ouvrez l’application Wave et touchez « Envoyer ».' : 'Ouvrez Max It ou composez #144#, puis « Transfert d’argent ».'}</li>
          <li>Envoyez exactement <b>${fmt(a.montant)}</b> au :
            <div class="np-sum" style="margin:8px 0 0;display:flex;justify-content:space-between;align-items:center;gap:10px">
              <div><b style="font-size:18px">${esc(a.numero)}</b><small>${esc(a.nom || 'Neeg Loc')} · ${esc(a.operateur)}</small></div>
              <button class="np-x" style="width:auto;border-radius:10px;padding:0 12px;font-weight:700" id="np-cp">Copier</button></div></li>
          <li>Indiquez <b>${esc(a.reference)}</b> en motif si l’application le permet.</li>
          <li>Collez ci-dessous le message de confirmation reçu.</li></ol>
        ${wave ? '' : '<a class="np-btn np-g" style="display:block;text-align:center;text-decoration:none;margin:0 0 12px" href="tel:%23144%23">Composer #144#</a>'}
        <label class="np-l" for="np-sms">Message de confirmation</label>
        <textarea class="np-in" id="np-sms" rows="3" placeholder="Collez le SMS ou la notification"></textarea>
        <small id="np-smsinfo" style="font-size:12.5px;display:block;margin:4px 0 10px"></small>
        <label class="np-l" for="np-tx">Identifiant de la transaction</label>
        <input class="np-in" id="np-tx" autocomplete="off" placeholder="${wave ? 'Ex. T_8KQ2M4XAPL' : 'Ex. MP251121.1012.C55318'}">
        <label class="np-l" for="np-from" style="margin-top:10px;display:block">Numéro qui a envoyé l’argent</label>
        <input class="np-in" id="np-from" inputmode="tel" value="${esc(o.tel || '')}">
        <p class="np-err" id="np-terr" role="alert"></p>
        <button class="np-btn" id="np-decl">J’ai envoyé le transfert</button>
        <button class="np-btn np-g" id="np-annul">Changer de moyen de paiement</button>`);
      box.querySelector('#np-cp').onclick = async () => {
        try { await navigator.clipboard.writeText(a.numero.replace(/\s/g, '')); box.querySelector('#np-cp').textContent = 'Copié'; } catch { /* copie impossible */ }
      };
      const sms = box.querySelector('#np-sms'), info = box.querySelector('#np-smsinfo');
      sms.oninput = () => {
        const r = lireSms(sms.value);
        if (r.tx) box.querySelector('#np-tx').value = r.tx;
        const parts = [];
        if (r.tx) parts.push('Transaction ' + esc(r.tx) + ' détectée.');
        if (r.montant != null) parts.push(r.montant === a.montant ? 'Montant conforme.' : `Montant ${fmt(r.montant)} différent de ${fmt(a.montant)} : vérifiez votre envoi.`);
        info.innerHTML = parts.join(' ');
        info.style.color = r.montant != null && r.montant !== a.montant ? '#A8680F' : '#2F7F52';
      };
      box.querySelector('#np-annul').onclick = () => choix();
      box.querySelector('#np-decl').onclick = async () => {
        const tx = box.querySelector('#np-tx').value.trim(), from = box.querySelector('#np-from').value.trim(), err = box.querySelector('#np-terr');
        if (tx.length < 6) { err.textContent = ERREURS.reference_invalide; return; }
        if (from.replace(/\D/g, '').length < 9) { err.textContent = ERREURS.numero_invalide; return; }
        const btn = box.querySelector('#np-decl'); btn.disabled = true;
        const { error } = await sb.rpc('declarer_transfert', { p_payment: d.payment_id, p_tx: tx, p_from: from, p_sms: sms.value.trim() || null });
        if (error) { btn.disabled = false; const c = (error.message || '').trim(); err.textContent = ERREURS[c] || 'Déclaration impossible (' + c + ').'; return; }
        render(`${resume}<div class="np-c"><div class="np-spin" aria-hidden="true"></div><b>Transfert déclaré</b>
          <p style="font-size:14px;color:#5D6B65">Neeg Loc vérifie la réception de ${fmt(a.montant)} (réf. ${esc(tx)}). Vous pouvez fermer cette fenêtre : vous serez prévenu dès la validation.</p></div>
          <p class="np-err" id="np-info" role="status"></p>`);
        suivre(d.payment_id);
      };
    }

    function attente(d) {
      const a = d.action;
      if (a.type === 'transfert') return transfert(d);
      let corps;
      if (a.type === 'qr') {
        corps = `${a.qr ? `<img class="np-qr" src="${esc(a.qr)}" alt="QR code de paiement">` : ''}
          <p class="np-c" style="font-size:14px">Scannez ce QR code avec Max It ou l’application Orange Money.</p>
          ${Object.entries(a.deeplinks || {}).map(([k, u]) => `<a class="np-btn" style="display:block;text-align:center;text-decoration:none;background:#F07A10" href="${esc(u)}">Ouvrir ${esc(k === 'MAXIT' ? 'Max It' : k)}</a>`).join('')}
          ${a.url ? `<a class="np-btn np-g" style="display:block;text-align:center;text-decoration:none" href="${esc(a.url)}" target="_blank" rel="noopener">Ouvrir la page de paiement</a>` : ''}`;
      } else {
        if (mobile()) { location.href = a.url; }   // ouvre l'application de l'opérateur ; retour par retour.html
        else { window.open(a.url, '_blank', 'noopener'); }
        corps = `<p class="np-c" style="font-size:14px">La page de paiement ${esc(MOYENS[moyen].nom)} s’est ouverte. Validez le paiement de <b>${fmt(d.amount)}</b>, puis revenez ici.</p>
          <a class="np-btn np-g" style="display:block;text-align:center;text-decoration:none" href="${esc(a.url)}" target="_blank" rel="noopener">Rouvrir la page de paiement</a>`;
      }
      render(`${resume}<div class="np-c"><div class="np-spin" aria-hidden="true"></div><b>En attente de votre validation…</b></div>${corps}
        <p class="np-err" id="np-info" role="status"></p><button class="np-btn np-g" id="np-annul">Changer de moyen de paiement</button>`);
      box.querySelector('#np-annul').onclick = () => { stop(); choix(); };
      suivre(d.payment_id);
    }

    function suivre(id) {
      let fini = false, t = null;
      const debut = Date.now();
      const conclure = (p) => {
        if (fini) return;
        if (p.status === 'reussi') { fini = true; stop(); succes(p); }
        else if (p.status === 'echoue' || p.status === 'expire') { fini = true; stop(); echec(p); }
      };
      const ch = sb.channel('np-' + id)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'payments', filter: `id=eq.${id}` }, (ev) => conclure(ev.new))
        .subscribe();
      const poll = async () => {
        if (fini) return;
        const { data } = await sb.functions.invoke('payments-status?id=' + encodeURIComponent(id), { method: 'GET' });
        if (data) conclure(data);
        if (!fini && Date.now() - debut > 15 * 60_000) {
          const i = box.querySelector('#np-info'); if (i) i.textContent = 'Toujours en attente. Si vous avez payé, la confirmation arrivera automatiquement.';
        }
        if (!fini) t = setTimeout(poll, 5000);
      };
      t = setTimeout(poll, 4000);
      stop = () => { fini = true; clearTimeout(t); sb.removeChannel(ch); };
    }

    function succes(p) {
      try { sessionStorage.removeItem('neegpay-en-cours'); } catch { /* ignoré */ }
      render(`<div class="np-c"><div class="np-ok">${ICON_OK}</div><h2 style="margin:0 0 6px;font-size:22px">Paiement reçu</h2></div>
        <div class="np-row"><span>Montant</span><b>${fmt(p.amount)}</b></div>
        <div class="np-row"><span>Moyen</span><b>${esc(MOYENS[p.provider]?.nom || p.provider)}</b></div>
        ${p.tx_id ? `<div class="np-row"><span>Transaction</span><b>${esc(p.tx_id)}</b></div>` : ''}
        <div class="np-row"><span>Objet</span><b>${esc(titre)}</b></div>
        <button class="np-btn" style="background:#0B5A32" id="np-fin">Continuer</button>`);
      box.querySelector('#np-fin').onclick = () => { ov.remove(); o.onSucces && o.onSucces(p); };
    }

    function echec(p) {
      render(`<div class="np-c"><div class="np-ok np-ko">${ICON_KO}</div><h2 style="margin:0 0 6px;font-size:22px">Paiement non abouti</h2>
        <p style="font-size:14px;color:#5D6B65">${p.status === 'expire' ? 'Le délai de paiement est dépassé.' : 'Le paiement a été refusé ou annulé.'} Aucun montant n’a été débité par Neeg Loc.</p></div>
        <button class="np-btn" id="np-re">Réessayer</button>`);
      box.querySelector('#np-re').onclick = () => choix();
    }

    choix();
  }

  window.NeegPay = { init, payer, MOYENS, KIND };
})();
