/* DIVZ — make any coin pay divs. No framework, no keys: the server builds PumpSwap transactions, your wallet signs. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const S = { pools: [], stonk: [], all: [], venue: 'all', sort: 'milk', min: 25, q: '', cfg: {}, pool: null, tab: 'add', slip: 2, pct: 100, toSol: true, busy: false, positions: null, updated: 0, amt: '', solUsd: 0 };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };

  /* ---------- utils ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = bytes => { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x === 0) s = '1' + s; else break; } return s; };
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
  function compact(n) { n = Number(n); if (!isFinite(n)) return '—'; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M'; if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K'; if (a >= 100) return n.toFixed(0); if (a >= 1) return n.toFixed(2); if (a === 0) return '0'; return n.toPrecision(3); }
  function fsol(n, d) { n = Number(n) || 0; if (d != null) return n.toFixed(d); const a = Math.abs(n); return a >= 1000 ? compact(n) : a >= 1 ? n.toFixed(2) : a >= 0.01 ? n.toFixed(3) : a > 0 ? n.toFixed(5) : '0'; }
  const usd = n => { if (!S.solUsd || !isFinite(n)) return ''; const v = n * S.solUsd, a = Math.abs(v); return (v < 0 ? '−$' : '$') + (a >= 1e4 ? compact(a) : a.toFixed(a >= 100 ? 0 : 2)); };
  const coinAmt = (raw, dec) => Number(BigInt(raw || '0')) / Math.pow(10, dec || 6);
  const pctTxt = (x, d = 2) => (x * 100).toFixed(d) + '%';
  const sgn = (n, f = fsol) => (n >= 0 ? '+' : '−') + f(Math.abs(n));
  const age = ms => { if (!ms) return ''; const h = (Date.now() - ms) / 36e5; return h < 1 ? Math.max(1, Math.round(h * 60)) + 'm' : h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd'; };
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
  async function api(path, body) {
    const opt = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {};
    const r = await fetch('/api/' + path, opt);
    let j = null; try { j = await r.json(); } catch (e) { }
    if (!r.ok || !j || j.ok === false) { const e = new Error((j && j.error) || ('Request failed (' + r.status + ')')); e.logs = j && j.logs; throw e; }
    return j;
  }
  function tokImg(p, cls = 'tok') {
    const letter = esc(((p.symbol || p.name || '?')[0] || '?').toUpperCase());
    const img = p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.add('ok')" onerror="this.remove()">` : '';
    return `<span class="${cls}">${letter}${img}</span>`;
  }
  const label = p => esc(p.symbol ? '$' + p.symbol : short(p.mint));
  const vbadge = p => p.venue === 'stonkfun' ? '<span class="vb s">StonkFun</span>' : '<span class="vb">pump.fun</span>';
  const ease = t => t <= 0 ? 0 : t >= 1 ? 1 : t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeO = t => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
  const seg = (p, a, b) => Math.max(0, Math.min(1, (p - a) / (b - a)));

  /* ---------- wallet (Wallet Standard) ---------- */
  const W = { list: [], w: null, acct: null };
  function addWallet(w) {
    try {
      if (!w || !w.features || !w.name) return;
      const sol = (w.chains || []).some(c => String(c).startsWith('solana:'));
      const can = w.features['standard:connect'] && (w.features['solana:signTransaction'] || w.features['solana:signAndSendTransaction']);
      if (!sol || !can || W.list.some(x => x.name === w.name)) return;
      W.list.push(w);
      if (!W.w && store.get('divz:wallet') === w.name && w.accounts && w.accounts.length) use(w, w.accounts[0]);
      if (!$('#wModal').hidden) renderWallets();
    } catch (e) { }
  }
  const walletApi = Object.freeze({ register: (...ws) => { ws.forEach(addWallet); return () => { }; } });
  window.addEventListener('wallet-standard:register-wallet', e => { try { e.detail(walletApi); } catch (_) { } });
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: walletApi })); } catch (_) { }
  function use(w, acct) {
    W.w = w; W.acct = acct; store.set('divz:wallet', w.name);
    $('#walletBtn').classList.add('on'); $('#walletLabel').innerHTML = `<i class="dot"></i> ${short(acct.address)}`;
    try { w.features['standard:events'] && w.features['standard:events'].on('change', ({ accounts }) => { if (accounts && W.w === w) { if (accounts.length) use(w, accounts[0]); else disconnect(); } }); } catch (e) { }
    loadPositions(); if (S.pool && S.pool.pool) openPool(S.pool.pool, true);
  }
  function disconnect() {
    try { W.w && W.w.features['standard:disconnect'] && W.w.features['standard:disconnect'].disconnect(); } catch (e) { }
    W.w = null; W.acct = null; store.set('divz:wallet', '');
    $('#walletBtn').classList.remove('on'); $('#walletLabel').textContent = 'Connect wallet';
    renderPositions(); if (S.pool) renderDrawer();
  }
  const mobile = /iphone|ipad|android/i.test(navigator.userAgent);
  function renderWallets() {
    const box = $('#wList');
    $('#wModal h3').textContent = W.w ? 'Your wallet' : 'Connect a wallet';
    if (W.w) {
      box.innerHTML = `<p>${esc(W.w.name)}<br><code>${esc(W.acct.address)}</code></p><button class="wopt" type="button" id="wCopy">Copy address</button><button class="wopt" type="button" id="wOut">Disconnect</button>`;
      $('#wCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(W.acct.address).then(() => toast('Address copied')); };
      $('#wOut').onclick = () => { disconnect(); $('#wModal').hidden = true; toast('Disconnected'); };
      return;
    }
    if (!W.list.length) {
      const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
      box.innerHTML = mobile
        ? `<p>Open DIVZ inside your wallet app's browser:</p><a class="wopt" href="https://phantom.app/ul/browse/${here}?ref=${ref}">Open in Phantom</a><a class="wopt" href="https://solflare.com/ul/v1/browse/${here}?ref=${ref}">Open in Solflare</a>`
        : `<p>No Solana wallet found in this browser. Install one, then reload:</p><a class="wopt" href="https://phantom.com/download" target="_blank" rel="noopener">Phantom</a><a class="wopt" href="https://solflare.com/download" target="_blank" rel="noopener">Solflare</a><a class="wopt" href="https://backpack.app/download" target="_blank" rel="noopener">Backpack</a>`;
      return;
    }
    box.innerHTML = W.list.map((w, i) => `<button class="wopt" data-i="${i}" type="button">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}${esc(w.name)}<small>Detected</small></button>`).join('');
  }
  function connect() { renderWallets(); $('#wModal').hidden = false; }
  $('#wList').addEventListener('click', async e => {
    const b = e.target.closest('button.wopt[data-i]'); if (!b) return;
    const w = W.list[+b.dataset.i];
    try { b.disabled = true; const r = await w.features['standard:connect'].connect(); const acct = (r && r.accounts && r.accounts[0]) || (w.accounts && w.accounts[0]); if (!acct) throw new Error('No account shared'); $('#wModal').hidden = true; use(w, acct); toast('Connected ' + short(acct.address)); }
    catch (err) { toast(err && err.message ? err.message : 'Connection cancelled'); } finally { b.disabled = false; }
  });
  $('#walletBtn').addEventListener('click', connect);
  $('#wClose').addEventListener('click', () => { $('#wModal').hidden = true; });
  $('#wModal').addEventListener('click', e => { if (e.target.id === 'wModal') $('#wModal').hidden = true; });
  const needWallet = () => { if (!W.w) { connect(); return true; } return false; };
  async function waitFor(sig) {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await new Promise(r => setTimeout(r, 1300));
      try { const s = await api('status?sig=' + sig); if (s.err) throw Object.assign(new Error('The transaction failed on-chain.'), { chain: s.err }); if (s.status === 'confirmed' || s.status === 'finalized') return true; } catch (e) { if (e.chain) throw e; }
    }
    throw new Error('Not confirmed after 90 seconds. Check the link below before trying again.');
  }
  async function signSend(txs, step) {
    const f = W.w.features, chain = 'solana:mainnet', bytes = txs.map(t => fromB64(t.tx)), sigs = [];
    if (bytes.length === 1 && f['solana:signAndSendTransaction']) {
      step('sign');
      const [r] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: W.acct, chain, transaction: bytes[0], options: { commitment: 'confirmed', preflightCommitment: 'processed', maxRetries: 3 } });
      const sig = typeof r.signature === 'string' ? r.signature : b58(r.signature); sigs.push(sig);
      step('confirm', sigs); await waitFor(sig); return sigs;
    }
    if (f['solana:signTransaction']) {
      step('sign');
      const outs = await f['solana:signTransaction'].signTransaction(...bytes.map(t => ({ account: W.acct, chain, transaction: t })));
      for (let i = 0; i < outs.length; i++) { step('confirm', sigs, i); const { sig } = await api('send', { tx: toB64(outs[i].signedTransaction) }); sigs.push(sig); step('confirm', sigs, i); await waitFor(sig); }
      return sigs;
    }
    for (let i = 0; i < bytes.length; i++) {
      step('sign', sigs, i);
      const [r] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: W.acct, chain, transaction: bytes[i] });
      const sig = typeof r.signature === 'string' ? r.signature : b58(r.signature); sigs.push(sig); step('confirm', sigs, i); await waitFor(sig);
    }
    return sigs;
  }

  /* ---------- pools board ---------- */
  const KEY = { milk: p => p.milkPerSolDay, tvl: p => p.tvlSol, vol: p => p.volSol, fee: p => p.lpBps * 1e6 + p.milkPerSolDay, chg: p => p.change24 };
  function visible() { const q = S.q.trim().toLowerCase(); return S.all.filter(p => (S.venue === 'all' || p.venue === S.venue) && p.tvlSol >= S.min && (!q || (p.name + ' ' + p.symbol + ' ' + p.mint).toLowerCase().includes(q))).sort((x, y) => KEY[S.sort](y) - KEY[S.sort](x)); }
  function renderPools() {
    const rows = $('#rows'); const list = visible();
    if (!list.length) { rows.innerHTML = `<div class="empty"><b>${S.q ? 'No pool on the board matches that.' : 'No pools this size right now.'}</b>${S.q ? 'Paste the coin address in the search at the top to look it up on-chain.' : 'Try a smaller pool size.'}</div>`; return; }
    const top = Math.max(...list.map(p => p.milkPerSolDay), 1e-9);
    rows.innerHTML = list.map((p, i) => `
      <div class="tr row" data-pool="${esc(p.pool)}" style="animation-delay:${Math.min(i, 14) * 25}ms">
        <span class="c-cow">${tokImg(p)}<span class="nm"><b>${esc(p.name || short(p.mint))}${vbadge(p)}</b><small>${label(p)}${p.venue === 'stonkfun' && p.quote ? ' · paired with ' + esc(p.quote) : ''} · ${compact(p.mcapSol)} SOL mcap${p.created ? ' · ' + age(p.created) : ''}</small></span></span>
        <span><span class="big num">${pctTxt(p.milkPerSolDay)}</span><span class="mbar"><i style="width:${Math.max(3, Math.round(p.milkPerSolDay / top * 100))}%"></i></span></span>
        <span class="num">${compact(p.tvlSol)} SOL</span><span class="num">${compact(p.volSol)} SOL</span><span class="num">${(p.lpBps / 100).toFixed(2)}%</span>
        <span class="num ${p.change24 >= 0 ? 'up' : 'down'}">${p.change24 >= 0 ? '+' : ''}${(+p.change24).toFixed(1)}%</span>
        <span><button class="btn sm ${p.venue === 'stonkfun' ? '' : 'gold'}" type="button">${p.venue === 'stonkfun' ? 'Open' : 'Add'}</button></span>
      </div>`).join('');
  }
  function countTo(el, to, fmt) { if (!el) return; const from = +(el.dataset.v || 0); el.dataset.v = to; if (RM) { el.innerHTML = fmt(to); return } whenReady(() => { const t0 = performance.now(); const f = n => { const k = Math.min(1, (n - t0) / 1400); el.innerHTML = fmt(from + (to - from) * easeO(k)); if (k < 1) requestAnimationFrame(f) }; requestAnimationFrame(f) }) }
  function renderStats() {
    const P = S.all; if (!P.length) return;
    const vol = P.reduce((a, p) => a + p.volSol, 0), fees = P.reduce((a, p) => a + p.volSol * p.lpBps / 10000, 0), best = Math.max(...P.filter(p => p.tvlSol >= 25).map(p => p.milkPerSolDay), 0);
    const el = k => $(`#stats b[data-k="${k}"]`);
    countTo(el('n'), P.length, n => Math.round(n)); countTo(el('vol'), vol, n => compact(n) + '<small>SOL</small>'); countTo(el('fees'), fees, n => compact(n) + '<small>SOL</small>'); countTo(el('top'), best * 100, n => n.toFixed(2) + '<small>% / day</small>');
    for (const [id, v] of [['#vPump', 'pump'], ['#vStonk', 'stonkfun']]) {
      const L = P.filter(p => p.venue === v), card = $(id); if (!card) continue;
      const g = k => $(`b[data-k="${k}"]`, card);
      countTo(g('n'), L.length, n => Math.round(n)); countTo(g('vol'), L.reduce((a, p) => a + p.volSol, 0), n => compact(n) + '<small>SOL</small>'); countTo(g('fees'), L.reduce((a, p) => a + p.volSol * p.lpBps / 10000, 0), n => compact(n) + '<small>SOL</small>');
      const top = L.filter(p => p.tvlSol >= 25).sort((a, b) => b.milkPerSolDay - a.milkPerSolDay).slice(0, 4), mx = Math.max(...top.map(p => p.milkPerSolDay), 1e-9);
      $('.vtop', card).innerHTML = top.length ? top.map(p => `<div class="vrow" data-pool="${esc(p.pool)}">${tokImg(p)}<b>${label(p)}${p.quote ? ' <span class="mut" style="font-weight:600">/ ' + esc(p.quote) + '</span>' : ''}</b><span class="mbar"><i style="width:${Math.max(4, Math.round(p.milkPerSolDay / mx * 100))}%"></i></span><em class="num">${pctTxt(p.milkPerSolDay)}</em></div>`).join('') : `<div class="empty">${v === 'stonkfun' ? 'StonkFun pools are loading or unavailable right now.' : 'No pools right now.'}</div>`;
    }
  }
  function renderTicker() {
    const l = S.all.filter(p => p.tvlSol >= 25).sort((a, b) => b.milkPerSolDay - a.milkPerSolDay).slice(0, 26); if (!l.length) return;
    const html = l.map(p => `<a class="ti" href="#pools" data-pool="${esc(p.pool)}">${tokImg(p)}<b>${label(p)}</b>${vbadge(p)}<em>${pctTxt(p.milkPerSolDay)} / day</em><span>${compact(p.tvlSol)} SOL pool</span></a>`).join('');
    const t = $('#tickerT'); t.innerHTML = html + html; t.style.animationDuration = (l.length * 3.4) + 's';
  }
  $('#tickerT').addEventListener('click', e => { const a = e.target.closest('[data-pool]'); if (a) { e.preventDefault(); openPool(a.dataset.pool); } });
  function tickUpdated() { const el = $('#updated span'); if (!S.updated) return; const s = Math.round((Date.now() - S.updated) / 1000); el.textContent = 'Scanning pump.fun + StonkFun · ' + (s < 5 ? 'just now' : s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago'); }
  setInterval(tickUpdated, 1000);
  async function loadPools(quiet) {
    if (!quiet) $('#rows').innerHTML = '<div style="padding:8px 16px">' + '<div class="skel"></div>'.repeat(6) + '</div>';
    const [a, b] = await Promise.allSettled([api('pools'), api('stonk')]);
    if (a.status === 'fulfilled') { const j = a.value; S.pools = (j.pools || []).map(p => ({ ...p, venue: 'pump' })); S.updated = j.updated || Date.now(); S.solUsd = j.solUsd || S.solUsd; }
    if (b.status === 'fulfilled') { S.stonk = (b.value.pools || []).map(p => ({ ...p, venue: 'stonkfun' })); if (!S.solUsd) S.solUsd = b.value.solUsd || 0; }
    S.all = [...S.pools, ...S.stonk];
    if (!S.all.length) {
      if (quiet) return;
      $('#rows').innerHTML = `<div class="empty"><b>Could not reach the market.</b><button class="btn sm" id="retry" type="button" style="margin-top:10px">Retry</button></div>`;
      $('#retry').onclick = () => loadPools(); $('#updated span').textContent = 'Offline'; return;
    }
    renderPools(); renderStats(); renderTicker(); rcInit(); story.data(); mach.data(); topPayers(); tickUpdated();
  }
  setInterval(() => { if (!document.hidden && !S.busy) loadPools(true); }, 60000);
  $('#rows').addEventListener('click', e => { const r = e.target.closest('.row'); if (r) openPool(r.dataset.pool); });
  $('#th').addEventListener('click', e => { const b = e.target.closest('.sort'); if (!b) return; S.sort = b.dataset.s; $$('#th .sort').forEach(x => x.classList.toggle('on', x === b)); renderPools(); });
  $('#venue').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.venue = b.dataset.v; $$('#venue button').forEach(x => x.classList.toggle('on', x === b)); renderPools(); });
  $('#venues').addEventListener('click', e => { const r = e.target.closest('.vrow'); if (r) { openPool(r.dataset.pool); return; } const b = e.target.closest('[data-venue]'); if (!b) return; S.venue = b.dataset.venue; $$('#venue button').forEach(x => x.classList.toggle('on', x.dataset.v === S.venue)); renderPools(); $('#pools').scrollIntoView({ behavior: 'smooth' }); });
  $('#size').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.min = +b.dataset.m; $$('#size button').forEach(x => x.classList.toggle('on', x === b)); renderPools(); });
  $('#q').addEventListener('input', e => { S.q = e.target.value; renderPools(); });
  $('#find').addEventListener('submit', e => { e.preventDefault(); const v = $('#findIn').value.trim(); if (!v) return; if (isAddr(v)) { openPool(v); return; } S.q = v; $('#q').value = v; S.min = 0; $$('#size button').forEach(x => x.classList.toggle('on', x.dataset.m === '0')); renderPools(); $('#pools').scrollIntoView({ behavior: 'smooth' }); });
  addEventListener('keydown', e => { if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#pools').scrollIntoView({ behavior: 'smooth' }); setTimeout(() => $('#q').focus(), 400); } });

  /* ---------- the drawer ---------- */
  function openDrawer() { $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#veil').hidden = false; document.documentElement.style.overflow = 'hidden'; }
  function closeDrawer() { if (S.busy) return; $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#veil').hidden = true; document.documentElement.style.overflow = ''; S.pool = null; }
  $('#dClose').addEventListener('click', closeDrawer); $('#veil').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#wModal').hidden) $('#wModal').hidden = true; else if (S.pool) closeDrawer(); } });
  async function openPool(id, quiet, tab, amt) {
    const sf = S.stonk.find(x => x.pool === id);
    if (sf) { S.pool = sf; renderStonk(sf); openDrawer(); return; }
    if (!quiet) { S.pool = { pool: id, loading: true }; S.tab = tab || 'add'; S.amt = amt || ''; renderDrawer(); openDrawer(); }
    try { const j = await api('pool?id=' + encodeURIComponent(id) + (W.acct ? '&user=' + W.acct.address : '')); if (S.pool && (S.pool.pool === id || S.pool.mint === id || S.pool.pool === j.pool.pool || quiet)) { S.pool = j.pool; if (j.pool.solUsd) S.solUsd = j.pool.solUsd; renderDrawer(); } }
    catch (e) { if (!quiet) { S.pool = { pool: id, error: e.message }; renderDrawer(); } }
  }
  function renderStonk(p) {
    const el = $('#dIn'), sym = p.symbol ? '$' + p.symbol : 'the coin';
    const rows = [[-75, 0.25], [-50, 0.5], [100, 2], [300, 4]].map(([pc, r]) => { const v = Math.sqrt(r) - 1; return `<tr><td>${esc(sym)} ${pc > 0 ? '+' : ''}${pc}%</td><td class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%</td></tr>`; }).join('');
    el.innerHTML = `
      <div class="d-top">${tokImg(p, 'tok lg')}<div><h3>${esc(p.name || short(p.mint))} <span class="vb s">StonkFun</span></h3><small>${esc(sym)} · ${esc(p.pair || '')} on Raydium · <a href="${esc(p.sfUrl)}" target="_blank" rel="noopener">StonkFun page</a> · <a href="https://dexscreener.com/solana/${esc(p.pool)}" target="_blank" rel="noopener">chart</a></small></div></div>
      <div class="kv num"><div><span>Divs / day</span><b>${pctTxt(p.milkPerSolDay)}</b></div><div><span>Fee APR, 24h</span><b>${(p.apr * 100).toFixed(0)}%</b></div><div><span>Pool size</span><b>$${compact(p.tvlUsd)}</b></div><div><span>24h volume</span><b>$${compact(p.volUsd)}</b></div></div>
      <p class="feeline">This pool pays its liquidity about <b>${(p.lpBps / 100).toFixed(2)}% of every trade</b>, from a ${((p.feeRate || 0) * 100).toFixed(2)}% trading fee. Paired with <b>${esc(p.quote || '')}</b>, so you add both ${esc(sym)} and ${esc(p.quote || 'the pair')}.</p>
      <div class="sf-note">One-click add from SOL is for pump.fun pools for now. StonkFun pools live on Raydium: add there with the same wallet, and the position stays in your wallet.</div>
      ${p.poolType === 'Standard' ? `<div class="sim"><p><b>If ${esc(sym)}'s price moves</b> against ${esc(p.quote || 'its pair')}, your position changes like this, before fees:</p><table><tr><th>Price move</th><th>Position</th></tr>${rows}</table></div>` : ''}
      <a class="btn gold go" href="${esc(p.addUrl)}" target="_blank" rel="noopener">Add on Raydium →</a>
      <p class="fine">Rates are Raydium's 24h fee APR for this pool. Past pace, not a promise.</p>`;
  }
  function estimate(p, solIn) {
    try {
      const lamports = BigInt(Math.floor(solIn * 1e9)); if (lamports <= 0n) return null;
      const fee = BigInt(S.cfg.feeBps || 0); const jug = lamports * fee / 10000n; const budget = lamports - jug;
      const Rb = BigInt(p.reserves.coin), Rq = BigInt(p.reserves.solLamports), L = BigInt(p.lpSupply), vq = BigInt(p.reserves.vqr || '0');
      const f = p.feeBps, cd = (a, b) => (a + b - 1n) / b;
      const cost = b => { const q = cd((Rq + vq) * b, Rb - b); const g = bp => cd(q * BigInt(bp), 10000n); return { q, lf: g(f.lp), t: q + g(f.lp) + g(f.protocol) + g(f.creator) }; };
      let lo = 0n, hi = Rb / 2n;
      for (let i = 0; i < 90 && hi - lo > 1n; i++) { const m = (lo + hi) / 2n, c = cost(m); if (c.t >= budget) { hi = m; continue; } const D = budget - c.t; if (m * (Rq + c.q + c.lf) < D * (Rb - m)) lo = m; else hi = m; }
      const c = cost(lo), D = budget - c.t, Rq2 = Rq + c.q + c.lf, Rb2 = Rb - lo;
      let lp = lo * L / Rb2; const lq = D * L / Rq2; if (lq < lp) lp = lq;
      const share = Number(lp) / Number(L + lp), value = share * 2 * Number(Rq2 + D) / 1e9;
      return { jug: Number(jug) / 1e9, swap: Number(c.t) / 1e9, coin: Number(lo), dep: Number(D) / 1e9, share, value, milkDay: share * p.volSol * p.lpBps / 10000 };
    } catch (e) { return null; }
  }
  function renderDrawer() {
    const p = S.pool, el = $('#dIn'); if (!p) return;
    if (p.loading) { el.innerHTML = `<div class="d-top"><span class="tok lg"></span><div><h3>Finding the pool…</h3><small><span class="loader"></span>Reading PumpSwap on-chain</small></div></div><div class="skel" style="margin-top:20px;height:200px"></div>`; return; }
    if (p.error) { el.innerHTML = `<div class="empty"><b>${esc(p.error)}</b><button class="btn sm" type="button" id="dBack" style="margin-top:12px">Back to the pools</button></div>`; $('#dBack').onclick = closeDrawer; return; }
    const sym = p.symbol ? '$' + p.symbol : 'the coin';
    const you = p.you, hasPos = you && BigInt(you.lp || '0') > 0n;
    const f = p.feeBps || { lp: p.lpBps, protocol: 0, creator: 0 };
    el.innerHTML = `
      <div class="d-top">${tokImg(p, 'tok lg')}<div><h3>${esc(p.name || short(p.mint))}</h3>
        <small>${p.symbol ? esc('$' + p.symbol) + ' · ' : ''}<a href="https://solscan.io/account/${esc(p.pool)}" target="_blank" rel="noopener">pool ${short(p.pool)}</a> · <a href="https://dexscreener.com/solana/${esc(p.pool)}" target="_blank" rel="noopener">chart</a></small></div></div>
      <div class="kv num"><div><span>Divs / day</span><b>${p.volSol ? pctTxt(p.milkPerSolDay) : '—'}</b></div><div><span>Pool size</span><b>${compact(p.tvlSol)} SOL</b></div><div><span>24h volume</span><b>${p.volSol ? compact(p.volSol) + ' SOL' : '—'}</b></div><div><span>Market cap</span><b>${compact(p.mcapSol)} SOL</b></div></div>
      <p class="feeline">Each trade pays ${((f.lp + f.protocol + f.creator) / 100).toFixed(2)}%: <b>${(f.lp / 100).toFixed(2)}% stays in the pool for its liquidity</b>, ${(f.protocol / 100).toFixed(2)}% to PumpSwap, ${(f.creator / 100).toFixed(2)}% to the coin's creator.</p>
      ${hasPos ? `<div class="you">Your position: <b>${fsol(you.valueSol)} SOL</b> · ${pctTxt(you.share, 3)} of the pool · about ${fsol(you.share * p.volSol * p.lpBps / 10000)} SOL a day</div>` : ''}
      ${!p.solPool ? `<div class="status show err">This pool is not paired with SOL. DIVZ handles SOL pools for now.</div>` : `<div class="tabs"><button type="button" data-t="add" class="${S.tab === 'add' ? 'on' : ''}">Add</button><button type="button" data-t="remove" class="${S.tab === 'remove' ? 'on' : ''}">Withdraw</button></div><div id="pane"></div>`}
      <div class="status" id="st"></div>`;
    $$('.tabs button', el).forEach(b => b.onclick = () => { if (S.busy) return; S.tab = b.dataset.t; renderDrawer(); });
    if (p.solPool) S.tab === 'add' ? paneAdd(p, sym) : paneRemove(p, sym);
  }
  function paneAdd(p, sym) {
    const bal = p.you ? p.you.sol : null;
    $('#pane').innerHTML = `
      <div class="field"><div class="row1"><span>You put in</span>${bal != null ? `<button type="button" id="max">Balance ${fsol(bal)} SOL</button>` : ''}</div><div class="row2"><input id="amt" inputmode="decimal" placeholder="0.0" aria-label="SOL amount" value="${esc(S.amt)}"><span class="unit">SOL</span></div></div>
      <div class="chips" id="quick">${[0.1, 0.5, 1, 5].map(v => `<button class="chip" type="button" data-v="${v}">${v} SOL</button>`).join('')}</div>
      <div class="slip"><span>Max price move</span><div class="chips" id="slip">${[1, 2, 5].map(v => `<button class="chip ${S.slip === v ? 'on' : ''}" type="button" data-v="${v}">${v}%</button>`).join('')}</div></div>
      <div class="prev" id="prev"></div><div class="sim" id="sim" hidden></div>
      <button class="btn gold go" id="goAdd" type="button">${W.w ? 'Add from SOL' : 'Connect wallet'}</button>
      <p class="fine">Simulated first. Your wallet signs. LP tokens go to your wallet.</p>`;
    const amt = $('#amt');
    const upd = () => {
      S.amt = amt.value; const v = parseFloat(amt.value.replace(',', '.')); const e = v > 0 ? estimate(p, v) : null; const dec = p.decimals || 6;
      $('#prev').innerHTML = e ? `${e.jug ? `<div><span>Service fee (${(S.cfg.feeBps / 100).toFixed(1)}%)</span><b>${fsol(e.jug, 4)} SOL</b></div>` : ''}
        <div><span>Swapped for ${esc(sym)}</span><b>${fsol(e.swap)} SOL → ${compact(e.coin / Math.pow(10, dec))}</b></div>
        <div><span>Added to the pool</span><b>${fsol(e.dep)} SOL + ${compact(e.coin / Math.pow(10, dec))}</b></div>
        <div><span>Your share of the pool</span><b>${pctTxt(e.share, 3)}</b></div>
        <div class="hi"><span>Divs at the last 24h pace</span><b>${p.volSol ? '≈ ' + fsol(e.milkDay) + ' SOL / day' : '—'}</b></div>` : '';
      const sim = $('#sim'); if (!e) { sim.hidden = true; return; }
      const V = e.value;
      const rowsHtml = [[-75, 0.25], [-50, 0.5], [100, 2], [300, 4]].map(([pc, r]) => { const lp = V * Math.sqrt(r), d = lp / v - 1; return `<tr><td>${esc(sym)} ${pc > 0 ? '+' : ''}${pc}%</td><td>${fsol(lp)} SOL</td><td class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)}%</td></tr>`; }).join('');
      sim.hidden = false; sim.innerHTML = `<p><b>If the price moves</b> before you withdraw, your position changes like this, before any fees earned:</p><table><tr><th>Price move</th><th>Position</th><th>vs ${fsol(v)} SOL in</th></tr>${rowsHtml}</table>`;
    };
    amt.addEventListener('input', upd); upd();
    $('#quick').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; amt.value = b.dataset.v; upd(); };
    $('#slip').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; S.slip = +b.dataset.v; $$('#slip .chip').forEach(x => x.classList.toggle('on', x === b)); };
    const mx = $('#max'); if (mx) mx.onclick = () => { amt.value = Math.max(0, bal - 0.012).toFixed(3); upd(); };
    $('#goAdd').onclick = async () => {
      if (needWallet()) return;
      const v = parseFloat(amt.value.replace(',', '.')); if (!(v >= 0.01)) { toast('Enter at least 0.01 SOL'); amt.focus(); return; }
      await run('add', { kind: 'add', pool: p.pool, user: W.acct.address, sol: v, slippage: S.slip }, q => `Adds ${fsol(q.depositSol)} SOL + ${compact(coinAmt(q.depositCoin, q.decimals))} ${esc(sym)} · ${pctTxt(q.share, 3)} of the pool`);
    };
  }
  function paneRemove(p, sym) {
    const you = p.you, has = you && BigInt(you.lp || '0') > 0n;
    if (!W.w || !has) { $('#pane').innerHTML = `<div class="empty" style="padding:24px 8px">${W.w ? `<b>No liquidity here yet.</b>Add some first, then come back to withdraw.` : `<b>Connect to see your position.</b><button class="btn sm" id="cw" type="button" style="margin-top:10px">Connect wallet</button>`}</div>`; const cw = $('#cw'); if (cw) cw.onclick = connect; return; }
    $('#pane').innerHTML = `
      <div class="chips" id="pcts">${[25, 50, 75, 100].map(v => `<button class="chip ${S.pct === v ? 'on' : ''}" type="button" data-v="${v}">${v}%</button>`).join('')}</div>
      <label class="toggle"><span>Get it all back as SOL</span><span class="sw"><input type="checkbox" id="toSol" ${S.toSol ? 'checked' : ''}><i></i></span></label>
      <div class="slip"><span>Max price move</span><div class="chips" id="slip">${[1, 2, 5].map(v => `<button class="chip ${S.slip === v ? 'on' : ''}" type="button" data-v="${v}">${v}%</button>`).join('')}</div></div>
      <div class="prev" id="prev"></div>
      <button class="btn go" id="goRm" type="button">Withdraw</button>
      <p class="fine">Withdrawals are free. Network fees only.</p>`;
    const upd = () => { const fr = S.pct / 100, dec = p.decimals || 6; const coin = coinAmt(you.coinInPool, dec) * fr, solv = you.solInPool * fr;
      $('#prev').innerHTML = S.toSol ? `<div><span>From the pool</span><b>${fsol(solv)} SOL + ${compact(coin)} ${esc(sym)}</b></div><div class="hi"><span>You get about</span><b>${fsol(solv * 2 * (1 - p.totalBps / 10000))} SOL</b></div>` : `<div class="hi"><span>You get about</span><b>${fsol(solv)} SOL + ${compact(coin)}</b></div>`; };
    upd();
    $('#pcts').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; S.pct = +b.dataset.v; $$('#pcts .chip').forEach(x => x.classList.toggle('on', x === b)); upd(); };
    $('#toSol').onchange = e => { S.toSol = e.target.checked; upd(); };
    $('#slip').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; S.slip = +b.dataset.v; $$('#slip .chip').forEach(x => x.classList.toggle('on', x === b)); };
    $('#goRm').onclick = () => run('remove', { kind: 'remove', pool: p.pool, user: W.acct.address, pct: S.pct, toSol: S.toSol, slippage: S.slip }, q => q.toSol ? `Withdraws ${q.pct}% and sells the coin side: about ${fsol(q.solOut + q.sellSol)} SOL` : `Withdraws ${q.pct}%: about ${fsol(q.solOut)} SOL + ${compact(coinAmt(q.coinOut, q.decimals))} ${esc(sym)}`);
  }
  async function run(kind, body, describe) {
    if (S.busy) return; S.busy = true;
    const st = $('#st'); const btn = $(kind === 'add' ? '#goAdd' : '#goRm'); if (btn) btn.disabled = true;
    const steps = ['Build and simulate the transaction', 'Approve in your wallet', 'Confirm on Solana'];
    let line = '', sigs = [], idx = 0, total = 1;
    const draw = (cur, err) => {
      st.className = 'status show ' + (err ? 'err' : cur >= 3 ? 'ok' : 'wait');
      const links = sigs.map((s, i) => `<a href="https://solscan.io/tx/${s}" target="_blank" rel="noopener">${total > 1 ? 'Step ' + (i + 1) + ' on Solscan' : 'View on Solscan'}</a>`).join(' · ');
      st.innerHTML = (err ? `<b>${esc(err.message || err)}</b>${err.logs ? `<pre>${esc(err.logs.join('\n'))}</pre>` : ''}` : cur >= 3 ? `<b>Done. ${kind === 'add' ? 'This coin pays you divs now.' : 'Withdrawn to your wallet.'}</b>` : `<b><span class="loader"></span>${esc(line || 'Working…')}</b>`)
        + (!err && cur < 3 ? `<ol>${steps.map((t, i) => `<li class="${i < cur ? 'done' : i === cur ? 'now' : ''}">${i < cur ? '✓ ' : ''}${t}${i === 2 && total > 1 ? ` (${Math.min(idx + 1, total)} of ${total})` : ''}</li>`).join('')}</ol>` : '')
        + (links ? `<div style="margin-top:8px">${links}</div>` : '');
    };
    try {
      line = 'Checking the pool and simulating…'; draw(0);
      const r = await api('tx', body);
      total = r.txs.length; line = describe(r.quote) + (total > 1 ? ' · two signatures' : ''); draw(1);
      await signSend(r.txs, (what, s, i) => { if (s) sigs = s.slice(); if (i != null) idx = i; draw(what === 'sign' ? 1 : 2); });
      draw(3); toast(kind === 'add' ? 'Added. Divs start with the next trade.' : 'Withdrawn.');
      setTimeout(() => { if (S.pool && S.pool.pool) openPool(S.pool.pool, true); loadPositions(); }, 1500);
    } catch (e) { const msg = /reject|denied|cancel/i.test(e && e.message || '') ? new Error('You cancelled in the wallet. Nothing was sent.') : e; draw(0, msg); }
    finally { S.busy = false; if (btn) btn.disabled = false; }
  }

  /* ---------- positions ---------- */
  function renderPositions() {
    const box = $('#pos'); $('#refreshPos').hidden = !W.w;
    if (!W.w) { box.innerHTML = `<div class="connect-card"><svg width="74" height="84" viewBox="0 0 120 136"><use href="#mark"/></svg><div><h3>Every position you hold, in one place</h3><p>Connect a wallet to see each PumpSwap pool it's in, what the position is worth and what it earns a day.</p></div><button class="btn gold" id="cw2" type="button">Connect wallet</button></div>`; $('#cw2').onclick = connect; return; }
    if (S.positions == null) { box.innerHTML = '<div style="padding:12px 18px"><div class="skel"></div><div class="skel"></div></div>'; return; }
    if (S.positions.error) { box.innerHTML = `<div class="connect-card"><p>${esc(S.positions.error)}</p><button class="btn sm" id="rp" type="button">Retry</button></div>`; $('#rp').onclick = loadPositions; return; }
    if (!S.positions.length) { box.innerHTML = `<div class="connect-card"><svg width="74" height="84" viewBox="0 0 120 136"><use href="#mark"/></svg><div><h3>No positions yet</h3><p>Pick a pool from the board and add from SOL.</p></div><a class="btn gold" href="#pools">See the pools</a></div>`; return; }
    const tot = S.positions.reduce((a, p) => a + p.valueSol, 0), day = S.positions.reduce((a, p) => a + (p.milkDaySol || 0), 0);
    box.innerHTML = `<div class="pcard" style="background:#fff6dc"><span class="nm"><b>All positions</b><small>${S.positions.length} pool${S.positions.length > 1 ? 's' : ''}</small></span><span><span class="lbl">Value</span><span class="val num">${fsol(tot)} SOL</span></span><span><span class="lbl">Divs / day</span><span class="val num">≈ ${fsol(day)} SOL</span></span><span></span><span></span></div>`
      + S.positions.map(p => `<div class="pcard"><span class="c-cow">${tokImg(p)}<span class="nm"><b>${esc(p.name || short(p.mint))}</b><small>${label(p)}</small></span></span><span><span class="lbl">Value</span><span class="val num">${fsol(p.valueSol)} SOL</span></span><span><span class="lbl">Share</span><span class="val num">${pctTxt(p.share, 3)}</span></span><span><span class="lbl">Divs / day</span><span class="val num">${p.volSol ? '≈ ' + fsol(p.milkDaySol) : '—'}</span></span><span>${p.solPool ? `<button class="btn sm" type="button" data-pool="${esc(p.pool)}" data-t="remove">Manage</button>` : ''}</span></div>`).join('');
  }
  $('#pos').addEventListener('click', e => { const b = e.target.closest('[data-pool]'); if (b) openPool(b.dataset.pool, false, b.dataset.t); });
  async function loadPositions() { if (!W.w) { renderPositions(); return; } S.positions = null; renderPositions(); try { const j = await api('positions?user=' + W.acct.address); S.positions = j.positions || []; } catch (e) { S.positions = { error: e.message }; } renderPositions(); }
  $('#refreshPos').addEventListener('click', loadPositions);

  /* ---------- receipt ---------- */
  const RC = { p: null, init: false };
  const rcSolAt = v => { const x = 0.05 * Math.pow(2000, v / 100); return x < 1 ? Math.round(x * 100) / 100 : x < 10 ? Math.round(x * 10) / 10 : Math.round(x); };
  function rcInit() {
    const top3 = L => L.filter(p => p.tvlSol >= 50 && p.volSol > 0).sort((a, b) => b.milkPerSolDay - a.milkPerSolDay).slice(0, 4); const base = [...top3(S.pools), ...top3(S.stonk)];
    const list = base.length ? base : S.all.slice(0, 6); if (!list.length) return;
    if (!RC.p || !list.some(x => x.pool === RC.p.pool)) RC.p = list[0];
    $('#rcPick').innerHTML = list.map(p => `<button type="button" data-pool="${esc(p.pool)}" class="${p.pool === RC.p.pool ? 'on' : ''}">${tokImg(p)}${label(p)}<span class="vb ${p.venue === 'stonkfun' ? 's' : ''}" style="margin-left:2px">${p.venue === 'stonkfun' ? 'SF' : 'pump'}</span></button>`).join('');
    if (!RC.init) {
      RC.init = true;
      $('#rcPick').onclick = e => { const b = e.target.closest('button'); if (!b) return; RC.p = S.all.find(x => x.pool === b.dataset.pool); $$('#rcPick button').forEach(x => x.classList.toggle('on', x === b)); rcPaint(true); };
      ['#rcSol', '#rcDays', '#rcMove'].forEach(id => $(id).addEventListener('input', () => rcPaint()));
      $('#rcGo').onclick = () => RC.p && openPool(RC.p.pool, false, 'add', String(rcSolAt(+$('#rcSol').value)));
    }
    rcPaint();
  }
  function rcPaint(bump) {
    const p = RC.p; if (!p) return;
    const V = rcSolAt(+$('#rcSol').value), days = +$('#rcDays').value, mv = +$('#rcMove').value / 100, r = 1 + mv;
    $$('#rcSol,#rcDays,#rcMove').forEach(el => el.style.setProperty('--f', ((el.value - el.min) / (el.max - el.min) * 100) + '%'));
    $('#rcSolL').textContent = V + ' SOL'; $('#rcDaysL').textContent = days + (days === 1 ? ' day' : ' days'); $('#rcMoveL').textContent = (mv > 0 ? '+' : '') + Math.round(mv * 100) + '%';
    const fees = V * p.milkPerSolDay * days, il = V * Math.sqrt(r) - V, net = fees + il, hold = V * (1 + r) / 2 - V, vs = net - hold;
    const set = (id, n) => { const el = $(id); if (bump && el.animate) el.animate([{ transform: 'scale(1.1)' }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.75,.2,1)' }); el.innerHTML = `${sgn(n)} SOL <small class="mut" style="font-size:13px;font-weight:600;letter-spacing:0">${usd(n)}</small>`; el.className = 'num ' + (n >= 0 ? 'up' : 'dn'); };
    set('#rcFees', fees); set('#rcIl', il); set('#rcNet', net); set('#rcVs', vs);
    $('#rcPool').textContent = (p.symbol ? '$' + p.symbol : short(p.mint)) + (p.venue === 'stonkfun' ? ' · StonkFun' : ' · pump.fun') + ' · ' + pctTxt(p.milkPerSolDay) + '/day';
    if (bump) { const el = $('#rcPaper'); el.animate([{ transform: 'translateY(-6px) rotate(-.4deg)' }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.7,.2,1)' }); }
    // curve: LP (with fees) vs hold, across price moves
    const X = q => 40 + (q - 0.1) / 3.9 * 460, vals = [];
    for (let q = 0.1; q <= 4.0001; q += 0.05) vals.push([q, V * Math.sqrt(q) + fees, V * (1 + q) / 2]);
    const all = vals.flatMap(v => [v[1], v[2]]), lo = Math.min(...all, V * 0.2), hi = Math.max(...all), Y = v => 180 - (v - lo) / (hi - lo || 1) * 160;
    const path = i => vals.map((v, k) => (k ? 'L' : 'M') + X(v[0]).toFixed(1) + ',' + Y(v[i]).toFixed(1)).join('');
    const cx = X(Math.max(.1, Math.min(4, r)));
    $('#rcCurve').innerHTML = `<line x1="40" y1="${Y(V)}" x2="500" y2="${Y(V)}" stroke="#CFC6B2" stroke-dasharray="4 5"/><text x="498" y="${Y(V) - 6}" text-anchor="end" font-size="11" font-weight="700" fill="#7a746a" font-family="Sora">what you put in</text>
      <path d="${path(2)}" fill="none" stroke="#7a746a" stroke-width="2.5" stroke-dasharray="7 6"/><path d="${path(1)}" fill="none" stroke="#141414" stroke-width="3.5" stroke-linecap="round"/>
      <line x1="${cx}" y1="14" x2="${cx}" y2="186" stroke="#E8B23A" stroke-width="2"/><circle cx="${cx}" cy="${Y(V * Math.sqrt(r) + fees)}" r="7" fill="#E8B23A" stroke="#141414" stroke-width="2.5"/><circle cx="${cx}" cy="${Y(V * (1 + r) / 2)}" r="5" fill="#fff" stroke="#7a746a" stroke-width="2"/>
      <text x="40" y="204" font-size="11" fill="#7a746a" font-family="Sora" font-weight="700">−90%</text><text x="${X(1)}" y="204" font-size="11" fill="#7a746a" font-family="Sora" font-weight="700" text-anchor="middle">0%</text><text x="500" y="204" font-size="11" fill="#7a746a" font-family="Sora" font-weight="700" text-anchor="end">+300%</text>
      <rect x="40" y="6" width="210" height="22" rx="7" fill="#F8F5EE"/><line x1="48" y1="17" x2="70" y2="17" stroke="#141414" stroke-width="3.5"/><text x="76" y="21" font-size="11.5" font-weight="700" font-family="Sora" fill="#141414">your position</text><line x1="160" y1="17" x2="180" y2="17" stroke="#7a746a" stroke-width="2.5" stroke-dasharray="5 4"/><text x="186" y="21" font-size="11.5" font-weight="700" font-family="Sora" fill="#7a746a">holding</text>`;
  }

  /* ---------- one click inspector ---------- */
  const OC = [
    { prog: 'SPL Token', what: 'Opens a temporary wrapped-SOL account in your wallet and moves your budget into it, so the pool can trade it.', acc: [['You (pays and signs)', 's'], ['Your wrapped-SOL account', 'w']] },
    { prog: 'PumpSwap', what: 'An exact buy on the same pool. DIVZ sizes it so the coin you get and the SOL left over match the pool\'s ratio.', acc: [['You', 's'], ['The pool', 'w'], ['Pool coin and SOL vaults', 'w'], ['Fee recipients', 'w']] },
    { prog: 'PumpSwap', what: 'Deposits both sides into the pool at its current price. If the price moved past your limit, the whole transaction fails.', acc: [['You', 's'], ['The pool', 'w'], ['Your coin and wrapped-SOL accounts', 'w']] },
    { prog: 'Token-2022', what: 'The pool mints LP tokens for your share straight into your wallet. They are your claim on the pool and its fees.', acc: [['LP mint (owned by the pool)', 'w'], ['Your LP token account', 'w']] },
    { prog: 'SPL Token', what: 'Closes the wrapped-SOL account and returns whatever is left, plus its rent, to your wallet.', acc: [['Your wrapped-SOL account', 'w'], ['You (receives the rest)', 'w']] }
  ];
  function ocInit() {
    let cur = 0, auto = true, vis = false;
    const show = i => { cur = i; $$('#ocSteps li').forEach(li => li.classList.toggle('on', +li.dataset.i === i)); const d = OC[i], el = $('#ocDet'); el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; el.innerHTML = `<b style="color:#E8B23A">${d.prog}</b><div style="margin-top:6px;color:#ddd">${d.what}</div><div class="k">${d.acc.map(a => `<div class="a"><span>${a[0]}</span><span class="t ${a[1] === 's' ? 's' : ''}">${a[1] === 's' ? 'signer' : 'writable'}</span></div>`).join('')}</div>`; };
    $('#ocSteps').onclick = e => { const li = e.target.closest('li'); if (li) { auto = false; show(+li.dataset.i); } };
    new IntersectionObserver(es => { vis = es[0].isIntersecting }).observe($('#ocSteps'));
    setInterval(() => { if (auto && vis && !document.hidden) show((cur + 1) % OC.length); }, 3000);
    show(0);
  }

  /* ---------- faq ---------- */
  function faqInit() {
    const ds = $$('#faqList details');
    ds.forEach(d => { const sm = $('summary', d), p = $('p', d); sm.addEventListener('click', e => { e.preventDefault(); if (RM) { d.open = !d.open; return; } if (d.open) { const h = p.scrollHeight; p.animate([{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 240, easing: 'ease' }).onfinish = () => d.open = false; } else { d.open = true; const h = p.scrollHeight; p.animate([{ height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 }], { duration: 340, easing: 'cubic-bezier(.2,.7,.2,1)' }); } }); });
    $('#fq').oninput = e => { const q = e.target.value.trim().toLowerCase(); let n = 0; ds.forEach(d => { const m = !q || d.textContent.toLowerCase().includes(q); d.hidden = !m; if (m) n++; if (q.length >= 3 && m) d.open = true; }); $('#fqNone').hidden = n > 0; };
  }

  /* ---------- intro: coins drop into the bowl ---------- */
  let readyQ = [];
  function setReady() { if (document.body.classList.contains('ready')) return; document.body.classList.add('ready'); readyQ.forEach(f => f()); readyQ = []; }
  const whenReady = f => document.body.classList.contains('ready') ? f() : readyQ.push(f);
  function intro() {
    const el = $('#intro'); const freeze = new URLSearchParams(location.search).get('it');
    const done = () => { if (el.classList.contains('out')) return; el.classList.add('out'); document.body.classList.remove('locked'); setReady(); setTimeout(() => el.remove(), 700); };
    if ((RM || location.hash.length > 1) && freeze == null) { el.remove(); document.body.classList.remove('locked'); setReady(); return; }
    $('#skip').onclick = done;
    const svg = $('#isvg');
    svg.innerHTML = `<circle id="iRip" cx="280" cy="250" r="40" fill="none" stroke="#E8B23A" stroke-width="3" opacity="0"/><circle id="iRip2" cx="280" cy="250" r="40" fill="none" stroke="#141414" stroke-width="1.5" opacity="0"/>
      <g id="iAll"><circle class="ic" cx="280" cy="0" r="30" fill="#E8B23A"/><circle class="ic" cx="280" cy="0" r="22" fill="#E8B23A"/><circle class="ic" cx="280" cy="0" r="14" fill="#E8B23A"/><path id="iBowl" d="M150,250 A130,130 0 0 0 410,250 Z" fill="#141414"/></g>`;
    const coins = $$('.ic', svg), bowl = $('#iBowl'), all = $('#iAll'), r1 = $('#iRip'), r2 = $('#iRip2');
    const bounce = t => { const n = 7.5625, d = 2.75; t = Math.max(0, Math.min(1, t)); if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + .75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + .9375; return n * (t -= 2.625 / d) * t + .984375; };
    const draw = T => {
      const bu = easeO(T / .55); bowl.setAttribute('transform', `translate(0,${(1 - bu) * 220})`); bowl.style.opacity = Math.min(1, T / .3);
      const land = [212, 168, 134], start = [.45, .85, 1.2];
      coins.forEach((c, i) => { const k = bounce((T - start[i]) / .62); c.setAttribute('cy', (-60 + (land[i] + 60) * k).toFixed(1)); c.style.opacity = T > start[i] ? 1 : 0; });
      const rt = Math.max(0, (T - 1.75) / .9); r1.setAttribute('r', 40 + rt * 200); r1.setAttribute('opacity', rt > 0 && rt < 1 ? (1 - rt).toFixed(2) : 0); r2.setAttribute('r', 40 + easeO(rt) * 260); r2.setAttribute('opacity', rt > 0 && rt < 1 ? ((1 - rt) * .4).toFixed(2) : 0);
      const z = ease((T - 2.35) / .55); all.setAttribute('transform', `translate(280 200) scale(${1 - z * .25}) translate(-280 -200)`); all.style.opacity = 1 - z;
    };
    if (freeze != null) { draw(+freeze); return; }
    const t0 = performance.now(), END = 2.9; const f = n => { const T = (n - t0) / 1000; draw(T); if (T < END) requestAnimationFrame(f); else done(); }; requestAnimationFrame(f); setTimeout(done, END * 1000 + 1500);
  }

  /* ---------- hero machine: two launchpads' trades flow in, divs drop into the bowl ---------- */
  const mach = (() => {
    const N = 4, GAP = 92, TR = [{ y: 112, v: 'pump', lab: 'pump.fun', col: '#E8B23A' }, { y: 196, v: 'stonkfun', lab: 'StonkFun', col: '#F2EEE3' }];
    const BX = 430, BY = 300, BR = 92;
    let syms = { pump: [], stonkfun: [] }, paid = 0, built = false;
    function build() {
      const svg = $('#msvg'); built = true;
      let chips = '';
      TR.forEach((t, k) => { for (let i = 0; i < N; i++) chips += `<g class="mc" data-t="${k}" data-i="${i}"><rect x="-42" y="-15" width="84" height="30" rx="15" fill="#1d1b17" stroke="${t.col}" stroke-opacity=".8" stroke-width="1.5"/><text y="5" text-anchor="middle" font-size="12" font-weight="800" font-family="Sora" fill="${t.col}">BUY</text></g><circle class="mco" data-t="${k}" data-i="${i}" r="8.5" fill="url(#gold)" opacity="0"/>`; });
      svg.innerHTML = `<defs><pattern id="mg" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#262420" stroke-width="1"/></pattern><clipPath id="bowlClip"><path d="M${BX - BR},${BY} A${BR},${BR} 0 0 0 ${BX + BR},${BY} Z"/></clipPath>
        <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#E8B23A" stop-opacity="0"/><stop offset=".85" stop-color="#E8B23A" stop-opacity=".16"/><stop offset="1" stop-color="#FBE7A1" stop-opacity=".7"/></linearGradient></defs>
        <rect width="560" height="470" fill="url(#mg)"/><rect id="mSweep" x="-120" y="0" width="120" height="470" fill="url(#sweep)"/>
        ${TR.map(t => `<text x="20" y="${t.y - 26}" font-size="11.5" font-weight="800" letter-spacing="1.5" font-family="Sora" fill="${t.col}" opacity=".85">${t.lab.toUpperCase()}</text><path d="M14,${t.y} H312" stroke="#3a372f" stroke-width="2" stroke-dasharray="6 8"/>`).join('')}
        ${chips}
        <path d="M${BX - BR},${BY} A${BR},${BR} 0 0 0 ${BX + BR},${BY} Z" fill="#26231d"/><g clip-path="url(#bowlClip)"><rect id="mFill" x="${BX - BR}" y="${BY + BR}" width="${2 * BR}" height="${BR + 10}" fill="url(#gold)"/><path id="mWave" fill="#FBE7A1" opacity=".55"/></g>
        <path d="M${BX - BR},${BY} A${BR},${BR} 0 0 0 ${BX + BR},${BY}" fill="none" stroke="#F2EEE3" stroke-width="3"/><line x1="${BX - BR - 8}" y1="${BY}" x2="${BX + BR + 8}" y2="${BY}" stroke="#F2EEE3" stroke-width="3" stroke-linecap="round"/>
        <text id="mPaid" x="${BX}" y="${BY + BR + 34}" text-anchor="middle" font-size="13" font-weight="800" font-family="Sora" fill="#F2EEE3"> </text><text x="${BX}" y="${BY + BR + 52}" text-anchor="middle" font-size="11" font-weight="600" font-family="Sora" fill="#8d877a">paid to liquidity, last 24h</text>`;
      const chipsEl = $$('.mc', svg), coins = $$('.mco', svg), fill = $('#mFill'), wave = $('#mWave'), sweep = $('#mSweep');
      let vis = true; new IntersectionObserver(e => { vis = e[0].isIntersecting }).observe(svg);
      const t0 = performance.now(), period = 1.3, span = N * GAP, lastLap = {};
      const f = now => {
        requestAnimationFrame(f); if (!vis || document.hidden) return;
        const T = (now - t0) / 1000;
        chipsEl.forEach(c => {
          const k = +c.dataset.t, i = +c.dataset.i, tr = TR[k], ph = T / period * GAP + i * GAP + k * 46, lap = Math.floor(ph / span), x = -50 + (ph % span) * (380 / span);
          const key = k + ':' + i; if (lastLap[key] !== lap) { lastLap[key] = lap; const L = syms[tr.v]; const tx = $('text', c); tx.textContent = L.length ? L[(lap * N + i) % L.length] : (i % 3 === 1 ? 'SELL' : 'BUY'); }
          c.setAttribute('transform', `translate(${x.toFixed(1)},${tr.y})`); c.style.opacity = x < 270 ? Math.min(1, (x + 50) / 40) : Math.max(0, 1 - (x - 270) / 40);
        });
        coins.forEach(c => {
          const k = +c.dataset.t, i = +c.dataset.i, tr = TR[k], ph = T / period * GAP + i * GAP + k * 46, x = -50 + (ph % span) * (380 / span), d = (x - 275) / 45;
          if (d < 0 || d > 1) { c.setAttribute('opacity', 0); return; }
          const sx = 300, sy = tr.y, ex = BX - 20 + k * 40, ey = BY + 30;
          const cx = sx + (ex - sx) * d, cy = sy + (ey - sy) * d * d - Math.sin(d * Math.PI) * 34;
          c.setAttribute('cx', cx.toFixed(1)); c.setAttribute('cy', cy.toFixed(1)); c.setAttribute('opacity', d < .85 ? 1 : ((1 - d) / .15).toFixed(2));
        });
        const lvl = 0.22 + ((T % 26) / 26) * .66, y = BY + BR - lvl * BR;
        fill.setAttribute('y', y.toFixed(1));
        let d = `M${BX - BR},${y.toFixed(1)}`; for (let x = BX - BR; x <= BX + BR; x += 9) d += ` L${x},${(y + Math.sin(x / 16 + T * 3) * 3).toFixed(1)}`; d += ` L${BX + BR},${BY + BR + 10} L${BX - BR},${BY + BR + 10} Z`; wave.setAttribute('d', d);
        sweep.setAttribute('x', (((T % 4.5) / 4.5) * 720 - 140).toFixed(1));
      };
      requestAnimationFrame(f);
    }
    function data() {
      const pick = L => L.filter(p => p.tvlSol >= 25 && p.symbol).sort((a, b) => b.volSol - a.volSol).slice(0, 12).map(p => '$' + String(p.symbol).slice(0, 7));
      syms = { pump: pick(S.pools), stonkfun: pick(S.stonk) };
      paid = S.all.reduce((a, p) => a + p.volSol * p.lpBps / 10000, 0);
      const el = $('#mPaid'); if (el) countTo(el, paid, n => compact(n) + ' SOL');
    }
    return { init: build, data };
  })();

  /* ---------- pinned story ---------- */
  const story = (() => {
    let built = false, p = 0, vis = false, top = null;
    function build() {
      const svg = $('#ssvg'); built = true;
      svg.innerHTML = `<defs><pattern id="sg" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#24221e" stroke-width="1"/></pattern><clipPath id="sbc"><path d="M220,250 A100,100 0 0 0 420,250 Z"/></clipPath></defs>
        <rect width="640" height="480" fill="url(#sg)"/>
        <text id="sT" x="32" y="48" fill="#F2EEE3" font-size="17" font-weight="800" font-family="Sora"> </text><text id="sS" x="32" y="72" fill="#9a9488" font-size="13" font-family="Sora"> </text>
        <g id="sTrade"><rect x="-60" y="-20" width="120" height="40" rx="20" fill="#22301f" stroke="#7fcf9a" stroke-width="2"/><text y="6" text-anchor="middle" fill="#7fcf9a" font-size="15" font-weight="800" font-family="Sora">BUY 1 SOL</text></g>
        <g id="sSplit" opacity="0"><rect x="120" y="120" width="400" height="34" rx="10" fill="#26231d"/><rect id="sLp" x="120" y="120" width="120" height="34" rx="10" fill="#E8B23A"/><rect id="sCr" x="240" y="120" width="140" height="34" fill="#5a5448"/><rect id="sPr" x="380" y="120" width="140" height="34" rx="10" fill="#3a372f"/>
          <circle cx="126" cy="182" r="5" fill="#E8B23A"/><text id="sLpT" x="136" y="186" fill="#E8B23A" font-size="12.5" font-weight="800" font-family="Sora">to the pool</text><circle cx="276" cy="182" r="5" fill="#5a5448"/><text id="sCrT" x="286" y="186" fill="#a39c8e" font-size="12.5" font-weight="700" font-family="Sora">to the creator</text><circle cx="416" cy="182" r="5" fill="#3a372f" stroke="#5a5448"/><text id="sPrT" x="426" y="186" fill="#a39c8e" font-size="12.5" font-weight="700" font-family="Sora">to PumpSwap</text></g>
        <path d="M220,250 A100,100 0 0 0 420,250 Z" fill="#26231d"/><g clip-path="url(#sbc)"><rect id="sFill" x="220" y="350" width="200" height="110" fill="url(#gold)"/><rect id="sYou" x="300" y="350" width="40" height="110" fill="#F2EEE3" opacity="0"/></g>
        <path d="M220,250 A100,100 0 0 0 420,250" fill="none" stroke="#F2EEE3" stroke-width="3"/><line x1="210" y1="250" x2="430" y2="250" stroke="#F2EEE3" stroke-width="3" stroke-linecap="round"/>
        <g id="sDrops">${Array.from({ length: 6 }, () => '<circle r="8" fill="url(#gold)" opacity="0"/>').join('')}</g>
        <g id="sWallet" opacity="0"><rect x="455" y="300" width="164" height="86" rx="16" fill="#F2EEE3"/><rect x="455" y="300" width="164" height="24" rx="12" fill="#E8B23A"/><text x="537" y="355" text-anchor="middle" fill="#141414" font-size="13" font-weight="800" font-family="Sora">your wallet</text><text id="sWv" x="537" y="374" text-anchor="middle" fill="#141414" font-size="12" font-weight="700" font-family="Sora"> </text></g>
        <path id="sArrow" d="M420,320 C440,330 445,345 453,345" fill="none" stroke="#E8B23A" stroke-width="3" stroke-dasharray="6 6" opacity="0"/>`;
    }
    function data() {
      top = S.pools.filter(x => x.tvlSol >= 50 && x.volSol > 0).sort((a, b) => b.volSol - a.volSol)[0] || S.pools[0] || null;
      if (top) { const lp = top.lpBps / 100, tot = top.totalBps / 100; $('#bCut').textContent = `On $${top.symbol || 'this coin'} right now, ${lp.toFixed(2)}% of every trade stays in the pool for its liquidity, out of ${tot.toFixed(2)}% in total fees.`; }
      draw();
    }
    function draw(now = performance.now()) {
      if (!built) return; const at = (id, k, v) => $(id).setAttribute(k, v);
      const t = top, lpPct = t ? t.lpBps / 100 : .2, totPct = t ? t.totalBps / 100 : 1.25;
      const beat = p < .25 ? 0 : p < .5 ? 1 : p < .75 ? 2 : 3;
      const titles = [['A trade hits the pool', t ? `$${t.symbol} · ${compact(t.volSol)} SOL traded in the last 24h` : 'any pump.fun pool'], ['The fee gets split', `${totPct.toFixed(2)}% fee · ${lpPct.toFixed(2)}% stays in the pool`], ['Your share is your divs', t ? `1 SOL in → ${pctTxt(1 / (t.tvlSol + 1), 3)} of the pool` : 'your share of every fee'], ['Withdraw any time', 'LP tokens back to SOL, in your wallet']];
      $('#sT').textContent = titles[beat][0]; $('#sS').textContent = titles[beat][1];
      // trade chip slides in, then into the pool
      const ti = easeO(seg(p, .02, .14)), tin = ease(seg(p, .16, .24));
      at('#sTrade', 'transform', `translate(${(-70 + ti * 250 + tin * 70).toFixed(1)},${(220 - tin * 0).toFixed(1)}) scale(${(1 - tin * .6).toFixed(2)})`); $('#sTrade').style.opacity = 1 - seg(p, .22, .26);
      // split bar
      const sp = seg(p, .27, .35) * (1 - seg(p, .52, .56)); $('#sSplit').style.opacity = sp;
      const w = 400, lpw = Math.max(26, w * lpPct / totPct), rest = w - lpw, crw = rest * .75;
      at('#sLp', 'width', (lpw * easeO(seg(p, .3, .4))).toFixed(1)); at('#sCr', 'x', 120 + lpw); at('#sCr', 'width', crw); at('#sPr', 'x', 120 + lpw + crw); at('#sPr', 'width', rest - crw);
      if (t && t.totalBps) { $('#sLpT').textContent = 'to the pool ' + lpPct.toFixed(2) + '%'; }
      // drops fall into the bowl, bowl fills
      const fillK = seg(p, .36, .7);
      $$('#sDrops circle').forEach((c, i) => { const k = seg(p, .36 + i * .045, .44 + i * .045); c.setAttribute('cx', (240 + (i * 37) % 160 + 10)); c.setAttribute('cy', (150 + k * 150).toFixed(1)); c.setAttribute('opacity', k > 0 && k < 1 ? 1 : 0); });
      at('#sFill', 'y', (350 - fillK * 75 + Math.sin(now / 500) * 1.5).toFixed(1));
      const you = seg(p, .52, .6) * (1 - seg(p, .9, .97)); at('#sYou', 'opacity', (you * .55).toFixed(2)); at('#sYou', 'y', (350 - fillK * 75).toFixed(1));
      // withdraw to wallet
      const wd = seg(p, .76, .86); $('#sWallet').style.opacity = wd; at('#sArrow', 'opacity', wd.toFixed(2)); at('#sArrow', 'stroke-dashoffset', (-now / 30).toFixed(0));
      $('#sWv').textContent = t ? `+${fsol(t.milkPerSolDay)} SOL a day` : '';
      $$('#beats li').forEach((li, i) => { li.classList.toggle('on', i === beat); li.classList.toggle('done', i < beat); });
      $('#rail').style.transform = `scaleX(${p.toFixed(3)})`;
    }
    function scroll() { const sec = $('#how'); const r = sec.getBoundingClientRect(); vis = r.bottom > 0 && r.top < innerHeight; p = Math.max(0, Math.min(1, -r.top / Math.max(1, r.height - innerHeight))); }
    function loop(now) { requestAnimationFrame(loop); if (vis && !document.hidden) draw(now); }
    function init() { build(); requestAnimationFrame(loop); $$('#beats li').forEach((li, i) => li.onclick = () => { const sec = $('#how'), t0 = sec.getBoundingClientRect().top + scrollY; scrollTo({ top: t0 + (sec.offsetHeight - innerHeight) * (i * .25 + .13), behavior: 'smooth' }); }); }
    return { init, data, scroll };
  })();


  /* ---------- round 3: scroll features ---------- */
  function manifestoInit() {
    const el = $('#mtext'); if (!el || el.dataset.sp) return; el.dataset.sp = 1;
    const gold = new Set(['divz', 'seat,', 'paid', 'fee.']);
    el.innerHTML = el.textContent.trim().split(/\s+/).map(w => `<span class="w${gold.has(w) ? ' g' : ''}">${esc(w)}</span>`).join(' ');
  }
  function manifestoScroll() {
    const el = $('#mtext'); if (!el) return; const r = el.getBoundingClientRect();
    if (r.top > innerHeight || r.bottom < 0) return;
    const p = Math.max(0, Math.min(1, (innerHeight * .82 - r.top) / (r.height + innerHeight * .25)));
    const ws = $$('.w', el), n = Math.round(p * ws.length);
    ws.forEach((w, i) => w.classList.toggle('on', RM || i < n));
  }
  const HS = { shift: 0 };
  function topPayers() {
    const L = S.all.filter(p => p.tvlSol >= 25 && p.volSol > 0).sort((a, b) => b.milkPerSolDay - a.milkPerSolDay).slice(0, 12);
    const tr = $('#htrack'); if (!tr) return;
    if (!L.length) { tr.innerHTML = '<div class="empty" style="width:100%">The board is loading…</div>'; return; }
    tr.innerHTML = L.map((p, i) => `<div class="hcard ${p.venue === 'stonkfun' ? 'ink' : ''}" data-pool="${esc(p.pool)}"><span class="rank">${String(i + 1).padStart(2, '0')}</span>
      <div class="h">${tokImg(p, 'tok lg')}<div><b>${label(p)}</b><small class="mut">${p.venue === 'stonkfun' ? 'StonkFun' + (p.quote ? ' · with ' + esc(p.quote) : '') : 'pump.fun · with SOL'}</small></div></div>
      <div class="big num">${pctTxt(p.milkPerSolDay)}<small>a day</small></div>
      <div class="kv2 num"><div><span>Pool size</span><b>${compact(p.tvlSol)} SOL</b></div><div><span>24h volume</span><b>${compact(p.volSol)} SOL</b></div></div>
      <div class="go2"><span>${p.venue === 'stonkfun' ? 'Open on Raydium' : 'Add from SOL'}</span><i>→</i></div></div>`).join('');
    sizeTop(); onScroll();
  }
  function sizeTop() {
    const sec = $('#payers'), tr = $('#htrack'); if (!sec || !tr) return;
    if (innerWidth <= 1000) { sec.style.height = ''; HS.shift = 0; return; }
    HS.shift = Math.max(0, tr.scrollWidth - innerWidth);
    sec.style.height = (innerHeight + HS.shift + 80) + 'px';
  }
  function topScroll() {
    const sec = $('#payers'), tr = $('#htrack'); if (!sec || !HS.shift) return;
    const r = sec.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) return;
    const p = Math.max(0, Math.min(1, -r.top / Math.max(1, r.height - innerHeight)));
    tr.style.transform = `translate3d(${(-p * HS.shift).toFixed(1)}px,0,0)`; $('#hprog').style.transform = `scaleX(${p.toFixed(3)})`;
  }
  $('#htrack').addEventListener('click', e => { const c = e.target.closest('.hcard'); if (c) openPool(c.dataset.pool); });
  const DOTS = [['Top', null], ['Why divz', 'why'], ['Launchpads', 'venues'], ['Top payers', 'payers'], ['How it works', 'how'], ['Pools', 'pools'], ['Receipt', 'receipt'], ['One click', 'click'], ['Positions', 'positions'], ['FAQ', 'faq']];
  function dotsInit() {
    const nav = $('#sdots'); nav.innerHTML = DOTS.map(([t, id]) => `<a href="${id ? '#' + id : '#'}" data-id="${id || ''}"><span>${t}</span></a>`).join('');
    nav.addEventListener('click', e => { const a = e.target.closest('a'); if (!a) return; e.preventDefault(); const id = a.dataset.id; if (!id) scrollTo({ top: 0, behavior: 'smooth' }); else document.getElementById(id).scrollIntoView({ behavior: 'smooth' }); });
  }
  function dotsScroll() {
    const nav = $('#sdots'); nav.classList.toggle('on', scrollY > 400);
    let cur = ''; for (const [, id] of DOTS) { if (!id) continue; const el = document.getElementById(id); if (el && el.getBoundingClientRect().top < innerHeight * .4) cur = id; }
    $$('a', nav).forEach(a => a.classList.toggle('on', a.dataset.id === cur));
  }

  /* ---------- end card ---------- */
  function endCard() { $('#esvg').innerHTML = `<style>@keyframes bob{50%{transform:translateY(-10px)}}.eb{animation:bob 3s ease-in-out infinite}.eb2{animation:bob 3s ease-in-out .4s infinite}</style><path d="M40,150 A110,110 0 0 0 260,150 Z" fill="#F2EEE3"/><circle class="eb" cx="150" cy="96" r="38" fill="url(#gold)"/><circle class="eb2" cx="150" cy="30" r="16" fill="url(#gold)"/>`; }

  /* ---------- motion ---------- */
  function splitWords() { $$('.sec h2').forEach(h => { const walk = n => [...n.childNodes].forEach(c => { if (c.nodeType === 3) { const fr = document.createDocumentFragment(); c.textContent.split(/(\s+)/).forEach(w => { if (!w) return; if (/^\s+$/.test(w)) { fr.appendChild(document.createTextNode(' ')); return; } const o = document.createElement('span'); o.className = 'wd'; const i = document.createElement('span'); i.textContent = w; o.appendChild(i); fr.appendChild(o); }); c.replaceWith(fr); } else if (c.nodeType === 1 && c.tagName !== 'BR') walk(c); }); walk(h); $$('.wd>span', h).forEach((x, k) => x.style.transitionDelay = (k * 60) + 'ms'); }); }
  function reveals() { const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('shown'); io.unobserve(e.target); } }), { threshold: .08 }); $$('.reveal').forEach(x => io.observe(x)); }
  function spy() {
    const nav = $('#nav'); if (getComputedStyle(nav).display === 'none') return;
    let ink = $('.ink', nav); if (!ink) { ink = document.createElement('span'); ink.className = 'ink'; nav.prepend(ink); }
    let on = null; for (const id of ['faq', 'positions', 'receipt', 'click', 'pools', 'how']) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top < innerHeight * .45) { on = id === 'click' ? 'receipt' : id; break; } }
    const a = on && $(`a[href="#${on}"]`, nav); $$('a', nav).forEach(x => x.classList.toggle('on', x === a));
    if (a) { ink.style.opacity = 1; ink.style.width = a.offsetWidth + 'px'; ink.style.transform = `translateX(${a.offsetLeft}px)`; } else ink.style.opacity = 0;
  }
  let sq = false;
  function onScroll() { if (sq) return; sq = true; requestAnimationFrame(() => { sq = false; const y = scrollY, H = document.documentElement.scrollHeight - innerHeight; $('#sprog').style.setProperty('--p', H > 0 ? (y / H).toFixed(4) : 0); $('#totop').classList.toggle('on', y > 900); $('#top').classList.toggle('scrolled', y > 10); story.scroll(); spy(); if (!RM) document.documentElement.style.setProperty('--hp', Math.min(1, y / 700).toFixed(3)); manifestoScroll(); topScroll(); dotsScroll(); }); }

  /* ---------- boot ---------- */
  async function boot() {
    manifestoInit(); dotsInit(); intro(); mach.init(); story.init(); ocInit(); faqInit(); endCard(); splitWords(); reveals(); renderPositions();
    addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', () => { sizeTop(); onScroll(); }); onScroll();
    $('#totop').onclick = () => scrollTo({ top: 0, behavior: 'smooth' });
    try { const c = await api('config'); S.cfg = c; if (c.feeBps) $('#faqCost').textContent = `A ${(c.feeBps / 100).toFixed(1)}% service fee on what you add, the Solana network fee, and the pool's normal trading fee on the part that gets swapped. Withdrawing is free apart from network fees.`; else $('#faqCost').textContent = 'DIVZ takes no fee. You pay the Solana network fee and the pool\'s normal trading fee on the part that gets swapped. Withdrawing is free apart from network fees.';
      if (c.ca) { $('#tright').insertAdjacentHTML('afterbegin', `<span class="ca">CA <b>${short(c.ca)}</b><button type="button" id="caCopy">COPY</button></span>`); $('#caCopy').onclick = () => navigator.clipboard.writeText(c.ca).then(() => toast('Contract address copied')); }
      if (c.x) $('#tright').insertAdjacentHTML('afterbegin', `<a class="btn sm ghost" href="${esc(c.x)}" target="_blank" rel="noopener">𝕏</a>`);
    } catch (e) { }
    loadPools();
  }
  boot();
})();
