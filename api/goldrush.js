// GET /api/goldrush?endpoint=price|all_holders|transfers
// SPCXx (tokenized SpaceX, xStocks) holder intelligence across Arbitrum, Ethereum, BNB Chain and Solana.
// All data from the GoldRush (Covalent) API. The key is read from the GOLDRUSH_API_KEY env var.

const BASE = 'https://api.covalenthq.com/v1';
const EVM_CONTRACT = '0x68fa48b1c2fe52b3d776e1953e0e782b5044ce28';
const SOL_CONTRACT = 'Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8';
const EVM_CHAINS = ['arbitrum-mainnet', 'eth-mainnet', 'bsc-mainnet'];
// ~1 week of blocks per chain for the transfer pulse
const BLOCK_WINDOW = { 'arbitrum-mainnet': 2400000, 'eth-mainnet': 50000, 'bsc-mainnet': 200000 };

const LABELS = {
  '0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0': 'Kraken',
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe': 'Gate.io',
  '0xd551234ae421e3bcba99a0da6d736074f22192ff': 'Binance',
  '0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be': 'Binance',
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Bybit',
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40': 'Bybit',
  '0x2b5634c42055806a59e9107ed44d43c426e58258': 'KuCoin',
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b': 'OKX',
  '0x236f9f97e0e62388479bf9e5ba4889e46b0273c3': 'Coinbase',
  '0x0000000000000000000000000000000000000000': 'Issuance',
  '0x000000000000000000000000000000000000dead': 'Burn',
};
const lbl = a => (a ? LABELS[a.toLowerCase()] || null : null);

class GRError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function get(path, key) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new GRError(j.error_message || `GoldRush ${r.status}`, r.status);
  return j.data;
}

const day = d => d.toISOString().slice(0, 10);

async function price(key) {
  const to = new Date();
  const from = new Date(Date.now() - 31 * 86400000);
  for (const chain of EVM_CHAINS) {
    try {
      const data = await get(`/pricing/historical_by_addresses_v2/${chain}/USD/${EVM_CONTRACT}/?from=${day(from)}&to=${day(to)}`, key);
      const prices = (data?.[0]?.prices || []).filter(p => p.price > 0);
      if (!prices.length) continue;
      const history = prices.map(p => ({ date: p.date, price: p.price })).reverse(); // oldest → newest
      const last = history[history.length - 1].price;
      const prev = history.length > 1 ? history[history.length - 2].price : last;
      return { priceUsd: last, priceChange24h: prev ? ((last - prev) / prev) * 100 : 0, source: `GoldRush · ${chain}`, history };
    } catch (e) {
      if (e.status === 401 || e.status === 402 || e.status === 429) throw e;
    }
  }
  return { priceUsd: null };
}

async function holders(chain, contract, key) {
  const data = await get(`/${chain}/tokens/${contract}/token_holders_v2/?page-size=100`, key);
  const items = (data?.items || []).map(i => ({
    address: i.address,
    balance: i.balance,
    label: lbl(i.address),
  }));
  return {
    chain,
    items,
    total_count: data?.pagination?.total_count ?? items.length,
    decimals: data?.items?.[0]?.contract_decimals ?? 18,
    quote_rate: data?.items?.[0]?.quote_rate || 0,
  };
}

async function allHolders(key) {
  const jobs = [
    ...EVM_CHAINS.map(c => holders(c, EVM_CONTRACT, key)),
    holders('solana-mainnet', SOL_CONTRACT, key),
  ];
  const results = await Promise.allSettled(jobs);
  const auth = results.find(r => r.status === 'rejected' && [401, 402, 429].includes(r.reason?.status));
  const chainData = results.filter(r => r.status === 'fulfilled' && r.value.items.length).map(r => r.value);
  if (!chainData.length && auth) throw auth.reason;
  return { chainData };
}

async function transfersFor(chain, key) {
  const latest = await get(`/${chain}/block_v2/latest/`, key);
  const head = latest?.items?.[0]?.height;
  if (!head) return [];
  const start = Math.max(0, head - (BLOCK_WINDOW[chain] || 100000));
  const data = await get(`/${chain}/events/address/${EVM_CONTRACT}/?starting-block=${start}&ending-block=latest&page-size=100`, key);
  return (data?.items || [])
    .filter(e => e.decoded?.name === 'Transfer')
    .map(e => {
      const p = Object.fromEntries((e.decoded.params || []).map(x => [x.name, x.value]));
      const from = p.from || '';
      const to = p.to || '';
      const decimals = e.sender_contract_decimals ?? 18;
      let amount = 0;
      try { amount = Number(BigInt(String(p.value || '0'))) / 10 ** decimals; } catch {}
      return {
        chain, from_address: from, to_address: to, from_label: lbl(from), to_label: lbl(to),
        amount, block_signed_at: e.block_signed_at, tx_hash: e.tx_hash,
      };
    });
}

async function transfers(key) {
  const results = await Promise.allSettled(EVM_CHAINS.map(c => transfersFor(c, key)));
  const auth = results.find(r => r.status === 'rejected' && [401, 402, 429].includes(r.reason?.status));
  const items = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value)
    .sort((a, b) => new Date(b.block_signed_at) - new Date(a.block_signed_at));
  if (!items.length && auth) throw auth.reason;
  return { items };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.GOLDRUSH_API_KEY;
  if (!key) return res.status(200).json({ error: 'GoldRush API key not configured', code: 'NO_KEY' });

  const endpoint = req.query.endpoint;
  try {
    let out;
    if (endpoint === 'price') out = await price(key);
    else if (endpoint === 'all_holders') out = await allHolders(key);
    else if (endpoint === 'transfers') out = await transfers(key);
    else return res.status(400).json({ error: 'unknown endpoint' });
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).json(out);
  } catch (e) {
    const code = e.status === 402 ? 'NO_CREDITS' : e.status === 401 ? 'BAD_KEY' : e.status === 429 ? 'RATE_LIMIT' : 'ERROR';
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ error: e.message, code });
  }
}
