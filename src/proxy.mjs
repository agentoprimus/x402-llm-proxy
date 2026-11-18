// Local OpenAI-compatible proxy -> NanoGPT x402 pay-per-call (Base USDC). Listens on 127.0.0.1:8787 only.
// Hard daily cap (UTC day) on USDC spent; refuses with 429 when reached. Every call logged by llmCall().
import http from 'http';
import fs from 'fs';
import { llmCall, llmCallBaseUsdc } from './x402-call.mjs';
const DATA = process.env.X402_STATE_DIR || '.';
// base-usdc rail sends an on-chain tx per call: serialize to avoid nonce collisions
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
const PORT = Number(process.env.PORT || 8787), DAILY_CAP_USDC = Number(process.env.X402_DAILY_CAP || '0.25');
const STATE = DATA + '/x402-daily.json';
const ALLOWED = new Set(['deepseek-v4-flash', 'deepseek-v3.2', 'qwen3-235b-instruct', 'llama-3.3-70b', 'gpt-oss-120b']);
fs.writeFileSync(DATA + '/x402-proxy.pid', String(process.pid));
// In-memory counter (single process; requests are concurrent, so no file read-modify-write races).
// On start / day change it is rebuilt from the append-only spend log, which is the source of truth.
const LOG = DATA + '/x402-spend.jsonl';
let st = null;
function rebuild(day) {
  let usdc = 0, calls = 0;
  try { for (const l of fs.readFileSync(LOG, 'utf8').split('\n')) { if (!l) continue; const j = JSON.parse(l);
    if (j.at.slice(0, 10) === day && j.status === 200) { usdc += j.usdc; calls += 1; } } } catch {}
  return { day, usdc, calls, reserved: 0 };
}
function spentToday() {
  const d = new Date().toISOString().slice(0, 10);
  if (!st || st.day !== d) st = rebuild(d);
  return st;
}
http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return send(404, { error: 'only POST /v1/chat/completions' });
  let raw = ''; for await (const ch of req) raw += ch;
  let b; try { b = JSON.parse(raw); } catch { return send(400, { error: 'bad json' }); }
  const model = String(b.model || 'deepseek-v4-flash').replace(/^openai\//, '');
  if (!ALLOWED.has(model)) return send(400, { error: `model not allowed: ${model}` });
  const st = spentToday();
  if (st.usdc + st.reserved + 0.01 > DAILY_CAP_USDC) return send(429, { error: { message: `daily x402 cap reached (${st.usdc.toFixed(3)}/${DAILY_CAP_USDC} USDC)` } });
  const DOWN = DATA + '/x402-down';
  let skipPaid = false;
  try { skipPaid = Date.now() - fs.statSync(DOWN).mtimeMs < 30 * 60 * 1000; } catch {}
  if (skipPaid) return rail2(new Error('x402 marked down (<30 min ago)'));
  st.reserved += 0.01; // reserve the max per-call price before paying, so concurrent calls can't overshoot
  try {
    const out = await llmCall(b.messages, { model, max_tokens: Math.min(b.max_tokens || 1500, 3000), temperature: b.temperature ?? 0.3 });
    st.reserved -= 0.01; st.usdc += out.usdc; st.calls += 1; fs.writeFileSync(STATE, JSON.stringify(st));
    try { fs.unlinkSync(DOWN); } catch {}
    send(200, { id: 'x402-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  } catch (e) {
    st.reserved = Math.max(0, st.reserved - 0.01);
    fs.writeFileSync(DOWN, String(e.message || e).slice(0, 300));
    return rail2(e);
  }
  async function rail2(e) {
    // NanoGPT base-usdc quote-and-complete (on-chain transfer, we pay gas). Same daily USDC cap.
    if (st.usdc + st.reserved + 0.01 > DAILY_CAP_USDC) return send(429, { error: { message: 'daily cap reached' } });
    st.reserved += 0.01;
    try {
      const out = await serial(() => llmCallBaseUsdc(b.messages, { model, max_tokens: Math.min(b.max_tokens || 1500, 3000), temperature: b.temperature ?? 0.3 }));
      st.reserved -= 0.01; st.usdc += out.usdc; st.calls += 1;
      try { fs.unlinkSync(DATA + '/paid-down'); } catch {}
      return send(200, { id: 'x402b-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    } catch (e2) {
      st.reserved = Math.max(0, st.reserved - 0.01);
      fs.writeFileSync(DATA + '/paid-down', String(e2.message).slice(0, 200));
      fs.appendFileSync(DATA + '/x402-proxy.log', `${new Date().toISOString()} rail2 failed (${String(e2.message).slice(0, 120)})\n`);
      return fallback(e2);
    }
  }
  async function fallback(e) {
    // Fallback: OpenRouter free model (50/day account limit) so the bot keeps working if x402 settlement is down.
    try {
      if (!process.env.OPENROUTER_KEY_FILE) return send(502, { error: { message: 'paid rails failed and no fallback configured: ' + String(e.message || e).slice(0, 200) } });
      const key = fs.readFileSync(process.env.OPENROUTER_KEY_FILE, 'utf8').trim();
      const fr = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: 'nvidia/nemotron-3-ultra-550b-a55b:free', messages: b.messages, max_tokens: Math.min(b.max_tokens || 1500, 3000), temperature: b.temperature ?? 0.3 }) });
      const fj = await fr.json();
      fs.appendFileSync(DATA + '/x402-proxy.log', `${new Date().toISOString()} x402 failed (${String(e.message).slice(0, 120)}), fallback openrouter ${fr.status}\n`);
      if (fr.ok) return send(200, fj);
      if (fr.status === 429 && JSON.stringify(fj).includes('free-models-per-day'))
        fs.writeFileSync(DATA + '/free-exhausted', new Date().toISOString().slice(0, 10));
      return send(502, { error: { message: 'x402 failed and fallback failed: ' + JSON.stringify(fj).slice(0, 200) } });
    } catch (e2) { send(502, { error: { message: String(e.message || e).slice(0, 300) } }); }
  }
}).listen(PORT, '127.0.0.1', () => console.log('x402 proxy on 127.0.0.1:' + PORT + ' cap ' + DAILY_CAP_USDC));
