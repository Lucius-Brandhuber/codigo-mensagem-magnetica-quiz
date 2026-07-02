/* Tracking do funil — Código da Mensagem Magnética
   Gera session id, dispara view/answer/checkout_click para o GAS e mantém
   backup local. Usa fetch no-cors + text/plain (evita preflight CORS no GAS). */
(function(){
  var GAS = 'https://script.google.com/macros/s/AKfycbwtTZCubt04EaR0WJxD8RvVnlUtYnwLkiN2k2cPhyqsu4FzyJusEa86CsVJdyG3geEQ6Q/exec';

  function uid(){ return 'xxxxxxxx'.replace(/x/g,function(){return (Math.random()*16|0).toString(16);})+Date.now().toString(36); }
  function sid(){ var k='cmm_sid'; var v=localStorage.getItem(k); if(!v){ v=uid(); localStorage.setItem(k,v); } return v; }
  /* Teste A/B de PREÇO: A = preço atual, B = R$34,90. Sorteia uma vez por
     visitante (50/50) e mantém fixo em localStorage. */
  function priceAb(){ var k='cmm_price_ab'; var v=localStorage.getItem(k); if(v!=='A'&&v!=='B'){ v=(Math.random()<0.5?'A':'B'); try{localStorage.setItem(k,v);}catch(x){} } return v; }
  function cookie(n){ var m=document.cookie.match('(^|;)\\s*'+n+'\\s*=\\s*([^;]+)'); return m?m.pop():''; }
  function backup(e){ try{ var a=JSON.parse(localStorage.getItem('cmm_ev')||'[]'); a.push(e); if(a.length>500)a=a.slice(-500); localStorage.setItem('cmm_ev',JSON.stringify(a)); }catch(x){} }
  function seen(key){ var k='cmm_seen_'+sid()+'_'+key; if(localStorage.getItem(k))return true; try{localStorage.setItem(k,'1');}catch(x){} return false; }

  function send(ev, p){
    p = p||{};
    var e = {
      ev: ev, s: sid(),
      step: (p.step!=null ? p.step : ''),
      name: p.name||'', gender: p.gender||'', ans: p.ans||'', ms: p.ms||0,
      ref: document.referrer||'', ua: navigator.userAgent, url: location.href,
      event_id: uid(), fbp: cookie('_fbp'), fbc: cookie('_fbc'),
      price_ab: priceAb()
    };
    backup(e);
    try{ fetch(GAS, { method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain;charset=UTF-8'}, body: JSON.stringify(e) }); }catch(x){}
  }

  window.cmmTrack = {
    view:     function(step){ if(seen('v'+step)) return; send('view', {step:step}); },
    answer:   function(step,text){ send('answer', {step:step, ans:text}); },
    click:    function(step,label){ send('click', {step:step, name:label||'Botão'}); },
    checkout: function(label){ send('checkout_click', {name:label||'CTA'}); },
    getAb:    function(){ return priceAb(); }   // variante de preço do visitante (A|B)
  };
})();
