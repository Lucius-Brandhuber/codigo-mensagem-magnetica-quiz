# GAS — Backend de Analytics (Código da Mensagem Magnética)

Backend em Google Apps Script que coleta os eventos do funil, recebe os postbacks
de venda da Payt, envia eventos para a Meta Conversions API (CAPI) e serve os
dados para o `admin.html`.

## Passo a passo para publicar

1. Acesse https://script.google.com → **Novo projeto**.
2. Cole o conteúdo de **`Codigo.gs`** no arquivo `Código.gs` (apague o exemplo).
3. Ative o manifesto: ⚙️ **Configurações do projeto** → marque
   **"Mostrar arquivo de manifesto appsscript.json"**. Abra `appsscript.json` e
   cole o conteúdo de **`appsscript.json`** deste repositório.
4. (Opcional, mas recomendado) Cole o **token da Conversions API** na variável
   `CAPI_TOKEN` no topo do `Codigo.gs`.
   - Gere em: Gerenciador de Eventos → seu Pixel → **Configurações** →
     **Conversions API** → **Gerar token de acesso**.
   - Sem o token, os eventos são salvos normalmente; só o envio server-side (CAPI)
     fica desativado (o log mostra "CAPI_TOKEN não configurado").
5. No editor, rode a função **`autorizar()`** uma vez e aceite as permissões
   (Planilhas, Drive e Solicitações externas). Isso cria a planilha
   *"Código da Mensagem Magnética — Analytics DB"* no seu Drive.
6. **Implantar → Nova implantação → Tipo: App da Web**
   - *Executar como:* **Eu**
   - *Quem tem acesso:* **Qualquer pessoa**
   - Copie a **URL do app da Web** (termina em `/exec`).
7. Me mande essa URL `/exec` — eu coloco na constante `GAS` do `admin.html`
   e instalo o tracking nas 5 páginas do funil.
8. (Opcional) Rode **`testeRapido()`** para gravar 1 evento + 1 venda de teste e
   conferir no `admin.html`. Depois é só usar **Resetar dados** no painel.

## Configuração da Payt (postback de vendas → evento Purchase)

No painel da Payt, em **Integrações / Postback / Webhook**, aponte para:

```
SUA_URL_DO_GAS/exec?src=payt
```

A Payt envia o status da venda; o GAS grava na aba `vendas` e, quando o status é
aprovado (`finaliz|aprovad|paid|pago|approved|confirmed`), dispara o evento
**Purchase** na Meta CAPI automaticamente.

## Abas da planilha (criadas sozinhas)

| Aba | Colunas |
|-----|---------|
| `eventos`  | data, evento, session, step, nome, genero, resposta, ms, referrer, ua, event_id, fbp, fbc, url, logo_ab |
| `vendas`   | data, status, metodo, valor, nome, email, telefone, order_id, raw |
| `capi_log` | data, evento, event_id, s, status_code, response |

## Mapeamento de eventos → Meta CAPI

| Evento do funil | Evento Meta |
|---|---|
| `view` step 0 | PageView |
| `answer` step 1 | Lead |
| `view` step `vendas` | ViewContent |
| `checkout_click` | InitiateCheckout |
| venda aprovada (Payt) | Purchase (com valor + e-mail/telefone com hash) |

## Observações importantes

- O projeto é **standalone**: ele cria e abre a própria planilha via
  `PropertiesService` (guarda o `SHEET_ID`). Não precisa vincular a nenhuma planilha.
- Ao **trocar o Pixel**, atualize `PIXEL_ID` **e gere um novo `CAPI_TOKEN`**
  (o token é amarrado ao pixel).
- **Não apague a variável `SITE_URL`** — ela é usada no `event_source_url` do CAPI.
- Sempre que mudar os escopos do manifesto, rode `autorizar()` de novo e
  publique uma **Nova versão** da implantação.
