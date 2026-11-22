#!/usr/bin/env node
// AgentDrop helper for AI agents using the Binance Agentic Wallet (`baw`).
//
// It ONLY reads chain state (eth_call) and builds calldata. It never signs, never broadcasts and never
// touches keys or sessions. Every transaction it prepares must go through
//   baw contract-call preview  ->  show the user  ->  explicit user confirmation  ->  baw contract-call execute
//
// Zero dependencies (Node >= 18). Usage: node agentdrop.mjs <command> [options]   (see `help`)

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// ------------------------------------------------------------------ config

export const CHAIN_ID = 56;
export const AGENTDROP = (process.env.AGENTDROP_ADDRESS || '0x0f7Ad86c06531F67FCbe4D2D334acb56b2c51517').toLowerCase();
const RPCS = (process.env.AGENTDROP_RPC || 'https://bsc-dataseed.bnbchain.org,https://bsc-rpc.publicnode.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const SEL = {
  packetCount: '0x6de56271',
  getPacket: '0xa59455dc',
  canClaim: '0x1eefebc3',
  hashCode: '0x6f5fc2bc',
  claim: '0x268b15ed',
  refund: '0x278ecde1',
  refundTo: '0x5f7b866c',
  createPacket: '0x701fd664',
  approve: '0x095ea7b3',
  allowance: '0xdd62ed3e',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  balanceOf: '0x70a08231',
};

export const REASONS = {
  0: 'OK — you can open this packet',
  1: 'Packet not found',
  2: 'Packet has expired',
  3: 'Packet is empty — all shares already opened',
  4: 'This wallet has no Agent ID — claim one in the Binance App (Wallet -> Agent ID)',
  5: 'This wallet already opened this packet',
  6: 'This wallet does not hold enough of the required gate token',
  7: 'Wrong or missing code',
};

const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_UINT128 = (1n << 128n) - 1n;

// ------------------------------------------------------------------ abi helpers

const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`Invalid address: ${a}`);
  return strip(a).toLowerCase().padStart(64, '0');
};
const bytes32Word = (h) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`Invalid bytes32: ${h}`);
  return strip(h).toLowerCase();
};
const stringTail = (s) => {
  const b = Buffer.from(s, 'utf8');
  const hex = b.toString('hex');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return word(b.length) + padded;
};
const words = (hex) => strip(hex).match(/.{64}/g) || [];
const toAddr = (w) => '0x' + w.slice(24);
const toBig = (w) => BigInt('0x' + w);

function decodeString(hex) {
  const h = strip(hex);
  if (h.length === 64) return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, ''); // bytes32 symbols
  const off = Number(BigInt('0x' + h.slice(0, 64))) * 2;
  const len = Number(BigInt('0x' + h.slice(off, off + 64)));
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8');
}

// ------------------------------------------------------------------ rpc

let rpcIdx = 0;
async function rpc(method, params) {
  let lastErr;
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      rpcIdx = (rpcIdx + i) % RPCS.length;
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`RPC failed (${method}): ${lastErr?.message}`);
}
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);

// Chain time (latest block), not the local clock — expiry is decided on-chain.
let nowCache;
async function chainNow() {
  if (nowCache === undefined) {
    const b = await rpc('eth_getBlockByNumber', ['latest', false]);
    nowCache = Number(BigInt(b.timestamp));
  }
  return nowCache;
}

// ------------------------------------------------------------------ reads

function requireDeployed() {
  if (AGENTDROP === ZERO) throw new Error('AGENTDROP_ADDRESS is not set (contract not deployed yet).');
}

export async function packetCount() {
  return Number(toBig(strip(await call(AGENTDROP, SEL.packetCount))));
}

export async function getPacket(id) {
  const w = words(await call(AGENTDROP, SEL.getPacket + word(id)));
  const p = {
    id: Number(id),
    creator: toAddr(w[0]),
    expiresAt: Number(toBig(w[1])),
    shares: Number(toBig(w[2])),
    claimed: Number(toBig(w[3])),
    mode: Number(toBig(w[4])) === 1 ? 'lucky' : 'equal',
    token: toAddr(w[5]),
    total: toBig(w[6]),
    remaining: toBig(w[7]),
    gateToken: toAddr(w[8]),
    gateMin: toBig(w[9]),
    vault: toAddr(w[10]),
    codeHash: '0x' + w[11],
    hasCode: w[11] !== '0'.repeat(64),
  };
  if (p.creator === ZERO) return null;
  return p;
}

const tokenCache = new Map();
export async function tokenInfo(token) {
  if (token === ZERO) return { symbol: 'BNB', decimals: 18 };
  if (tokenCache.has(token)) return tokenCache.get(token);
  const [d, s] = await Promise.all([
    call(token, SEL.decimals).catch(() => null),
    call(token, SEL.symbol).catch(() => null),
  ]);
  const info = { symbol: s ? decodeString(s) : '?', decimals: d ? Number(toBig(strip(d))) : 18 };
  tokenCache.set(token, info);
  return info;
}

export async function canClaim(id, who, code = '') {
  const data = SEL.canClaim + word(id) + addrWord(who) + word(0x60) + stringTail(code);
  return Number(toBig(strip(await call(AGENTDROP, data))));
}

// Keccak-256 (Ethereum variant), so secret codes are hashed locally and never sent to an RPC.
const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n,
  0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn,
  0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an,
  0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & M64 & b[((x + 2) % 5) + y]);
    s[0] ^= RC[r];
  }
}
export function keccak256(bytes) {
  const rate = 136;
  const msg = Buffer.concat([Buffer.from(bytes), Buffer.alloc(rate - (bytes.length % rate))]);
  msg[bytes.length] ^= 0x01;
  msg[msg.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= msg.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return '0x' + out.toString('hex');
}

/// keccak256(abi.encode(creator, code)) — identical to AgentDrop.hashCode, computed locally.
export function hashCode(creator, code) {
  return keccak256(Buffer.from(addrWord(creator) + word(0x40) + stringTail(code), 'hex'));
}

// ------------------------------------------------------------------ formatting

export function parseUnits(s, decimals) {
  if (!/^\d+(\.\d+)?$/.test(String(s))) throw new Error(`Invalid amount: ${s}`);
  const [i, f = ''] = String(s).split('.');
  if (f.length > decimals) throw new Error(`Too many decimals (max ${decimals})`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}
export function formatUnits(v, decimals) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const f = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (a / base).toString() + (f ? '.' + f : '');
}
export function parseDuration(s) {
  const m = /^(\d+)\s*(m|h|d)$/i.exec(String(s));
  if (!m) throw new Error(`Invalid duration "${s}" (use e.g. 30m, 24h, 7d)`);
  return Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
}

async function describe(p) {
  const t = await tokenInfo(p.token);
  const now = await chainNow();
  return {
    id: p.id,
    status: p.remaining === 0n ? 'finished' : now >= p.expiresAt ? 'expired' : p.claimed >= p.shares ? 'empty' : 'open',
    token: p.token === ZERO ? 'BNB' : p.token,
    symbol: t.symbol,
    total: formatUnits(p.total, t.decimals),
    remaining: formatUnits(p.remaining, t.decimals),
    opened: `${p.claimed}/${p.shares}`,
    mode: p.mode,
    needsCode: p.hasCode,
    gate: p.gateToken === ZERO ? null : { token: p.gateToken, min: p.gateMin.toString() },
    creator: p.creator,
    expiresAt: new Date(p.expiresAt * 1000).toISOString(),
  };
}

function previewCmd(from, tx) {
  return (
    `baw contract-call preview --binanceChainId ${CHAIN_ID} --from ${from} --to ${tx.to}` +
    ` --value ${tx.value} --inputData ${tx.inputData} --json`
  );
}

// ------------------------------------------------------------------ commands

async function cmdList(opts) {
  requireDeployed();
  const n = await packetCount();
  const from = Math.max(1, n - Number(opts.limit || 50) + 1);
  const ids = [];
  for (let i = n; i >= from; i--) ids.push(i);
  const packets = (await Promise.all(ids.map((i) => getPacket(i)))).filter(Boolean);
  let out = await Promise.all(packets.map(describe));
  if (!opts.all) out = out.filter((p) => p.status === 'open');
  if (opts.creator) out = out.filter((p) => p.creator.toLowerCase() === opts.creator.toLowerCase());
  if (opts.from) {
    for (const p of out) {
      if (p.status !== 'open') continue;
      const r = await canClaim(p.id, opts.from, '');
      p.youCanOpen = r === 7 ? 'OK if you have the code' : REASONS[r];
    }
  }
  return { contract: AGENTDROP, packetCount: n, packets: out };
}

async function cmdInfo(id) {
  requireDeployed();
  const p = await getPacket(id);
  if (!p) throw new Error(`Packet #${id} not found`);
  return describe(p);
}

async function cmdFind(opts) {
  requireDeployed();
  if (!opts.code) throw new Error('--code is required');
  const n = await packetCount();
  const matches = [];
  for (let i = n; i >= Math.max(1, n - 500); i--) {
    const p = await getPacket(i);
    if (!p || !p.hasCode || p.remaining === 0n) continue;
    if (p.codeHash !== (await hashCode(p.creator, opts.code)).toLowerCase()) continue;
    const m = await describe(p);
    if (opts.from) m.youCanOpen = REASONS[await canClaim(i, opts.from, opts.code)];
    matches.push(m);
  }
  return { code: opts.code, matches };
}

async function cmdClaim(id, opts) {
  requireDeployed();
  if (!opts.from) throw new Error('--from <your agentic wallet address> is required');
  const code = opts.code || '';
  const reason = await canClaim(id, opts.from, code);
  if (reason !== 0) return { ok: false, reason, message: REASONS[reason] };
  const tx = { to: AGENTDROP, value: '0', inputData: SEL.claim + word(id) + word(0x40) + stringTail(code) };
  return {
    ok: true,
    packet: await cmdInfo(id),
    steps: [{ action: `Open packet #${id}`, ...tx, preview: previewCmd(opts.from, tx) }],
  };
}

async function cmdCreate(opts) {
  requireDeployed();
  if (!opts.from) throw new Error('--from <your agentic wallet address> is required');
  const isBnb = !opts.token || opts.token.toLowerCase() === 'bnb';
  const token = isBnb ? ZERO : opts.token.toLowerCase();
  const t = await tokenInfo(token);
  const amount = parseUnits(opts.amount, t.decimals);
  const shares = Number(opts.shares);
  const mode = (opts.mode || 'equal').toLowerCase() === 'lucky' ? 1 : 0;
  const duration = parseDuration(opts.duration || '24h');
  if (!(shares >= 1 && shares <= 1000)) throw new Error('--shares must be 1..1000');
  if (amount === 0n || amount > MAX_UINT128) throw new Error('Invalid amount');
  if (amount < BigInt(shares)) throw new Error('Amount too small for that many shares');
  if (duration < 600 || duration > 30 * 86400) throw new Error('Duration must be between 10m and 30d');

  if (opts.code === 'auto' || opts.code === true) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
    opts.code = [...randomBytes(8)].map((b) => abc[b % abc.length]).join('');
  }
  const codeHash = opts.code ? hashCode(opts.from, opts.code) : '0x' + '0'.repeat(64);
  const gateToken = opts.gateToken ? opts.gateToken.toLowerCase() : ZERO;
  let gateMin = 0n;
  if (gateToken !== ZERO) gateMin = parseUnits(opts.gateMin || '0', (await tokenInfo(gateToken)).decimals);

  const steps = [];
  if (!isBnb) {
    const allowance = toBig(strip(await call(token, SEL.allowance + addrWord(opts.from) + addrWord(AGENTDROP))));
    if (allowance < amount) {
      // exact-amount approval only — never unlimited
      const tx = { to: token, value: '0', inputData: SEL.approve + addrWord(AGENTDROP) + word(amount) };
      steps.push({ action: `Approve exactly ${opts.amount} ${t.symbol} for AgentDrop`, ...tx, preview: previewCmd(opts.from, tx) });
    }
  }
  const tuple =
    addrWord(isBnb ? ZERO : token) +
    word(amount) +
    word(shares) +
    word(mode) +
    word(duration) +
    bytes32Word(codeHash) +
    (gateToken === ZERO ? word(0) : addrWord(gateToken)) +
    word(gateMin);
  const tx = { to: AGENTDROP, value: isBnb ? amount.toString() : '0', inputData: SEL.createPacket + tuple };
  steps.push({
    action: `Create ${mode ? 'lucky' : 'equal'} packet: ${opts.amount} ${t.symbol} for ${shares} agents, expires in ${opts.duration || '24h'}${opts.code ? ', code required' : ''}`,
    ...tx,
    preview: previewCmd(opts.from, tx),
  });
  return {
    ok: true,
    note: 'Run each step in order: preview -> show user -> wait for explicit confirmation -> execute. Then run `list --creator <from>` to get the new packet id.',
    shareLink: opts.code ? `Tell friends: "open AgentDrop code ${opts.code}"` : null,
    steps,
  };
}

async function cmdRefund(id, opts) {
  requireDeployed();
  const p = await getPacket(id);
  if (!p) throw new Error(`Packet #${id} not found`);
  if ((await chainNow()) < p.expiresAt) return { ok: false, message: `Not expired yet (expires ${new Date(p.expiresAt * 1000).toISOString()})` };
  if (p.remaining === 0n) return { ok: false, message: 'Nothing left to refund' };
  let tx;
  let note;
  if (opts.to) {
    if (!opts.from || opts.from.toLowerCase() !== p.creator) return { ok: false, message: 'Only the creator can choose another refund address (--from must be the creator)' };
    tx = { to: AGENTDROP, value: '0', inputData: SEL.refundTo + word(id) + addrWord(opts.to) };
    note = `Remaining funds go to ${opts.to} (chosen by the creator).`;
  } else {
    tx = { to: AGENTDROP, value: '0', inputData: SEL.refund + word(id) };
    note = `Remaining funds always go to the creator ${p.creator}, whoever sends this.`;
  }
  return {
    ok: true,
    note,
    steps: [{ action: `Refund packet #${id}`, ...tx, preview: opts.from ? previewCmd(opts.from, tx) : null }],
  };
}

const HELP = `AgentDrop helper (reads chain + builds calldata; never signs)

  list   [--from <addr>] [--creator <addr>] [--all] [--limit 50]
  info   <id>
  find   --code <CODE> [--from <addr>]
  claim  <id> --from <addr> [--code <CODE>]
  create --from <addr> --amount <n> --shares <n> [--token bnb|<erc20>] [--mode equal|lucky]
         [--duration 24h] [--code <CODE>|auto] [--gate-token <erc20> --gate-min <n>]
  refund <id> [--from <addr>] [--to <addr>]   (--to: creator only, e.g. when creator cannot receive BNB)

Env: AGENTDROP_ADDRESS (contract), AGENTDROP_RPC (comma-separated BSC RPCs)`;

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else opts[key] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opts };
}

export async function main(argv) {
  const { pos, opts } = parseArgs(argv);
  const [cmd, arg] = pos;
  switch (cmd) {
    case 'list': return cmdList(opts);
    case 'info': return cmdInfo(Number(arg));
    case 'find': return cmdFind(opts);
    case 'claim': return cmdClaim(Number(arg), opts);
    case 'create': return cmdCreate(opts);
    case 'refund': return cmdRefund(Number(arg), opts);
    default: return HELP;
  }
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2))
    .then((r) => console.log(typeof r === 'string' ? r : JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)))
    .catch((e) => {
      console.log(JSON.stringify({ ok: false, error: e.message }));
      process.exitCode = 1;
    });
}
