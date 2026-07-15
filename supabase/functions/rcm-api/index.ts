// Código da Reconquista Magnética — Backend de Analytics (Edge Function)
// Substitui o Google Apps Script: ingestão de eventos do funil + leitura pro admin.html.
// Réplica adaptada do rx-api (Rasga Xana), apontando pras tabelas deste projeto.
//
// Rotas (mesmos shapes que o admin.html/track.js já esperam):
//   POST (body JSON)            → grava evento do funil em `eventos` (+ Meta CAPI com dedup, se RCM_META_CAPI_TOKEN)
//   POST {action:'reset', key}  → limpa `eventos` + `capi_log` e remove SÓ vendas de teste (order_id teste%). Exige chave admin.
//   GET  ?all=1[&since=ms]&key= → {eventos, vendas, capi_log} pro admin (chave TOFU: 1º login registra)
//   GET  ?sheet=vendas&key=     → uma tabela só (fallback do admin)
//   GET  ?ping=1                → health
//
// verify_jwt=false: o track.js posta com no-cors (sem JWT) e o checkout/postback é outra função (payt-postback).
// A leitura do admin é protegida por chave própria (TOFU). As vendas são gravadas pela função payt-postback;
// aqui a gente só LÊ a tabela `vendas`.
//
// Formato: as tabelas usam `criado_em` (timestamptz); o admin espera `data` (epoch ms) — a leitura injeta
// `data` derivado de `criado_em` em cada linha, então o norm()/normVenda()/normCapi() do admin funciona igual.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const SITE_URL = 'https://codigo-mensagem-magnetica-quiz.vercel.app';

// Meta Pixel do funil (mesmo id do fbq no HTML público). Só o token da CAPI é secreto (secret RCM_META_CAPI_TOKEN).
const PIXEL_ID = '28159617713645746';
const CAPI_URL = `https://graph.facebook.com/v21.0/${PIXEL_ID}/events`;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { /* form-encoded */ }
  try {
    const out: Record<string, unknown> = {};
    new URLSearchParams(text).forEach((v, k) => { out[k] = v; });
    return out;
  } catch { return {}; }
}

/* ---------- Meta CAPI (opcional; só roda se o secret existir) ---------- */
function mapCAPI(ev: string, step: string): string | null {
  if (ev === 'view' && step === 'diagnostico') return 'Lead';            // concluiu o quiz (igual ao pixel do navegador)
  if (ev === 'view' && (step === 'pv' || step === 'vendas' || step === 'vsl' || step === 'vsl2')) return 'ViewContent';
  if (ev === 'checkout_click') return 'InitiateCheckout';
  return null;
}
async function sendCAPI(row: { evento: string; step: string; session: string; ua: string; fbp: string; fbc: string; url: string; event_id: string }) {
  const token = Deno.env.get('RCM_META_CAPI_TOKEN');
  if (!token) return;   // CAPI desligada até setar o secret (só o pixel do navegador roda)
  const name = mapCAPI(row.evento, row.step);
  if (!name) return;
  const user: Record<string, unknown> = {};
  if (row.ua) user.client_user_agent = row.ua;
  if (row.fbp) user.fbp = row.fbp;
  if (row.fbc) user.fbc = row.fbc;
  if (row.session) user.external_id = await sha256hex(row.session);
  const payload = { data: [{
    event_name: name, event_time: Math.floor(Date.now() / 1000),
    action_source: 'website', event_source_url: row.url || SITE_URL,
    event_id: row.event_id,               // MESMO id do fbq do navegador → Meta deduplica
    user_data: user, custom_data: {},
  }] };
  try {
    const res = await fetch(CAPI_URL + '?access_token=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const txt = (await res.text()).slice(0, 400);
    await db.from('capi_log').insert({ evento: name, event_id: row.event_id, status_code: res.status, response: txt });
  } catch (e) {
    try { await db.from('capi_log').insert({ evento: name, event_id: row.event_id, status_code: 0, response: String(e).slice(0, 400) }); } catch (_x) { /* ignore */ }
  }
}

/* ---------- eventos (ingestão do track.js) ---------- */
async function saveEvent(b: Record<string, unknown>): Promise<Response> {
  const row = {
    evento: String((b.ev as string) || (b.evento as string) || '').toLowerCase(),
    session: String((b.s as string) || (b.session as string) || ''),
    step: b.step != null ? String(b.step) : '',
    nome: String((b.name as string) || (b.nome as string) || ''),
    genero: String((b.gender as string) || (b.genero as string) || ''),
    resposta: String((b.ans as string) || (b.resposta as string) || ''),
    ms: Number(b.ms) || null,
    referrer: String((b.ref as string) || (b.referrer as string) || ''),
    ua: String((b.ua as string) || ''),
    event_id: String((b.event_id as string) || (b.eventId as string) || crypto.randomUUID()),
    fbp: String((b.fbp as string) || ''),
    fbc: String((b.fbc as string) || ''),
    url: String((b.url as string) || ''),
    logo_ab: String((b.logo_ab as string) || ''),
    price_ab: String((b.price_ab as string) || ''),
  };
  const { error } = await db.from('eventos').insert(row);
  if (error) return json({ ok: false, error: error.message });
  // CAPI em segundo plano (não segura a resposta)
  try {
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && rt.waitUntil) rt.waitUntil(sendCAPI(row)); else await sendCAPI(row);
  } catch (_e) { /* não bloqueia */ }
  return json({ ok: true });
}

/* ---------- chave do admin (TOFU: 1º login registra) ---------- */
async function adminKeyOk(key: string | null): Promise<boolean> {
  if (!key || key.length < 32) return false;
  const h = await sha256hex('rcm-key|' + key);
  const { data } = await db.from('admin_settings').select('v').eq('k', 'admin_key_hash').maybeSingle();
  if (!data) { await db.from('admin_settings').insert({ k: 'admin_key_hash', v: h }); return true; }
  return data.v === h;
}

/* ---------- dados p/ admin (pagina de 1000 em 1000; injeta data=ms) ---------- */
function withData(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const r of rows) r.data = r.criado_em ? new Date(r.criado_em as string).getTime() : 0;
  return rows;
}
async function fetchAll(table: string, since: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const PAGE = 1000;
  for (let fromIdx = 0; ; fromIdx += PAGE) {
    let q = db.from(table).select('*').order('criado_em', { ascending: true }).range(fromIdx, fromIdx + PAGE - 1);
    if (since > 0) q = q.gte('criado_em', new Date(since).toISOString());
    const { data, error } = await q;
    if (error || !data) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return withData(out);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const p = url.searchParams;

  if (req.method === 'GET') {
    if (p.get('ping')) return json({ ok: true, backend: 'supabase', funil: 'reconquista', pixel: PIXEL_ID, capi: !!Deno.env.get('RCM_META_CAPI_TOKEN') });
    if (p.get('all') || p.get('sheet')) {
      if (!(await adminKeyOk(p.get('key')))) return json({ ok: false, error: 'unauthorized' }, 401);
      if (p.get('sheet')) {
        const t = p.get('sheet') === 'vendas' ? 'vendas' : p.get('sheet') === 'capi_log' ? 'capi_log' : 'eventos';
        return json(await fetchAll(t, 0));
      }
      const since = Number(p.get('since')) || 0;
      const [eventos, vendas, capi_log] = await Promise.all([
        fetchAll('eventos', since), fetchAll('vendas', since), fetchAll('capi_log', since),
      ]);
      if (since > 0) return json({ delta: true, since, eventos, vendas, capi_log });
      return json({ eventos, vendas, capi_log });
    }
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  if (req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (body.action === 'reset') {
        if (!(await adminKeyOk(String(body.key || '')))) return json({ ok: false, error: 'unauthorized' }, 401);
        // Segurança: NUNCA apaga vendas reais. Zera eventos/capi_log e remove só vendas de teste (order_id teste%).
        await db.from('eventos').delete().gte('id', 0);
        await db.from('capi_log').delete().gte('id', 0);
        const { data: del } = await db.from('vendas').delete().ilike('order_id', 'teste%').select('id');
        return json({ ok: true, reset: true, vendas_teste_removidas: (del || []).length });
      }
      return await saveEvent(body);
    } catch (err) {
      return json({ ok: false, error: String(err) });
    }
  }
  return json({ ok: false, error: 'method' }, 405);
});
