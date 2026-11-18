// Pay-per-call LLM via NanoGPT x402 v1 "exact" (Base USDC, EIP-3009 TransferWithAuthorization; no account, gasless for us).
// Usage: node x402-call.mjs "<prompt>" [model]   |   import { llmCall } from './x402-call.mjs'
// Safety: only Base + official USDC + amount <= MAX_ATOMIC (0.01 USDC) are ever signed. Every paid call is logged.
import { createWalletClient, createPublicClient, http, getAddress, toHex, erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import crypto from 'crypto';
import fs from 'fs';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MAX_ATOMIC = BigInt(process.env.X402_MAX_ATOMIC || '10000'); // per-call cap in USDC atomic units (10000 = 0.01 USDC)
const URL = 'https://api.nano-gpt.com/api/v1/chat/completions';
const LOG = process.env.X402_LOG || './x402-spend.jsonl';
const KEY_FILE = process.env.WALLET_KEY_FILE;
if (!KEY_FILE) throw new Error('Set WALLET_KEY_FILE to a file containing a hex private key (use a dedicated low-balance wallet!)');
const account = privateKeyToAccount(('0x' + fs.readFileSync(KEY_FILE, 'utf8').trim().replace(/^0x/, '')));
const wallet = createWalletClient({ account, chain: base, transport: http(process.env.BASE_RPC || 'https://mainnet.base.org') });

const pub = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC || 'https://mainnet.base.org') });

// Rail 2 (fallback when the x402 facilitator is down): "base-usdc" quote-and-complete.
// Transfer the quoted USDC to the quote's unique payTo address (we pay gas, ~$0.001), then POST completeUrl.
export async function llmCallBaseUsdc(messages, { model = 'deepseek-v4-flash', max_tokens = 1200, temperature = 0.3 } = {}) {
  const body = JSON.stringify({ model, messages, max_tokens, temperature, stream: false });
  const q = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-x402': 'true' }, body });
  if (q.status !== 402) throw new Error(`expected 402 quote, got ${q.status}`);
  const quote = await q.json();
  const opt = (quote.payment?.accepted || []).find(a => a.scheme === 'base-usdc' && a.network === 'base');
  if (!opt || !opt.completeUrl) throw new Error('no base-usdc option');
  const value = BigInt(opt.amount);
  if (value <= 0n || value > MAX_ATOMIC) throw new Error(`amount ${value} exceeds cap`);
  const hash = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [getAddress(opt.payTo), value] });
  await pub.waitForTransactionReceipt({ hash, timeout: 60000 });
  let r, txt;
  for (let i = 0; i < 30; i++) { // ~90s: 409 "already being processed" means wait, not fail
    r = await fetch(opt.completeUrl.startsWith('http') ? opt.completeUrl : 'https://api.nano-gpt.com' + opt.completeUrl, { method: 'POST' });
    txt = await r.text();
    if (r.ok) break;
    await new Promise(res => setTimeout(res, 3000));
  }
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), model, rail: 'base-usdc', status: r.status, usdc: Number(value) / 1e6, tx: hash }) + '\n');
  if (!r.ok) throw new Error(`complete failed ${r.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  return { text: j.choices?.[0]?.message?.content ?? '', usdc: Number(value) / 1e6, tx: hash };
}

export async function llmCall(messages, { model = 'deepseek-v4-flash', max_tokens = 1200, temperature = 0.3 } = {}) {
  const body = JSON.stringify({ model, messages, max_tokens, temperature, stream: false });
  const h = { 'content-type': 'application/json', 'x-x402': 'true' };
  const q = await fetch(URL, { method: 'POST', headers: h, body });
  if (q.status !== 402) throw new Error(`expected 402 quote, got ${q.status}: ${(await q.text()).slice(0, 200)}`);
  const quote = await q.json();
  const opt = (quote.accepts || []).find(a => a.scheme === 'exact' && a.network === 'base');
  if (!opt) throw new Error('no base/exact option');
  const value = BigInt(opt.maxAmountRequired);
  if (getAddress(opt.extra?.tokenAddress || USDC) !== getAddress(USDC) || opt.extra?.chainId !== 8453) throw new Error('unexpected token/chain');
  if (value <= 0n || value > MAX_ATOMIC) throw new Error(`amount ${value} exceeds cap`);
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: account.address, to: getAddress(opt.payTo), value: value.toString(),
    validAfter: String(now - 60), validBefore: String(now + 600), nonce: toHex(crypto.randomBytes(32)) };
  const signature = await wallet.signTypedData({
    domain: { name: opt.extra?.name || 'USD Coin', version: opt.extra?.version || '2', chainId: 8453, verifyingContract: USDC },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  const xpay = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature, authorization } })).toString('base64');
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'X-PAYMENT': xpay }, body }); // replay WITHOUT x-x402 (docs Flow 2)
  const txt = await r.text();
  let settle = null; const pr = r.headers.get('x-payment-response');
  if (pr) { try { settle = JSON.parse(Buffer.from(pr, 'base64').toString()); } catch {} }
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), model, status: r.status, usdc: Number(value) / 1e6, tx: settle?.transaction ?? null }) + '\n');
  if (!r.ok) throw new Error(`paid call failed ${r.status}: ${txt.slice(0, 300)}`);
  const j = JSON.parse(txt);
  return { text: j.choices?.[0]?.message?.content ?? '', usdc: Number(value) / 1e6, tx: settle?.transaction ?? null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [prompt, model] = process.argv.slice(2);
  const fn = process.env.RAIL === 'base-usdc' ? llmCallBaseUsdc : llmCall;
  const out = await fn([{ role: 'user', content: prompt }], { model: model || 'deepseek-v4-flash', max_tokens: 50 });
  console.log(JSON.stringify(out));
}
