// AgentDrop public page — read-only. Reads BNB Chain directly; never connects a wallet.
const CFG = {
  drop: '0x0f7Ad86c06531F67FCbe4D2D334acb56b2c51517',
  agentId: '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',
  deployBlock: 134614858,
  callRpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
  logRpc: 'https://bsc-rpc.publicnode.com', // allows 50k-block eth_getLogs ranges
  logSpan: 49000,
  github: 'https://github.com/tuanlv273/agentdrop',
};
const TOPIC_CLAIMED = '0x37f7df91b5b2059c1eff894a9c649b34919ed5be6f2d34c493fc9617aac05fc5';
const SEL = { packetCount: '0x6de56271', getPacket: '0xa59455dc', decimals: '0x313ce567', symbol: '0x95d89b41' };
const ZERO = '0x0000000000000000000000000000000000000000';
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- rpc
let idx = 0;
async function rpc(method, params, url) {
  const urls = url ? [url] : CFG.callRpcs;
  let err;
  for (let i = 0; i < urls.length; i++) {
    const u = urls[(idx + i) % urls.length];
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      if (!url) idx = (idx + i) % urls.length;
      return j.result;
    } catch (e) { err = e; }
  }
  throw err;
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
const words = (h) => h.slice(2).match(/.{64}/g) || [];
const big = (w) => BigInt('0x' + w);
const addr = (w) => '0x' + w.slice(24);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

function fmt(v, d) {
  const base = 10n ** BigInt(d);
  const i = v / base;
  let f = (v % base).toString().padStart(d, '0').slice(0, 6).replace(/0+$/, '');
  if (i === 0n && !f && v > 0n) return '<0.000001';
  return i.toString() + (f ? '.' + f : '');
}
function decodeString(h) {
  const x = h.slice(2);
  if (x.length === 64) return new TextDecoder().decode(Uint8Array.from(x.match(/../g).map((b) => parseInt(b, 16)))).replace(/\0+$/, '');
  const off = Number(BigInt('0x' + x.slice(0, 64))) * 2, len = Number(BigInt('0x' + x.slice(off, off + 64)));
  return new TextDecoder().decode(Uint8Array.from((x.slice(off + 64, off + 64 + len * 2).match(/../g) || []).map((b) => parseInt(b, 16))));
}
const tokCache = new Map([[ZERO, { symbol: 'BNB', decimals: 18 }]]);
async function token(t) {
  if (tokCache.has(t)) return tokCache.get(t);
  const [d, s] = await Promise.all([call(t, SEL.decimals).catch(() => null), call(t, SEL.symbol).catch(() => null)]);
  const info = { symbol: s ? decodeString(s).slice(0, 12) : 'TOKEN', decimals: d ? Number(big(d.slice(2))) : 18 };
  tokCache.set(t, info);
  return info;
}
async function packet(id) {
  const w = words(await call(CFG.drop, SEL.getPacket + word(id)));
  if (addr(w[0]) === ZERO) return null;
  return {
    id, creator: addr(w[0]), expiresAt: Number(big(w[1])), shares: Number(big(w[2])), claimed: Number(big(w[3])),
    mode: Number(big(w[4])) === 1 ? 'lucky' : 'equal', token: addr(w[5]), total: big(w[6]), remaining: big(w[7]),
    gate: addr(w[8]) !== ZERO, hasCode: w[11] !== '0'.repeat(64),
  };
}

// ---------------------------------------------------------------- logs (unique openers), cached per browser
const CACHE_KEY = 'agentdrop-claims-v1:' + CFG.drop.toLowerCase();
function loadCache() {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if (c && c.next) return { next: c.next, opens: c.opens, people: new Set(c.people) }; } catch {}
  return { next: CFG.deployBlock, opens: 0, people: new Set() };
}
function saveCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ next: c.next, opens: c.opens, people: [...c.people] })); } catch {}
}
async function syncClaims(onProgress) {
  const c = loadCache();
  const head = Number(BigInt(await rpc('eth_blockNumber', [], CFG.logRpc)));
  const ranges = [];
  for (let f = c.next; f <= head; f += CFG.logSpan) ranges.push([f, Math.min(f + CFG.logSpan - 1, head)]);
  for (let i = 0; i < ranges.length; i += 4) {
    const batch = ranges.slice(i, i + 4);
    const res = await Promise.all(batch.map(([f, t]) => rpc('eth_getLogs', [{ address: CFG.drop, topics: [TOPIC_CLAIMED], fromBlock: '0x' + f.toString(16), toBlock: '0x' + t.toString(16) }], CFG.logRpc)));
    for (const logs of res) for (const l of logs) { c.opens++; c.people.add(('0x' + l.topics[2].slice(26)).toLowerCase()); }
    c.next = batch[batch.length - 1][1] + 1;
    saveCache(c);
    onProgress(c, Math.min(1, (i + batch.length) / ranges.length));
  }
  return c;
}

// ---------------------------------------------------------------- render
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 1400); }
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy],[data-text]');
  if (!b) return;
  const text = b.dataset.text || $(b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it to your agent'); } catch { toast(text); }
});

function timeLeft(s) {
  const d = s - Date.now() / 1000;
  if (d <= 0) return 'expired';
  if (d < 3600) return Math.ceil(d / 60) + ' min left';
  if (d < 86400) return Math.round(d / 3600) + ' h left';
  return Math.round(d / 86400) + ' days left';
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function renderPackets() {
  const n = Number(big((await call(CFG.drop, SEL.packetCount)).slice(2)));
  $('#s-packets').textContent = n.toLocaleString();
  const ids = [];
  for (let i = n; i >= Math.max(1, n - 60); i--) ids.push(i);
  const ps = (await Promise.all(ids.map(packet))).filter(Boolean);
  const now = Date.now() / 1000;
  const open = ps.filter((p) => p.remaining > 0n && p.claimed < p.shares && p.expiresAt > now);
  if (!open.length) {
    $('#hero-cmd').textContent = 'Send an AgentDrop lucky packet of 0.01 BNB to 10 agents';
    $('#list').innerHTML = '<div class="empty">No open packets right now. Create one: ask your agent <i>“send an AgentDrop lucky packet of 0.01 BNB to 10 agents”</i>.</div>';
    return;
  }
  const cards = await Promise.all(open.map(async (p) => {
    const t = await token(p.token);
    const pct = Math.round((p.claimed / p.shares) * 100);
    const cmd = p.hasCode ? `Open AgentDrop packet #${p.id} with code ` : `Open AgentDrop packet #${p.id}`;
    return `<article class="card">
      <div class="row"><span class="amt">${esc(fmt(p.remaining, t.decimals))} <small>${esc(t.symbol)}</small></span><span class="pill">#${p.id}</span></div>
      <div class="row muted"><span>${p.claimed}/${p.shares} opened · ${p.mode}</span><span>${timeLeft(p.expiresAt)}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="row">${p.hasCode ? '<span class="pill code">needs code</span>' : '<span class="pill">no code</span>'}${p.gate ? '<span class="pill">holders only</span>' : ''}
      <button data-text="${esc(cmd)}">Copy command</button></div>
      ${p.token !== ZERO ? '<span class="muted">Token packet — check the token before trusting its value.</span>' : ''}
    </article>`;
  }));
  $('#list').innerHTML = cards.join('');
  $('#hero-cmd').textContent = open[0].hasCode ? `Open AgentDrop packet #${open[0].id} with code …` : `Open AgentDrop packet #${open[0].id}`;
}

async function main() {
  const scan = (a) => `https://bscscan.com/address/${a}#code`;
  $('#c-drop').textContent = CFG.drop; $('#c-drop').href = scan(CFG.drop);
  $('#c-aid').textContent = CFG.agentId; $('#c-aid').href = `https://bscscan.com/address/${CFG.agentId}`;
  $('#gh').href = CFG.github;
  const show = (c, p) => {
    $('#s-people').textContent = c.people.size.toLocaleString();
    $('#s-opens').textContent = c.opens.toLocaleString();
    $('#sync').textContent = p < 1 ? `Counting openers from chain… ${Math.round(p * 100)}%` : `Live from BNB Chain · updated ${new Date().toLocaleTimeString()}`;
  };
  show(loadCache(), 0);
  renderPackets().catch((e) => { $('#list').innerHTML = `<div class="empty">Could not reach BNB Chain RPC (${esc(e.message)}). Try again shortly.</div>`; });
  try { const c = await syncClaims(show); show(c, 1); } catch (e) { $('#sync').textContent = 'Opener count paused: RPC limit reached, retrying in 30 s.'; }
  setInterval(() => { renderPackets().catch(() => {}); syncClaims(show).then((c) => show(c, 1)).catch(() => {}); }, 30000);
}
main();
