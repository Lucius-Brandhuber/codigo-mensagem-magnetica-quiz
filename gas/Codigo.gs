/***********************************************************************
 * CÓDIGO DA MENSAGEM MAGNÉTICA — Backend de Analytics (Google Apps Script)
 * Web App standalone que:
 *   - Recebe eventos do funil (view / answer / checkout_click) via doPost
 *   - Recebe postbacks de venda da Payt (?src=payt)
 *   - Envia eventos para a Meta Conversions API (CAPI) e registra o log
 *   - Serve os dados em JSON para o admin.html via doGet
 *
 * É STANDALONE (não vinculado a uma planilha): ele cria/abre a própria
 * planilha no seu Drive na 1ª execução e guarda o ID em PropertiesService.
 *
 * >>> DEPOIS DE COLAR: rode a função autorizar() uma vez (consentir escopos),
 *     depois Implantar > Nova implantação > App da Web
 *     ("Executar como: Eu", "Quem tem acesso: Qualquer pessoa").
 ***********************************************************************/

/* ====================== CONFIG ====================== */
var PIXEL_ID   = '1015700578061069';
// Gere em: Gerenciador de Eventos > Configurações > Conversions API > Gerar token de acesso
var CAPI_TOKEN = 'COLE_AQUI_O_TOKEN_DA_CONVERSIONS_API';
var CAPI_URL   = 'https://graph.facebook.com/v19.0/' + PIXEL_ID + '/events';
// URL do site (usada em event_source_url do CAPI). NÃO apague esta linha.
var SITE_URL   = 'https://codigo-mensagem-magnetica-quiz.vercel.app';

var DB_NAME = 'Código da Mensagem Magnética — Analytics DB';

var EVENTOS_HEADERS = ['data','evento','session','step','nome','genero','resposta','ms','referrer','ua','event_id','fbp','fbc','url','logo_ab','price_ab'];
var VENDAS_HEADERS  = ['data','status','metodo','valor','nome','email','telefone','order_id','raw','ab'];
var CAPILOG_HEADERS = ['data','evento','event_id','s','status_code','response'];

/* ====================== PLANILHA (auto-cria) ====================== */
function getSS(){
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id){
    try { return SpreadsheetApp.openById(id); } catch(e){ /* recria abaixo */ }
  }
  var ss = SpreadsheetApp.create(DB_NAME);
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}
function ensureSheet(ss, name, headers){
  var sh = ss.getSheetByName(name);
  if (!sh){ sh = ss.insertSheet(name); }
  if (sh.getLastRow() === 0){
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < headers.length){
    // migração: acrescenta as colunas novas (ex.: price_ab / ab) ao cabeçalho
    sh.getRange(1,1,1,headers.length).setValues([headers]);
  }
  return sh;
}
function db(){
  var ss = getSS();
  return {
    ss: ss,
    eventos: ensureSheet(ss,'eventos',EVENTOS_HEADERS),
    vendas:  ensureSheet(ss,'vendas', VENDAS_HEADERS),
    capi:    ensureSheet(ss,'capi_log',CAPILOG_HEADERS)
  };
}

/* ====================== doGet (leitura — admin.html) ====================== */
function doGet(e){
  var p = (e && e.parameter) || {};
  if (p.ping) return json({ ok:true, pixel:PIXEL_ID });

  // Modo combinado: 1 requisição traz as 3 abas de uma vez (usado pelo admin).
  // Evita 3 invocações do Apps Script (que enfileiram e somam ~3-4s cada).
  if (p.all){
    var cache = CacheService.getScriptCache();
    if (!p.fresh){
      var hit = cacheGet(cache);
      if (hit) return jsonRaw(hit);
    }
    var d = db();
    var payload = JSON.stringify({
      eventos:  rowsAsObjects(d.eventos),
      vendas:   rowsAsObjects(d.vendas),
      capi_log: rowsAsObjects(d.capi)
    });
    cachePut(cache, payload);          // grava em pedaços (CacheService limita 100KB/valor)
    return jsonRaw(payload);
  }

  // Compatibilidade: leitura de uma aba só.
  var d2 = db();
  var which = (p.sheet || 'eventos');
  var sh = which === 'vendas' ? d2.vendas : which === 'capi_log' ? d2.capi : d2.eventos;
  return json(rowsAsObjects(sh));
}
var CACHE_KEY = 'admin_all_v1';
var CACHE_TTL = 25;          // segundos
var CACHE_CHUNK = 45000;     // chars por pedaço (~90KB UTF-8, abaixo do limite de 100KB)
function cachePut(cache, str){
  try {
    var n = Math.ceil(str.length / CACHE_CHUNK) || 1;
    var obj = {}; obj[CACHE_KEY] = String(n);
    for (var i=0;i<n;i++){ obj[CACHE_KEY+'_'+i] = str.substr(i*CACHE_CHUNK, CACHE_CHUNK); }
    cache.putAll(obj, CACHE_TTL);
  } catch(x){}
}
function cacheGet(cache){
  try {
    var meta = cache.get(CACHE_KEY); var n = parseInt(meta,10);
    if (!(n>0)) return null;
    var keys = []; for (var i=0;i<n;i++) keys.push(CACHE_KEY+'_'+i);
    var parts = cache.getAll(keys); var s = '';
    for (var j=0;j<n;j++){ var c = parts[CACHE_KEY+'_'+j]; if (c==null) return null; s += c; }
    return s;
  } catch(x){ return null; }
}
function invalidateCache(){ try { CacheService.getScriptCache().remove(CACHE_KEY); } catch(x){} }
function rowsAsObjects(sh){
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  var head = vals[0];
  var out = [];
  for (var i=1;i<vals.length;i++){
    var o = {}; var empty = true;
    for (var c=0;c<head.length;c++){
      var v = vals[i][c];
      if (v instanceof Date) v = v.getTime();
      o[head[c]] = v;
      if (v !== '' && v != null) empty = false;
    }
    if (!empty) out.push(o);
  }
  return out;
}

/* ====================== doPost (gravação + CAPI) ====================== */
function doPost(e){
  try{
    var p = (e && e.parameter) || {};
    var body = parseBody(e);

    // Postback de venda da Payt
    if (p.src === 'payt' || p.sheet === 'vendas' || body.__payt){
      if (p.produto) body.__produto = p.produto;
      if (p.ab) body.__ab = p.ab;
      return saveVenda(body);
    }
    // Reset (apaga eventos/vendas/capi)
    if (body.action === 'reset'){
      resetAll();
      return json({ ok:true, reset:true });
    }
    // Evento normal do funil
    var saved = saveEvent(body);
    try { sendCAPIForEvent(saved); } catch(err){ /* não bloqueia a gravação */ }
    return json({ ok:true });
  }catch(err){
    return json({ ok:false, error:String(err) });
  }
}
function parseBody(e){
  if (e && e.postData && e.postData.contents){
    try { return JSON.parse(e.postData.contents); } catch(x){}
  }
  return (e && e.parameter) || {};
}

/* ---- gravar evento ---- */
function saveEvent(b){
  var d = db();
  var row = {
    data:     Date.now(),
    evento:   String(b.ev || b.evento || '').toLowerCase(),
    session:  b.s || b.session || '',
    step:     (b.step != null ? b.step : ''),
    nome:     b.name || b.nome || '',
    genero:   b.gender || b.genero || '',
    resposta: b.ans || b.resposta || '',
    ms:       Number(b.ms) || '',
    referrer: b.ref || b.referrer || '',
    ua:       b.ua || '',
    event_id: b.event_id || b.eventId || newId(),
    fbp:      b.fbp || '',
    fbc:      b.fbc || '',
    url:      b.url || '',
    logo_ab:  b.logo_ab || b.ab || '',
    price_ab: b.price_ab || ''
  };
  d.eventos.appendRow(EVENTOS_HEADERS.map(function(k){ return row[k]; }));
  invalidateCache();
  return row;
}

/* ---- gravar venda (Payt) ---- */
function saveVenda(b){
  var d = db();
  var status = b.status || b.status_transaction || b.transaction_status || (b.transaction && b.transaction.status) || '';
  var metodo = b.payment_method || b.metodo || b.method || (b.transaction && b.transaction.payment_method) || '';
  var valor  = b.value != null ? b.value : (b.amount != null ? b.amount : (b.total != null ? b.total : (b.transaction && b.transaction.amount)));
  var cust   = b.customer || b.cliente || {};
  var row = {
    data:     Date.now(),
    status:   String(status),
    metodo:   String(metodo),
    valor:    toNumber(valor),
    nome:     b.name || b.nome || cust.name || cust.nome || '',
    email:    b.email || cust.email || '',
    telefone: b.phone || b.telefone || cust.phone || cust.phone_number || '',
    order_id: b.order_id || b.orderId || b.id || b.transaction_id || (b.transaction && b.transaction.id) || '',
    raw:      JSON.stringify(b).slice(0, 4000),
    ab:       b.ab || b.__ab || ''
  };
  d.vendas.appendRow(VENDAS_HEADERS.map(function(k){ return row[k]; }));
  invalidateCache();

  // venda aprovada → e-mail de acesso + Purchase no CAPI
  if (/finaliz|aprovad|paid|pago|approved|confirmed/i.test(row.status)){
    var produto = b.__produto || '';
    if (produto === 'biblioteca'){
      try { sendBibliotecaEmail(row); } catch(err){}
    } else if (produto === 'reconstrucao'){
      try { sendReconstrucaoEmail(row); } catch(err){}
    } else {
      try { sendAccessEmail(row); } catch(err){}
    }
    try { sendPurchaseCAPI(row); } catch(err){}
  }
  return json({ ok:true, venda:true });
}

/* ---- reset ---- */
function resetAll(){
  var d = db();
  [['eventos',EVENTOS_HEADERS],['vendas',VENDAS_HEADERS],['capi_log',CAPILOG_HEADERS]].forEach(function(p){
    var sh = d.ss.getSheetByName(p[0]);
    if (sh){ sh.clear(); sh.getRange(1,1,1,p[1].length).setValues([p[1]]); sh.setFrozenRows(1); }
  });
  invalidateCache();
}

/* ====================== META CAPI ====================== */
// Mapeia evento do funil -> evento padrão da Meta (ou null = não envia)
function mapCAPI(ev, step){
  ev = String(ev||'').toLowerCase();
  if (ev === 'view' && String(step) === '0')       return 'PageView';
  if (ev === 'answer' && String(step) === '1')      return 'Lead';
  if (ev === 'view' && String(step) === 'vendas')   return 'ViewContent';
  if (ev === 'checkout_click')                       return 'InitiateCheckout';
  return null;
}
function sendCAPIForEvent(row){
  var name = mapCAPI(row.evento, row.step);
  if (!name) return;
  var user = {
    client_user_agent: row.ua || undefined,
    fbp: row.fbp || undefined,
    fbc: row.fbc || undefined,
    external_id: row.session ? sha256(row.session) : undefined
  };
  postCAPI(name, user, {}, row.event_id, row.url || SITE_URL);
}
function sendPurchaseCAPI(venda){
  var user = {};
  if (venda.email)    user.em = sha256(String(venda.email).trim().toLowerCase());
  if (venda.telefone) user.ph = sha256(String(venda.telefone).replace(/\D/g,''));
  var custom = { currency:'BRL', value: toNumber(venda.valor) || 0 };
  postCAPI('Purchase', user, custom, 'purchase_' + (venda.order_id || Date.now()), SITE_URL);
}
function postCAPI(eventName, userData, customData, eventId, sourceUrl){
  if (!CAPI_TOKEN || /COLE_AQUI/.test(CAPI_TOKEN)) {
    logCAPI(eventName, eventId, 0, 'CAPI_TOKEN não configurado');
    return;
  }
  var clean = {};
  Object.keys(userData||{}).forEach(function(k){ if (userData[k]!=null) clean[k]=userData[k]; });
  var payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now()/1000),
      action_source: 'website',
      event_source_url: sourceUrl || SITE_URL,
      event_id: eventId || newId(),
      user_data: clean,
      custom_data: customData || {}
    }]
  };
  try{
    var res = UrlFetchApp.fetch(CAPI_URL + '?access_token=' + encodeURIComponent(CAPI_TOKEN), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    logCAPI(eventName, payload.data[0].event_id, res.getResponseCode(), res.getContentText().slice(0,500));
  }catch(err){
    logCAPI(eventName, eventId, 0, String(err).slice(0,500));
  }
}
function logCAPI(ev, eventId, code, resp){
  try{
    var d = db();
    d.capi.appendRow([ Date.now(), ev, eventId||'', '', code||0, resp||'' ]);
  }catch(e){}
}

/* ====================== EMAIL DE ACESSO ====================== */
var MEMBROS_URL = 'https://area-membros-reconquista.vercel.app';

function sendAccessEmail(venda){
  var email = venda.email;
  if (!email) return;
  var nome = venda.nome || 'aluna';
  var primeiro = nome.split(' ')[0];

  var subject = '🔑 Seu acesso ao Código da Reconquista Magnética';
  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f1f4;font-family:Arial,sans-serif">'
    + '<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">'
    + '<div style="background:linear-gradient(135deg,#ec3a8b,#a855f7);padding:36px 28px;text-align:center;color:#fff">'
    + '<div style="font-size:42px;margin-bottom:8px">💗</div>'
    + '<h1 style="margin:0;font-size:22px">Parabéns, ' + primeiro + '!</h1>'
    + '<p style="margin:8px 0 0;font-size:14px;opacity:.9">Sua compra foi confirmada</p>'
    + '</div>'
    + '<div style="padding:28px">'
    + '<p style="font-size:15px;color:#333;line-height:1.6">Seu acesso ao <strong>Código da Reconquista Magnética</strong> já está liberado. Clique no botão abaixo para entrar na sua área de membros:</p>'
    + '<div style="text-align:center;margin:24px 0">'
    + '<a href="' + MEMBROS_URL + '" style="display:inline-block;background:linear-gradient(135deg,#ec3a8b,#d6246e);color:#fff;text-decoration:none;padding:14px 36px;border-radius:12px;font-size:16px;font-weight:700">Acessar Minha Área →</a>'
    + '</div>'
    + '<p style="font-size:13px;color:#888;line-height:1.5">Use o e-mail <strong>' + email + '</strong> para criar sua conta na área de membros.</p>'
    + '<hr style="border:none;border-top:1px solid #eee;margin:20px 0">'
    + '<p style="font-size:12px;color:#aaa;text-align:center">Código da Reconquista Magnética<br>Qualquer dúvida, responda este e-mail.</p>'
    + '</div></div></body></html>';

  MailApp.sendEmail(email, subject, 'Seu acesso: ' + MEMBROS_URL, { htmlBody: html, name: 'Código da Reconquista Magnética' });
}

function sendBibliotecaEmail(venda){
  var email = venda.email;
  if (!email) return;
  var nome = venda.nome || 'aluna';
  var primeiro = nome.split(' ')[0];
  var chave = sha256('biblio|' + email.toLowerCase());
  var link = MEMBROS_URL + '?unlock=biblioteca&email=' + encodeURIComponent(email) + '&key=' + chave;

  var subject = '📚 Sua Biblioteca das Respostas está liberada!';
  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f1f4;font-family:Arial,sans-serif">'
    + '<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">'
    + '<div style="background:linear-gradient(135deg,#a855f7,#ec3a8b);padding:36px 28px;text-align:center;color:#fff">'
    + '<div style="font-size:42px;margin-bottom:8px">📚</div>'
    + '<h1 style="margin:0;font-size:22px">Parabéns, ' + primeiro + '!</h1>'
    + '<p style="margin:8px 0 0;font-size:14px;opacity:.9">Sua Biblioteca das Respostas foi liberada</p>'
    + '</div>'
    + '<div style="padding:28px">'
    + '<p style="font-size:15px;color:#333;line-height:1.6">Clique no botão abaixo para desbloquear a <strong>Biblioteca das Respostas</strong> na sua área de membros:</p>'
    + '<div style="text-align:center;margin:24px 0">'
    + '<a href="' + link + '" style="display:inline-block;background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff;text-decoration:none;padding:14px 36px;border-radius:12px;font-size:16px;font-weight:700">Desbloquear Biblioteca →</a>'
    + '</div>'
    + '<p style="font-size:13px;color:#888;line-height:1.5">Use o mesmo e-mail <strong>' + email + '</strong> da sua conta na área de membros.</p>'
    + '<hr style="border:none;border-top:1px solid #eee;margin:20px 0">'
    + '<p style="font-size:12px;color:#aaa;text-align:center">Código da Reconquista Magnética<br>Qualquer dúvida, responda este e-mail.</p>'
    + '</div></div></body></html>';

  MailApp.sendEmail(email, subject, 'Desbloquear: ' + link, { htmlBody: html, name: 'Código da Reconquista Magnética' });
}

function sendReconstrucaoEmail(venda){
  var email = venda.email;
  if (!email) return;
  var nome = venda.nome || 'aluna';
  var primeiro = nome.split(' ')[0];
  var chave = sha256('reconstrucao|' + email.toLowerCase());
  var link = MEMBROS_URL + '?unlock=reconstrucao&email=' + encodeURIComponent(email) + '&key=' + chave;

  var subject = '❤️‍🩹 Sua Reconstrução da Confiança está liberada!';
  var html = '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f1f4;font-family:Arial,sans-serif">'
    + '<div style="max-width:520px;margin:30px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">'
    + '<div style="background:linear-gradient(135deg,#f97316,#ec3a8b);padding:36px 28px;text-align:center;color:#fff">'
    + '<div style="font-size:42px;margin-bottom:8px">❤️‍🩹</div>'
    + '<h1 style="margin:0;font-size:22px">Parabéns, ' + primeiro + '!</h1>'
    + '<p style="margin:8px 0 0;font-size:14px;opacity:.9">Sua Reconstrução da Confiança foi liberada</p>'
    + '</div>'
    + '<div style="padding:28px">'
    + '<p style="font-size:15px;color:#333;line-height:1.6">Clique no botão abaixo para desbloquear a <strong>Reconstrução da Confiança</strong> na sua área de membros:</p>'
    + '<div style="text-align:center;margin:24px 0">'
    + '<a href="' + link + '" style="display:inline-block;background:linear-gradient(135deg,#f97316,#ec3a8b);color:#fff;text-decoration:none;padding:14px 36px;border-radius:12px;font-size:16px;font-weight:700">Desbloquear agora →</a>'
    + '</div>'
    + '<p style="font-size:13px;color:#888;line-height:1.5">Use o mesmo e-mail <strong>' + email + '</strong> da sua conta na área de membros.</p>'
    + '<hr style="border:none;border-top:1px solid #eee;margin:20px 0">'
    + '<p style="font-size:12px;color:#aaa;text-align:center">Código da Reconquista Magnética<br>Qualquer dúvida, responda este e-mail.</p>'
    + '</div></div></body></html>';

  MailApp.sendEmail(email, subject, 'Desbloquear: ' + link, { htmlBody: html, name: 'Código da Reconquista Magnética' });
}

/* ====================== HELPERS ====================== */
function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function jsonRaw(str){
  return ContentService.createTextOutput(str)
    .setMimeType(ContentService.MimeType.JSON);
}
function newId(){ return Utilities.getUuid(); }
function toNumber(v){
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  var s = String(v).replace(/[^\d.,-]/g,'');
  if (s.indexOf(',') > -1) s = s.replace(/\./g,'').replace(',','.'); // formato BR
  return Number(s) || 0;
}
function sha256(s){
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function(b){ return ('0'+(b & 0xFF).toString(16)).slice(-2); }).join('');
}

/* ====================== SETUP / TESTE ====================== */
// Rode UMA VEZ no editor para consentir os escopos (planilha + rede externa).
function autorizar(){
  db(); // cria a planilha e pede acesso ao Drive/Sheets
  UrlFetchApp.fetch('https://graph.facebook.com/', { muteHttpExceptions:true }); // pede script.external_request
  MailApp.getRemainingDailyQuota(); // pede escopo de envio de email
  Logger.log('OK — planilha: ' + getSS().getUrl());
}
// Gera 1 evento e 1 venda de teste para validar o fluxo.
function testeRapido(){
  saveEvent({ ev:'view', s:'TESTE_'+Date.now(), step:'0', ua:'teste', url:SITE_URL });
  saveVenda({ status:'aprovada', payment_method:'pix', value:27.90, name:'Teste', email:'luciusbrandhuber2@gmail.com', order_id:'T1', __payt:true });
  Logger.log('Eventos/vendas de teste gravados. Planilha: ' + getSS().getUrl());
}
// Simula uma compra da BIBLIOTECA (dispara o e-mail de desbloqueio). Troque o e-mail.
function testeBiblioteca(){
  saveVenda({ status:'aprovada', payment_method:'pix', value:14.90, name:'Teste', email:'luciusbrandhuber2@gmail.com', order_id:'TB1', __payt:true, __produto:'biblioteca' });
  Logger.log('Venda de teste da Biblioteca gravada — confira o e-mail.');
}
// Simula uma compra da RECONSTRUÇÃO DA CONFIANÇA (dispara o e-mail de desbloqueio). Troque o e-mail.
function testeReconstrucao(){
  saveVenda({ status:'aprovada', payment_method:'pix', value:0, name:'Teste', email:'luciusbrandhuber2@gmail.com', order_id:'TR1', __payt:true, __produto:'reconstrucao' });
  Logger.log('Venda de teste da Reconstrução gravada — confira o e-mail.');
}
