# Desenvolvimento da extensão

Extensão MV3 sem build e sem dependências: `background.js`, `config.js` e `manifest.json`.
Ela lê o histórico de trades da Steam **no navegador** e envia ao CsTraders só as trades
recebidas. O token da sessão Steam nunca sai do navegador (mesmo modelo da extensão do
CSFloat).

## Como funciona

1. O site (logado) chama `POST /api/steam/extension/link-token` e recebe um `linkToken`,
   um JWT da organização com `scope: "extension"`. Ele só vale nas rotas da extensão.
2. O site manda `{ type: "LINK", linkToken, expectedSteamId? }` via
   `chrome.runtime.sendMessage(EXT_ID, ...)` (`externally_connectable`).
3. A extensão lê `data-loyalty_webapi_token` em `steamcommunity.com`. O SteamID sai do
   `sub` desse JWT. O token fica em cache local por 50 min.
4. `GET /api/steam/extension/cursor?steamId=` devolve `latestTradeTime`, a trade mais
   recente já guardada daquela conta (`null` na primeira vez).
5. A extensão pagina `IEconService/GetTradeHistory` do mais novo para trás até passar do
   cursor (no máximo 10 páginas na primeira sincronização) e envia cada página com
   `POST /api/steam/extension/trades`. Vão só as trades com itens recebidos e só os campos
   que o backend usa.
6. Sem trade nova, envia uma página vazia. É ela que mantém a conta "Sincronizada" no
   CsTraders; 30 min sem envio = "Atrasada".
7. Um `chrome.alarms` repete o ciclo a cada 5 min, além do `onStartup`/`onInstalled` e de
   cada `LINK`.

Respostas tratadas:

| Situação | Motivo devolvido ao site |
| --- | --- |
| Steam deslogada (`g_steamID = false`) | `not-logged-in` |
| Token ausente com sessão ativa (HTML da Steam mudou) | `token-parse-failed` |
| Conta logada ≠ `expectedSteamId` | `wrong-account` + `loggedSteamId` |
| Steam 401/403 | relê a sessão e tenta uma vez; depois `steam-auth-failed` |
| Steam 429/5xx | `steam-api-failed` (o próximo alarme tenta de novo) |
| Backend 409 | `account-not-registered` + `steamId` |
| Backend 401 | descarta o `linkToken`, `unauthorized` |

Não existe mensagem `SYNC`: reusar o link token guardado poderia mandar as trades a outra
loja. O "Atualizar trades" do site é sempre um `LINK` novo.