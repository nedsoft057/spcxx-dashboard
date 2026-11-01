# SPCXx Intelligence Terminal

Who actually got into tokenized SpaceX? Tracks SPCXx (xStocks) holders across Arbitrum, Ethereum, BNB Chain and Solana. Exchange custody wallets are labeled, and there's a live transfer pulse.

**Live:** https://spcxx-dashboard.vercel.app

## Stack

- `public/index.html`: a static page with canvas charts and no framework.
- `api/goldrush.js`: a Vercel function that proxies the GoldRush (Covalent) API.
  - `?endpoint=price` uses historical pricing for the SPCXx contract.
  - `?endpoint=all_holders` uses `token_holders_v2` on each chain, with CEX wallet labels.
  - `?endpoint=transfers` returns recent `Transfer` events for the contract.

## Setup

Set `GOLDRUSH_API_KEY` in Vercel (Project → Settings → Environment Variables). The key is only used server-side and never sent to the browser. If the key has no credits, the page says so instead of hanging.
