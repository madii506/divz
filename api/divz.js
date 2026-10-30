'use strict';
/*
 * DIVZ — make any coin pay divs. A front end for adding liquidity to PumpSwap pools.
 *
 * One serverless function behind /api/*. It never holds keys or funds: it reads the chain, builds
 * unsigned transactions with the official PumpSwap SDK, simulates them, and hands them to the
 * user's own wallet to sign. LP tokens land in the user's wallet and work anywhere PumpSwap does.
 *
 * Routes
 *   GET  /api/config                       public settings (jug wallet, fee, CA)
 *   GET  /api/pools                        canonical pump.fun SOL pools, ranked by divs (LP fees) per day
 *   GET  /api/stonk                        graduated StonkFun coins' Raydium pools, with their real 24h fee APR
 *   GET  /api/pool?id=<pool|mint>&user=    one pool (+ the user's balances and position)
 *   GET  /api/positions?user=              every PumpSwap LP position the wallet holds
 *   POST /api/tx                           build + simulate: {kind:'add'|'add2'|'remove', ...}
 *   POST /api/send                         relay a signed transaction
 *   GET  /api/status?sig=                  confirmation status
 */
const {
  Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram,
  AddressLookupTableAccount,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, MintLayout, AccountLayout,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
  createCloseAccountInstruction,
} = require('@solana/spl-token');
const BN = require('bn.js');
const {
  PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, POOL_ACCOUNT_NEW_SIZE,
  canonicalPumpPoolPda, computeFeesBps, buyBaseInput, sellBaseInput,
} = require('@pump-fun/pump-swap-sdk');

/* ---------------- settings ---------------- */
const E = (k, d = '') => String(process.env[k] == null ? d : process.env[k]).trim();
const CONFIG = {
  jug: E('DIVZ_FEE_WALLET', ''),            // optional wallet for an add fee (public address); empty = no fee
  feeBps: Number(E('DIVZ_FEE_BPS', '10')),
  ca: E('DIVZ_CA', ''),              // $DIVZ mint, once launched
  x: E('DIVZ_X', ''),
};
try { if (CONFIG.jug) new PublicKey(CONFIG.jug); } catch (e) { CONFIG.jug = ''; }
const RPCS = [E('RPC_URL'), 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
// Address lookup tables that hold PumpSwap's global accounts. They shrink an add from SOL into ONE
// transaction. Each is re-read and only used while active; without them we fall back to two.
const ALT_KEYS = [E('DIVZ_ALT'), '9rVP9Ly5RC1nix3WDm5QgkoWJbxV7Kteth1KHtYk5hT9', '7Pau8dAeZTzVhVjQgTJeELY3XMPVSHidpzB78RnDE3bR'].filter(Boolean);
const U64_MAX = BigInt('18446744073709551615');
const MIN_TVL_SOL = 8;

const ERRORS = {
  6003: 'The pool has too little liquidity for this size.',
  6004: 'The price moved more than your slippage. Try again or raise slippage.',
  6016: 'That would buy more than the pool holds.',
  6018: 'Deposits are paused on PumpSwap right now.',
  6019: 'Withdrawals are paused on PumpSwap right now.',
  6020: 'Buys are paused on PumpSwap right now.',
  6021: 'Sells are paused on PumpSwap right now.',
  6039: 'Not enough SOL to cover the trade fees.',
  6040: 'The price moved more than your slippage. Try again or raise slippage.',
  6063: 'This pool does not have enough real SOL for that.',
  6064: 'This pool does not accept new liquidity.',
};

/* ---------------- http + rpc helpers ---------------- */
function send(res, code, body, cache) {
  res.setHeader('Cache-Control', cache || 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.status(code).send(JSON.stringify(body));
}
function http(code, msg) { const e = new Error(msg); e.code = code; return e; }
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e5) d = ''; }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); });
}
function timedFetch(ms) {
  return (url, opt = {}) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opt, signal: c.signal }).finally(() => clearTimeout(t)); };
}
const conns = RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: timedFetch(9000) }));
async function rpc(fn) {
  let last;
  for (const c of conns) { try { return await fn(c); } catch (e) { last = e; } }
  throw http(502, 'Solana RPC is busy: ' + String(last && last.message || last).slice(0, 140));
}
async function getJson(url, ms = 7000) {
  const r = await timedFetch(ms)(url, { headers: { accept: 'application/json', 'user-agent': 'divz/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}
const mem = {};
// in-memory cache with request de-duplication; serves the last good value if a refresh fails
async function cached(key, ms, fn) {
  const c = mem[key];
  if (c && c.has && Date.now() - c.t < ms) return c.v;
  if (c && c.p) return c.p;
  const p = (async () => {
    try { const v = await fn(); mem[key] = { t: Date.now(), v, has: true }; return v; }
    catch (e) { if (c && c.has) { mem[key] = { t: c.t, v: c.v, has: true }; return c.v; } delete mem[key]; throw e; }
  })();
  mem[key] = Object.assign({}, c || {}, { p });
  return p;
}
function pk(s, what = 'address') {
  try { const k = new PublicKey(String(s || '').trim()); return k; } catch (e) { throw http(400, 'Invalid ' + what); }
}
const big = v => BigInt(v.toString());
const ceilDiv = (a, b) => (a + b - 1n) / b;
const sol = l => Number(l) / 1e9;
async function chunked(keys, size, fn) { const out = []; for (let i = 0; i < keys.length; i += size) out.push(...(await fn(keys.slice(i, i + size)))); return out; }
const multi = keys => chunked(keys, 100, part => rpc(c => c.getMultipleAccountsInfo(part)));

/* ---------------- protocol state ---------------- */
async function globals() {
  return cached('globals', 60000, async () => {
    const [g, f] = await rpc(c => c.getMultipleAccountsInfo([GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA]));
    if (!g) throw http(502, 'PumpSwap global config not found');
    return { globalConfig: PUMP_AMM_SDK.decodeGlobalConfig(g), feeConfig: f ? PUMP_AMM_SDK.decodeFeeConfig(f) : null };
  });
}
async function lookupTables() {
  return cached('alts', 300000, async () => {
    const keys = ALT_KEYS.map(k => new PublicKey(k));
    const infos = await rpc(c => c.getMultipleAccountsInfo(keys));
    const out = [];
    infos.forEach((info, i) => {
      if (!info) return;
      try {
        const state = AddressLookupTableAccount.deserialize(info.data);
        if (BigInt(state.deactivationSlot) !== U64_MAX) return;
        out.push(new AddressLookupTableAccount({ key: keys[i], state }));
      } catch (e) { }
    });
    return out;
  });
}
function feesFor(pool, globalConfig, feeConfig, supply, Rb, Rq) {
  const f = computeFeesBps({
    globalConfig, feeConfig, creator: pool.creator, baseMintSupply: new BN(supply.toString()), baseMint: pool.baseMint,
    baseReserve: new BN(Rb.toString()), quoteReserve: new BN((Rq + big(pool.virtualQuoteReserves)).toString()),
    quoteMint: pool.quoteMint, isMayhemMode: pool.isMayhemMode, creatorFeeBps: pool.creatorFeeBps,
  });
  const hasCreator = !pool.coinCreator.equals(PublicKey.default);
  return { lp: big(f.lpFeeBps), pr: big(f.protocolFeeBps), cr: hasCreator ? big(f.creatorFeeBps) : 0n };
}

// Everything the builders need for one pool (and optionally one wallet), in two RPC round trips.
async function loadState(poolKey, user) {
  const { globalConfig, feeConfig } = await globals();
  const poolInfo = await rpc(c => c.getAccountInfo(poolKey));
  if (!poolInfo || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) throw http(404, 'That is not a PumpSwap pool.');
  const pool = PUMP_AMM_SDK.decodePool(poolInfo);
  const keys = [pool.baseMint, pool.quoteMint, pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount];
  const uKeys = user ? [
    user,
    getAssociatedTokenAddressSync(pool.baseMint, user, true, TOKEN_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.baseMint, user, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.quoteMint, user, true, TOKEN_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.quoteMint, user, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(pool.lpMint, user, true, TOKEN_2022_PROGRAM_ID),
  ] : [];
  const infos = await rpc(c => c.getMultipleAccountsInfo([...keys, ...uKeys]));
  const [bm, qm, pb, pq] = infos;
  if (!bm || !qm || !pb || !pq) throw http(502, 'Pool accounts are missing.');
  const baseTokenProgram = bm.owner, quoteTokenProgram = qm.owner;
  const baseMintAccount = MintLayout.decode(bm.data.slice(0, MintLayout.span));
  const quoteDecimals = MintLayout.decode(qm.data.slice(0, MintLayout.span)).decimals;
  const poolBaseTokenAccount = AccountLayout.decode(pb.data.slice(0, AccountLayout.span));
  const poolQuoteTokenAccount = AccountLayout.decode(pq.data.slice(0, AccountLayout.span));
  const Rb = big(poolBaseTokenAccount.amount), Rq = big(poolQuoteTokenAccount.amount), L = big(pool.lpSupply);
  const fee = feesFor(pool, globalConfig, feeConfig, baseMintAccount.supply, Rb, Rq);
  const st = {
    globalConfig, feeConfig, poolKey, poolInfo, pool, baseTokenProgram, quoteTokenProgram, baseMintAccount,
    poolBaseTokenAccount, poolQuoteTokenAccount, Rb, Rq, L, vqr: big(pool.virtualQuoteReserves), fee,
    decimals: baseMintAccount.decimals, quoteDecimals, supply: big(baseMintAccount.supply),
  };
  if (user) {
    const [ua, ub1, ub2, uq1, uq2, ulp] = infos.slice(4);
    const b22 = baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID), q22 = quoteTokenProgram.equals(TOKEN_2022_PROGRAM_ID);
    const owned = (info, prog) => (info && info.owner.equals(prog) ? info : null);
    const amt = info => (info ? big(AccountLayout.decode(info.data.slice(0, AccountLayout.span)).amount) : 0n);
    st.u = {
      user, lamports: BigInt(ua ? ua.lamports : 0),
      userBaseTokenAccount: b22 ? uKeys[2] : uKeys[1], userBaseAccountInfo: owned(b22 ? ub2 : ub1, baseTokenProgram),
      userQuoteTokenAccount: q22 ? uKeys[4] : uKeys[3], userQuoteAccountInfo: owned(q22 ? uq2 : uq1, quoteTokenProgram),
      userPoolTokenAccount: uKeys[5], userPoolAccountInfo: owned(ulp, TOKEN_2022_PROGRAM_ID),
    };
    st.u.base = amt(st.u.userBaseAccountInfo); st.u.quote = amt(st.u.userQuoteAccountInfo); st.u.lp = amt(st.u.userPoolAccountInfo);
  }
  return st;
}
function swapState(st) {
  return {
    globalConfig: st.globalConfig, feeConfig: st.feeConfig, poolKey: st.poolKey,
    // a full-size copy so the SDK never adds a second extend_account (we add one ourselves)
    poolAccountInfo: { ...st.poolInfo, data: Buffer.alloc(Math.max(st.poolInfo.data.length, POOL_ACCOUNT_NEW_SIZE)) },
    pool: st.pool, poolBaseAmount: new BN(st.Rb.toString()), poolQuoteAmount: new BN(st.Rq.toString()),
    baseTokenProgram: st.baseTokenProgram, quoteTokenProgram: st.quoteTokenProgram, baseMint: st.pool.baseMint,
    baseMintAccount: st.baseMintAccount, user: st.u.user, userBaseTokenAccount: st.u.userBaseTokenAccount,
    userQuoteTokenAccount: st.u.userQuoteTokenAccount, userBaseAccountInfo: st.u.userBaseAccountInfo,
    userQuoteAccountInfo: st.u.userQuoteAccountInfo,
  };
}
function liqState(st) {
  return {
    globalConfig: st.globalConfig, poolKey: st.poolKey,
    poolAccountInfo: { ...st.poolInfo, data: Buffer.alloc(Math.max(st.poolInfo.data.length, POOL_ACCOUNT_NEW_SIZE)) },
    pool: st.pool, poolBaseTokenAccount: st.poolBaseTokenAccount, poolQuoteTokenAccount: st.poolQuoteTokenAccount,
    baseTokenProgram: st.baseTokenProgram, quoteTokenProgram: st.quoteTokenProgram, user: st.u.user,
    userBaseTokenAccount: st.u.userBaseTokenAccount, userQuoteTokenAccount: st.u.userQuoteTokenAccount,
    userPoolTokenAccount: st.u.userPoolTokenAccount, userBaseAccountInfo: st.u.userBaseAccountInfo,
    userQuoteAccountInfo: st.u.userQuoteAccountInfo, userPoolAccountInfo: st.u.userPoolAccountInfo,
  };
}
// From the SDK's instruction lists keep only the PumpSwap instruction and any non-wSOL ATA creation;
// the wSOL wrap/unwrap is done once for the whole transaction.
function keep(ixs) {
  return ixs.filter(ix => {
    if (ix.programId.equals(PUMP_AMM_PROGRAM_ID)) return true;
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return !ix.keys[3].pubkey.equals(NATIVE_MINT);
    return false;
  });
}

/* ---------------- the math ---------------- */
// Cost of buying exactly b base (mirrors pump-amm buy): quote in, LP fee (stays in the pool), total paid.
function buyCost(st, b) {
  const Rqe = st.Rq + st.vqr;
  if (b <= 0n) return { q: 0n, lpFee: 0n, total: 0n };
  if (b >= st.Rb) return { q: U64_MAX, lpFee: 0n, total: U64_MAX };
  const q = ceilDiv(Rqe * b, st.Rb - b);
  const f = bps => ceilDiv(q * bps, 10000n);
  return { q, lpFee: f(st.fee.lp), total: q + f(st.fee.lp) + f(st.fee.pr) + f(st.fee.cr) };
}
// Split a SOL budget into "buy b of the coin" + "deposit both sides" so nothing is left over.
function planAdd(st, budget, slipBps) {
  let lo = 0n, hi = st.Rb / 2n;
  for (let i = 0; i < 90 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n; const c = buyCost(st, mid);
    if (c.total >= budget) { hi = mid; continue; }
    const D = budget - c.total; const Rb2 = st.Rb - mid, Rq2 = st.Rq + c.q + c.lpFee;
    if (mid * Rq2 < D * Rb2) lo = mid; else hi = mid;
  }
  const b = lo, c = buyCost(st, b);
  if (b <= 0n || c.total >= budget) throw http(400, 'That amount is too small for this pool.');
  const D = budget - c.total, Rb2 = st.Rb - b, Rq2 = st.Rq + c.q + c.lpFee;
  let lp = b * st.L / Rb2; const lpQ = D * st.L / Rq2; if (lpQ < lp) lp = lpQ;
  lp = lp * (10000n - slipBps) / 10000n;
  if (lp <= 0n) throw http(400, 'That amount is too small for this pool.');
  let maxBuy = c.total * (10000n + slipBps) / 10000n; if (maxBuy > budget) maxBuy = budget;
  return {
    baseOut: b, buyCost: c.total, maxBuy, lp, maxBase: b, maxQuoteDep: D,
    depBase: ceilDiv(Rb2 * lp, st.L), depQuote: ceilDiv(Rq2 * lp, st.L), share: Number(lp) / Number(st.L + lp),
  };
}

/* ---------------- transactions ---------------- */
async function priorityFee(keys) {
  try {
    const r = await cached('prio:' + (keys[0] ? keys[0].toBase58() : ''), 20000, () => rpc(c => c.getRecentPrioritizationFees(keys.length ? { lockedWritableAccounts: keys.slice(0, 1) } : undefined)));
    const v = r.map(x => x.prioritizationFee).filter(x => x > 0).sort((a, b) => a - b);
    const p = v.length ? v[Math.floor(v.length * 0.7)] : 60000;
    return Math.max(25000, Math.min(1500000, p));
  } catch (e) { return 60000; }
}
async function compile(user, ixs, cu, price, blockhash) {
  const tables = await lookupTables();
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ...ixs];
  const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message(tables);
  const tx = new VersionedTransaction(msg);
  try { const bytes = tx.serialize(); return bytes.length <= 1232 ? { tx, bytes } : null; } catch (e) { return null; }
}
function explain(sim) {
  const logs = (sim && sim.logs) || [];
  const m = JSON.stringify(sim && sim.err || '').match(/"Custom":(\d+)/);
  if (m && ERRORS[m[1]]) return ERRORS[m[1]];
  const l = logs.join('\n');
  if (/insufficient lamports|insufficient funds/i.test(l)) return 'Not enough SOL in the wallet for this, including network fees and rent.';
  if (/ExceededSlippage|slippage/i.test(l)) return ERRORS[6004];
  if (m) return 'PumpSwap rejected it (error ' + m[1] + ').';
  return 'The transaction would fail: ' + JSON.stringify(sim && sim.err).slice(0, 120);
}
// Compile, simulate once at a high limit, then set the real limit. Splits into two txs only if needed.
async function finish(user, groups, simulateIdx = 0, poolKey = null) {
  const { blockhash, lastValidBlockHeight } = await rpc(c => c.getLatestBlockhash('confirmed'));
  const price = await priorityFee(poolKey ? [poolKey] : []);
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const first = await compile(user, groups[i], 1_000_000, price, blockhash);
    if (!first) throw http(500, 'Transaction too large');
    let units = 400000, sim = null;
    if (i === simulateIdx) {
      const r = await rpc(c => c.simulateTransaction(first.tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }));
      sim = r.value;
      if (sim.err) { const e = http(400, explain(sim)); e.logs = (sim.logs || []).slice(-12); throw e; }
      units = Math.min(1_400_000, Math.ceil((sim.unitsConsumed || 300000) * 1.2) + 15000);
    } else units = 300000;
    const fin = await compile(user, groups[i], units, price, blockhash);
    out.push({ tx: Buffer.from(fin.bytes).toString('base64'), bytes: fin.bytes.length, units, sim: sim ? { units: sim.unitsConsumed } : null });
  }
  return { txs: out, blockhash, lastValidBlockHeight, priorityMicroLamports: price };
}
async function fits(user, ixs) {
  const r = await compile(user, ixs, 400000, 50000, '11111111111111111111111111111111');
  return !!r;
}
function wsolOpen(user, lamports) {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID);
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(user, ata, user, NATIVE_MINT, TOKEN_PROGRAM_ID)];
  if (lamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: ata, lamports }), createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID));
  return ixs;
}
const wsolClose = user => createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, user, true, TOKEN_PROGRAM_ID), user, user, [], TOKEN_PROGRAM_ID);
function jugIx(user, lamports) {
  if (!CONFIG.jug || lamports <= 0n) return [];
  return [SystemProgram.transfer({ fromPubkey: user, toPubkey: new PublicKey(CONFIG.jug), lamports })];
}
const slipOf = v => { const n = Math.max(0.3, Math.min(15, Number(v) || 2)); return BigInt(Math.round(n * 100)); };
const RENT_ATA = 2039280n, RENT_ATA22 = 2074080n;

async function buildAdd(b) {
  const user = pk(b.user, 'wallet'), poolKey = pk(b.pool, 'pool');
  const lamports = BigInt(Math.floor(Number(b.sol) * 1e9));
  if (!(lamports >= 10_000_000n)) throw http(400, 'Add at least 0.01 SOL.');
  const st = await loadState(poolKey, user);
  if (!st.pool.quoteMint.equals(NATIVE_MINT)) throw http(400, 'One-click adds work on SOL pools only.');
  const slip = slipOf(b.slippage);
  const fee = CONFIG.jug ? lamports * BigInt(CONFIG.feeBps) / 10000n : 0n;
  const budget = lamports - fee;
  const rent = (st.u.userBaseAccountInfo ? 0n : RENT_ATA) + (st.u.userPoolAccountInfo ? 0n : RENT_ATA22) + RENT_ATA + 120000n;
  if (st.u.lamports < lamports + rent) throw http(400, `Not enough SOL. This needs about ${sol(lamports + rent).toFixed(4)} SOL including rent for new token accounts and fees; the wallet has ${sol(st.u.lamports).toFixed(4)}.`);
  const plan = planAdd(st, budget, slip);
  // cross-check the buy price with the SDK's own quote
  const sdkQuote = buyBaseInput({ base: new BN(plan.baseOut.toString()), slippage: Number(slip) / 100, baseReserve: new BN(st.Rb.toString()), quoteReserve: new BN(st.Rq.toString()), virtualQuoteReserves: st.pool.virtualQuoteReserves, globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.pool.baseMint, coinCreator: st.pool.coinCreator, creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps });
  const sdkTotal = big(sdkQuote.uiQuote);
  if (sdkTotal > plan.buyCost) { plan.buyCost = sdkTotal; plan.maxBuy = sdkTotal * (10000n + slip) / 10000n; if (plan.maxBuy > budget) plan.maxBuy = budget; }
  const extend = st.poolInfo.data.length < POOL_ACCOUNT_NEW_SIZE ? [await PUMP_AMM_SDK.extendAccount(poolKey, user)] : [];
  const buy = keep(await PUMP_AMM_SDK.buyInstructions(swapState(st), new BN(plan.baseOut.toString()), new BN(plan.maxBuy.toString())));
  const dep = keep(await PUMP_AMM_SDK.depositInstructionsInternal(liqState(st), new BN(plan.lp.toString()), new BN(plan.maxBase.toString()), new BN(plan.maxQuoteDep.toString())));
  const one = [...jugIx(user, fee), ...extend, ...wsolOpen(user, budget), ...buy, ...dep, wsolClose(user)];
  let groups;
  if (await fits(user, one)) groups = [one];
  else groups = [
    [...jugIx(user, fee), ...extend, ...wsolOpen(user, plan.maxBuy), ...buy, wsolClose(user)],
    [...wsolOpen(user, plan.maxQuoteDep), ...dep, wsolClose(user)],
  ];
  const built = await finish(user, groups, 0, poolKey);
  return {
    ...built, kind: 'add', pool: poolKey.toBase58(),
    quote: {
      sol: sol(lamports), jug: sol(fee), jugBps: CONFIG.jug ? CONFIG.feeBps : 0, swapSol: sol(plan.buyCost), coinOut: plan.baseOut.toString(),
      decimals: st.decimals, depositSol: sol(plan.depQuote), depositCoin: plan.depBase.toString(), lp: plan.lp.toString(),
      share: plan.share, slippagePct: Number(slip) / 100, lpFeeBps: Number(st.fee.lp), steps: groups.length,
    },
  };
}

async function buildAdd2(b) {
  // two-sided: the coin the wallet already holds + the matching SOL
  const user = pk(b.user, 'wallet'), poolKey = pk(b.pool, 'pool');
  const st = await loadState(poolKey, user);
  if (!st.pool.quoteMint.equals(NATIVE_MINT)) throw http(400, 'SOL pools only.');
  const slip = slipOf(b.slippage);
  let base = b.coin === 'max' || b.coin == null ? st.u.base : BigInt(String(b.coin));
  if (base > st.u.base) base = st.u.base;
  if (base <= 0n) throw http(400, 'This wallet holds none of this coin.');
  // LP from the coin side, with room for the price to move
  let lp = base * st.L / st.Rb * (10000n - slip) / 10000n;
  let needQ = ceilDiv(st.Rq * lp, st.L);
  const maxQ = needQ * (10000n + slip) / 10000n;
  const valueSol = needQ * 2n;
  const fee = CONFIG.jug ? valueSol * BigInt(CONFIG.feeBps) / 10000n : 0n;
  const rent = (st.u.userPoolAccountInfo ? 0n : RENT_ATA22) + RENT_ATA + 100000n;
  if (st.u.lamports < maxQ + fee + rent) {
    // scale down to the SOL the wallet has
    const avail = st.u.lamports - fee - rent;
    if (avail <= 1000000n) throw http(400, 'Not enough SOL to pair with the coin.');
    lp = lp * avail / maxQ; needQ = ceilDiv(st.Rq * lp, st.L);
  }
  const maxBase = ceilDiv(st.Rb * lp, st.L) * (10000n + slip) / 10000n;
  const mb = maxBase > st.u.base ? st.u.base : maxBase;
  const mq = needQ * (10000n + slip) / 10000n;
  const dep = keep(await PUMP_AMM_SDK.depositInstructionsInternal(liqState(st), new BN(lp.toString()), new BN(mb.toString()), new BN(mq.toString())));
  const extend = st.poolInfo.data.length < POOL_ACCOUNT_NEW_SIZE ? [await PUMP_AMM_SDK.extendAccount(poolKey, user)] : [];
  const built = await finish(user, [[...jugIx(user, fee), ...extend, ...wsolOpen(user, mq), ...dep, wsolClose(user)]], 0, poolKey);
  return { ...built, kind: 'add2', pool: poolKey.toBase58(), quote: { depositSol: sol(needQ), depositCoin: ceilDiv(st.Rb * lp, st.L).toString(), decimals: st.decimals, jug: sol(fee), lp: lp.toString(), share: Number(lp) / Number(st.L + lp), steps: 1 } };
}

async function buildRemove(b) {
  const user = pk(b.user, 'wallet'), poolKey = pk(b.pool, 'pool');
  const st = await loadState(poolKey, user);
  if (st.u.lp <= 0n) throw http(400, 'This wallet has no liquidity in this pool.');
  const pct = Math.max(1, Math.min(100, Number(b.pct) || 100));
  const lp = pct === 100 ? st.u.lp : st.u.lp * BigInt(Math.round(pct * 100)) / 10000n;
  if (lp <= 0n) throw http(400, 'Nothing to withdraw.');
  const slip = slipOf(b.slippage);
  const base = st.Rb * lp / st.L, quote = st.Rq * lp / st.L;
  const minBase = base * (10000n - slip) / 10000n, minQuote = quote * (10000n - slip) / 10000n;
  const wd = keep(await PUMP_AMM_SDK.withdrawInstructionsInternal(liqState(st), new BN(lp.toString()), new BN(minBase.toString()), new BN(minQuote.toString())));
  const extend = st.poolInfo.data.length < POOL_ACCOUNT_NEW_SIZE ? [await PUMP_AMM_SDK.extendAccount(poolKey, user)] : [];
  const toSol = !!b.toSol && st.pool.quoteMint.equals(NATIVE_MINT);
  let groups, sellOut = 0n;
  if (!toSol) groups = [[...extend, ...wsolOpen(user, 0n), ...wd, wsolClose(user)]];
  else {
    const q = sellBaseInput({ base: new BN(minBase.toString()), slippage: Number(slip) / 100, baseReserve: new BN((st.Rb - base).toString()), quoteReserve: new BN((st.Rq - quote).toString()), virtualQuoteReserves: st.pool.virtualQuoteReserves, globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.pool.baseMint, coinCreator: st.pool.coinCreator, creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps });
    sellOut = big(q.uiQuote);
    const sst = swapState(st);
    // the base ATA will exist after the withdraw
    if (!sst.userBaseAccountInfo) sst.userBaseAccountInfo = { owner: st.baseTokenProgram, data: Buffer.alloc(165), lamports: 1, executable: false };
    const sell = keep(await PUMP_AMM_SDK.sellInstructions(sst, new BN(minBase.toString()), new BN(q.minQuote.toString())));
    const one = [...extend, ...wsolOpen(user, 0n), ...wd, ...sell, wsolClose(user)];
    if (await fits(user, one)) groups = [one];
    else groups = [[...extend, ...wsolOpen(user, 0n), ...wd, wsolClose(user)], [...wsolOpen(user, 0n), ...sell, wsolClose(user)]];
  }
  const built = await finish(user, groups, 0, poolKey);
  return { ...built, kind: 'remove', pool: poolKey.toBase58(), quote: { pct, lp: lp.toString(), coinOut: base.toString(), solOut: sol(quote), sellSol: sol(sellOut), toSol, decimals: st.decimals, steps: groups.length } };
}

/* ---------------- market data ---------------- */
async function dexMeta(mints) {
  const out = {};
  await Promise.all(chunk(mints, 30).map(async part => {
    try {
      const j = await getJson('https://api.dexscreener.com/tokens/v1/solana/' + part.join(','));
      for (const p of (Array.isArray(j) ? j : [])) {
        if (p.chainId !== 'solana') continue;
        out[p.pairAddress] = p;
        const m = p.baseToken && p.baseToken.address; if (m && !out['m:' + m]) out['m:' + m] = p;
      }
    } catch (e) { }
  }));
  return out;
}
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function solUsdFrom(meta) {
  const v = Object.values(meta).filter(p => p && p.quoteToken && p.quoteToken.symbol === 'SOL' && +p.priceNative > 0 && +p.priceUsd > 0).map(p => +p.priceUsd / +p.priceNative).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}
function cow(poolKey, pool, Rb, Rq, supply, decimals, fee, p, solUsd) {
  const tvlSol = 2 * sol(Rq);
  const volUsd = p && p.volume ? +p.volume.h24 || 0 : 0;
  const volSol = solUsd ? volUsd / solUsd : 0;
  const milk = tvlSol > 0 ? volSol * Number(fee.lp) / 10000 / tvlSol : 0;
  const mcapSol = Rb > 0n ? sol(Rq * supply / Rb) : 0;
  return {
    pool: poolKey, mint: pool.baseMint.toBase58(), name: p && p.baseToken ? p.baseToken.name : '', symbol: p && p.baseToken ? p.baseToken.symbol : '',
    image: p && p.info && p.info.imageUrl ? p.info.imageUrl : '', tvlSol, volSol, volUsd, lpBps: Number(fee.lp),
    totalBps: Number(fee.lp + fee.pr + fee.cr), milkPerSolDay: milk, apr: milk * 365, mcapSol,
    change24: p && p.priceChange ? +p.priceChange.h24 || 0 : 0, txns24: p && p.txns && p.txns.h24 ? (p.txns.h24.buys || 0) + (p.txns.h24.sells || 0) : 0,
    created: p && p.pairCreatedAt ? p.pairCreatedAt : null, decimals,
  };
}
async function candidateMints() {
  const gt = 'https://api.geckoterminal.com/api/v2/networks/solana/';
  const srcs = [
    gt + 'trending_pools?include=base_token,dex&page=1', gt + 'trending_pools?include=base_token,dex&page=2',
    gt + 'dexes/pumpswap/pools?page=1', gt + 'dexes/pumpswap/pools?page=2', gt + 'dexes/pumpswap/pools?page=3',
    gt + 'new_pools?include=base_token,dex&page=1',
    'https://api.dexscreener.com/token-boosts/top/v1', 'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-profiles/latest/v1',
  ];
  const mints = new Set();
  await Promise.all(srcs.map(async u => {
    try {
      const j = await getJson(u, 6500);
      if (Array.isArray(j)) { for (const t of j) if (t.chainId === 'solana' && t.tokenAddress) mints.add(t.tokenAddress); return; }
      for (const p of (j.data || [])) {
        const dex = p.relationships && p.relationships.dex && p.relationships.dex.data ? p.relationships.dex.data.id : 'pumpswap';
        if (dex !== 'pumpswap') continue;
        const id = p.relationships && p.relationships.base_token && p.relationships.base_token.data ? p.relationships.base_token.data.id : '';
        if (id.startsWith('solana_')) mints.add(id.slice(7));
      }
    } catch (e) { }
  }));
  if (CONFIG.ca) mints.add(CONFIG.ca);
  return [...mints].filter(m => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)).slice(0, 400);
}
async function pools() {
  return cached('pools', 90000, async () => {
    const { globalConfig, feeConfig } = await globals();
    const mints = await candidateMints();
    const keys = []; for (const m of mints) { try { keys.push([m, canonicalPumpPoolPda(new PublicKey(m))]); } catch (e) { } }
    const infos = await multi(keys.map(k => k[1]));
    const live = [];
    infos.forEach((info, i) => { if (info && info.owner.equals(PUMP_AMM_PROGRAM_ID)) { try { live.push({ key: keys[i][1], pool: PUMP_AMM_SDK.decodePool(info) }); } catch (e) { } } });
    const acc = await multi(live.flatMap(x => [x.pool.baseMint, x.pool.poolBaseTokenAccount, x.pool.poolQuoteTokenAccount]));
    const meta = await dexMeta(live.map(x => x.pool.baseMint.toBase58()));
    const solUsd = solUsdFrom(meta) || 0;
    const out = [];
    live.forEach((x, i) => {
      const [mi, bi, qi] = acc.slice(i * 3, i * 3 + 3);
      if (!mi || !bi || !qi) return;
      try {
        const mint = MintLayout.decode(mi.data.slice(0, MintLayout.span));
        const Rb = big(AccountLayout.decode(bi.data.slice(0, AccountLayout.span)).amount), Rq = big(AccountLayout.decode(qi.data.slice(0, AccountLayout.span)).amount);
        if (Rb === 0n || Rq === 0n) return;
        const fee = feesFor(x.pool, globalConfig, feeConfig, mint.supply, Rb, Rq);
        const p = meta[x.key.toBase58()] || null;
        const c = cow(x.key.toBase58(), x.pool, Rb, Rq, big(mint.supply), mint.decimals, fee, p, solUsd);
        if (c.tvlSol < MIN_TVL_SOL || !p) return;
        out.push(c);
      } catch (e) { }
    });
    out.sort((a, b) => b.milkPerSolDay - a.milkPerSolDay);
    return { solUsd, count: out.length, checked: mints.length, updated: Date.now(), pools: out.slice(0, 80) };
  });
}
async function poolOne(id, userStr) {
  let key = pk(id, 'address');
  const info = await rpc(c => c.getAccountInfo(key));
  if (!info || !info.owner.equals(PUMP_AMM_PROGRAM_ID)) {
    // treat it as a coin: its canonical SOL pool
    key = canonicalPumpPoolPda(key);
  }
  const user = userStr ? pk(userStr, 'wallet') : null;
  let st;
  try { st = await loadState(key, user); } catch (e) { if (e.code === 404) throw http(404, 'No PumpSwap SOL pool for that address yet. Coins still on the bonding curve have no pool.'); throw e; }
  const meta = await dexMeta([st.pool.baseMint.toBase58()]);
  const p = meta[key.toBase58()] || meta['m:' + st.pool.baseMint.toBase58()] || null;
  const solUsd = solUsdFrom(meta) || (await pools().catch(() => ({ solUsd: 0 }))).solUsd || 0;
  const c = cow(key.toBase58(), st.pool, st.Rb, st.Rq, st.supply, st.decimals, st.fee, p && p.pairAddress === key.toBase58() ? p : null, solUsd);
  if (!c.name && p && p.baseToken) { c.name = p.baseToken.name; c.symbol = p.baseToken.symbol; c.image = p.info && p.info.imageUrl || ''; }
  const out = { ...c, solPool: st.pool.quoteMint.equals(NATIVE_MINT), reserves: { coin: st.Rb.toString(), sol: sol(st.Rq), solLamports: st.Rq.toString(), vqr: st.vqr.toString() }, lpSupply: st.L.toString(), feeBps: { lp: Number(st.fee.lp), protocol: Number(st.fee.pr), creator: Number(st.fee.cr) }, solUsd };
  if (st.u) {
    const share = st.L > 0n ? Number(st.u.lp) / Number(st.L) : 0;
    out.you = { sol: sol(st.u.lamports), coin: st.u.base.toString(), lp: st.u.lp.toString(), share, valueSol: share * 2 * sol(st.Rq), coinInPool: st.L > 0n ? (st.Rb * st.u.lp / st.L).toString() : '0', solInPool: st.L > 0n ? sol(st.Rq * st.u.lp / st.L) : 0 };
  }
  return out;
}
async function positions(userStr) {
  const user = pk(userStr, 'wallet');
  const res = await rpc(c => c.getParsedTokenAccountsByOwner(user, { programId: TOKEN_2022_PROGRAM_ID }));
  const held = res.value.map(a => a.account.data.parsed.info).filter(i => i.tokenAmount && i.tokenAmount.amount !== '0');
  if (!held.length) return { positions: [] };
  const mintKeys = held.map(i => new PublicKey(i.mint));
  const mintInfos = await multi(mintKeys);
  const cands = mintInfos.map(mi => { if (!mi) return null; const m = MintLayout.decode(mi.data.slice(0, MintLayout.span)); return m.mintAuthorityOption ? m.mintAuthority : null; });
  const idx = cands.map((c, i) => [c, i]).filter(x => x[0]);
  const poolInfos = await multi(idx.map(x => x[0]));
  const found = [];
  poolInfos.forEach((info, j) => {
    if (!info || !info.owner.equals(PUMP_AMM_PROGRAM_ID)) return;
    try { const pool = PUMP_AMM_SDK.decodePool(info); const i = idx[j][1]; if (pool.lpMint.equals(mintKeys[i])) found.push({ key: idx[j][0], pool, lp: BigInt(held[i].tokenAmount.amount) }); } catch (e) { }
  });
  if (!found.length) return { positions: [] };
  const acc = await multi(found.flatMap(x => [x.pool.baseMint, x.pool.poolBaseTokenAccount, x.pool.poolQuoteTokenAccount]));
  const meta = await dexMeta(found.map(x => x.pool.baseMint.toBase58()));
  const solUsd = solUsdFrom(meta) || 0;
  const { globalConfig, feeConfig } = await globals();
  const out = [];
  found.forEach((x, i) => {
    const [mi, bi, qi] = acc.slice(i * 3, i * 3 + 3); if (!mi || !bi || !qi) return;
    const mint = MintLayout.decode(mi.data.slice(0, MintLayout.span));
    const Rb = big(AccountLayout.decode(bi.data.slice(0, AccountLayout.span)).amount), Rq = big(AccountLayout.decode(qi.data.slice(0, AccountLayout.span)).amount);
    const L = big(x.pool.lpSupply); if (L === 0n) return;
    const fee = feesFor(x.pool, globalConfig, feeConfig, mint.supply, Rb, Rq);
    const p = meta[x.key.toBase58()] || null;
    const c = cow(x.key.toBase58(), x.pool, Rb, Rq, big(mint.supply), mint.decimals, fee, p, solUsd);
    if (!c.name && meta['m:' + c.mint]) { const q = meta['m:' + c.mint]; c.name = q.baseToken.name; c.symbol = q.baseToken.symbol; c.image = q.info && q.info.imageUrl || ''; }
    const share = Number(x.lp) / Number(L);
    out.push({ ...c, lp: x.lp.toString(), share, valueSol: share * 2 * sol(Rq), coinInPool: (Rb * x.lp / L).toString(), solInPool: sol(Rq * x.lp / L), milkDaySol: share * c.volSol * c.lpBps / 10000, solPool: x.pool.quoteMint.equals(NATIVE_MINT) });
  });
  out.sort((a, b) => b.valueSol - a.valueSol);
  return { positions: out, solUsd };
}


/* ---------------- StonkFun: graduated coins trade on Raydium; read their pools' real fee APR ---------------- */
const SF_API = 'https://www.stonkfun.xyz/api/public/v1/tokens';
const RAY = 'https://api-v3.raydium.io/';
async function solUsdNow() {
  try { const p = await pools(); if (p.solUsd) return p.solUsd; } catch (e) { }
  try { const j = await getJson('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112'); const v = j['So11111111111111111111111111111111111111112']; if (v && v.usdPrice) return v.usdPrice; } catch (e) { }
  return 0;
}
async function stonkPools() {
  return cached('stonk', 120000, async () => {
    const lists = await Promise.allSettled([getJson(SF_API + '?sort=volume&pageSize=100', 9000), getJson(SF_API + '?sort=marketCap&pageSize=60', 9000)]);
    const toks = new Map(); let total = null;
    for (const l of lists) if (l.status === 'fulfilled') { const d = l.value.data || l.value; if (d.pagination && d.pagination.total) total = d.pagination.total; for (const t of d.tokens || []) if (t.status === 'graduated' && !toks.has(t.mint)) toks.set(t.mint, t); }
    const list = [...toks.values()].sort((a, b) => ((b.market || {}).volume24hUsd || 0) - ((a.market || {}).volume24hUsd || 0)).slice(0, 60);
    const solUsd = await solUsdNow();
    const out = [];
    for (let i = 0; i < list.length; i += 8) {
      await Promise.all(list.slice(i, i + 8).map(async t => {
        try {
          const j = await getJson(RAY + 'pools/info/mint?mint1=' + t.mint + '&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=5&page=1', 7000);
          const ps = ((j.data && j.data.data) || []).filter(p => p && p.tvl >= 1000 && p.day);
          const qm = t.quote && t.quote.mint;
          const p = ps.find(x => qm && (x.mintA.address === qm || x.mintB.address === qm)) || ps[0];
          if (!p) return;
          const vol = p.day.volume || 0, apr = p.day.feeApr || 0, m = t.market || {};
          out.push({
            venue: 'stonkfun', pool: p.id, mint: t.mint, name: t.name || t.symbol, symbol: t.symbol, image: t.imageUrl ? (t.imageUrl.startsWith('http') ? t.imageUrl : 'https://www.stonkfun.xyz' + t.imageUrl) : '',
            quote: t.quote ? t.quote.symbol : '', pair: (p.mintA.symbol || '?') + '/' + (p.mintB.symbol || '?'), poolType: p.type, feeRate: p.feeRate,
            tvlUsd: p.tvl, volUsd: vol, tvlSol: solUsd ? p.tvl / solUsd : 0, volSol: solUsd ? vol / solUsd : 0,
            milkPerSolDay: apr / 100 / 365, apr: apr / 100, lpBps: Math.min(Math.round((p.feeRate || 0) * 1e4 * 10) / 10, vol > 0 ? Math.round(apr / 100 / 365 * p.tvl / vol * 1e4 * 10) / 10 : Infinity),
            mcapSol: solUsd && m.marketCapUsd ? m.marketCapUsd / solUsd : 0, change24: m.priceChange24h || 0, created: t.createdAt ? Date.parse(t.createdAt) : null,
            addUrl: 'https://raydium.io/liquidity/increase/?mode=add&pool_id=' + p.id, sfUrl: 'https://www.stonkfun.xyz/token/' + t.mint,
          });
        } catch (e) { }
      }));
    }
    out.sort((a, b) => b.milkPerSolDay - a.milkPerSolDay);
    return { solUsd, count: out.length, checked: list.length, sfTotal: total, updated: Date.now(), pools: out };
  });
}

/* ---------------- router ---------------- */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const path = (q.get('__p') || url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
  try {
    if (path === 'config') return send(res, 200, { ok: true, jug: CONFIG.jug, feeBps: CONFIG.jug ? CONFIG.feeBps : 0, ca: CONFIG.ca, x: CONFIG.x, rpc: E('RPC_URL') ? 'private' : 'public' }, 'public, s-maxage=60');
    if (path === 'pools') return send(res, 200, { ok: true, ...(await pools()) }, 'public, s-maxage=60, stale-while-revalidate=240');
    if (path === 'stonk') return send(res, 200, { ok: true, ...(await stonkPools()) }, 'public, s-maxage=90, stale-while-revalidate=300');
    if (path === 'pool') return send(res, 200, { ok: true, pool: await poolOne(q.get('id'), q.get('user')) }, q.get('user') ? 'no-store' : 'public, s-maxage=10');
    if (path === 'positions') return send(res, 200, { ok: true, ...(await positions(q.get('user'))) });
    if (path === 'jug') {
      if (!CONFIG.jug) return send(res, 200, { ok: true, jug: '', sol: 0 });
      const l = await rpc(c => c.getBalance(new PublicKey(CONFIG.jug)));
      return send(res, 200, { ok: true, jug: CONFIG.jug, sol: sol(l) }, 'public, s-maxage=20');
    }
    if (path === 'lp') {
      // top LP holders of a pool (public data; used to test withdrawals)
      const poolKey = pk(q.get('pool'), 'pool');
      const info = await rpc(c => c.getAccountInfo(poolKey));
      if (!info || !info.owner.equals(PUMP_AMM_PROGRAM_ID)) throw http(404, 'not a pool');
      const pool = PUMP_AMM_SDK.decodePool(info);
      const big = await rpc(c => c.getTokenLargestAccounts(pool.lpMint));
      const tops = big.value.filter(a => a.amount !== '0').slice(0, 10);
      const infos = await rpc(c => c.getMultipleParsedAccounts(tops.map(t => t.address)));
      return send(res, 200, { ok: true, lpMint: pool.lpMint.toBase58(), supply: pool.lpSupply.toString(), holders: infos.value.map((v, i) => ({ owner: v && v.data && v.data.parsed ? v.data.parsed.info.owner : null, amount: tops[i].amount })) }, 'public, s-maxage=60');
    }
    if (path === 'status') {
      const sig = String(q.get('sig') || '');
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw http(400, 'bad signature');
      const r = await rpc(c => c.getSignatureStatuses([sig], { searchTransactionHistory: false }));
      const s = r.value[0];
      return send(res, 200, { ok: true, status: s ? s.confirmationStatus : null, err: s ? s.err : null });
    }
    if (req.method !== 'POST') throw http(404, 'Not found');
    const b = await readBody(req);
    if (path === 'tx') {
      const kind = String(b.kind || '');
      const r = kind === 'add' ? await buildAdd(b) : kind === 'add2' ? await buildAdd2(b) : kind === 'remove' ? await buildRemove(b) : null;
      if (!r) throw http(400, 'unknown kind');
      return send(res, 200, { ok: true, ...r });
    }
    if (path === 'send') {
      const raw = Buffer.from(String(b.tx || ''), 'base64');
      if (raw.length < 100 || raw.length > 1232) throw http(400, 'bad transaction');
      const sig = await rpc(c => c.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'processed', maxRetries: 3 }));
      return send(res, 200, { ok: true, sig });
    }
    throw http(404, 'Not found');
  } catch (e) {
    const code = e.code && e.code >= 400 && e.code < 600 ? e.code : 500;
    return send(res, code, { ok: false, error: String(e.message || e).slice(0, 400), logs: e.logs || undefined });
  }
};
// exported for local tests
module.exports._t = { planAdd, buyCost, keep, cow };
