# WaConnect – API WhatsApp (Baileys)

Painel web e API REST para gerenciar uma instância do WhatsApp usando **@whiskeysockets/baileys**. Inclui dashboard com QR Code, envio de mensagens, mídias, contatos e áudio narrado (TTS), além de documentação via Swagger.

## Requisitos
- Node.js 18+ e npm
- Conta/instância WhatsApp para pareamento via QR

## Variáveis de ambiente (`.env`)
| Chave        | Descrição                                           | Padrão          |
|--------------|-----------------------------------------------------|-----------------|
| `PORT`       | Porta do servidor HTTP                              | `3000`          |
| `SERVER_URL` | URL pública/base usada no Swagger                    | `http://localhost:3000` |
| `API_TOKEN`  | Token para proteger as rotas `/api/*` (header `x-api-token`) | **obrigatório** |
| `DASH_USER`  | Usuário do login do painel                           | `admin`         |
| `DASH_PASS`  | Senha do login do painel                             | `admin`         |

## Instalação
```bash
npm install
```

## Desenvolvimento
```bash
npm run dev       # ts-node-dev com hot reload
```

## Build e produção
```bash
npm run build
npm start         # executa dist/index.js
```

## Painel Web
- Servido em `/` com login (DASH_USER/DASH_PASS).
- Exibe QR Code para parear, status, logs e ações (gerar QR, desconectar, limpar cache).
- Tema dark neon alinhado ao login, com logo em `public/logo-login.png`.

## Autenticação da API
Enviar o header `x-api-token: <API_TOKEN>` em todas as rotas `/api/*`.

## Principais endpoints
- `GET /api/qr` — status/QR atual (data URL quando disponível).
- `POST /api/qr/new` — força novo QR (reinicia sessão).
- `POST /api/disconnect` — encerra sessão e limpa auth.
- `POST /api/clear-cache` — limpa cache/auth sem reiniciar.
- `GET /api/status` — status da instância.
- `POST /api/check-number` — verifica se número é WhatsApp.
- `POST /api/send/text` — envia texto `{ to, message }`.
- `POST /api/send/media` — envia mídia multipart form-data (`file`, `to`, `kind?`, `caption?`).
- `POST /api/send/contact` — envia vCard `{ to, name, phone }`.
- `POST /api/send/narration` — gera TTS (Google TTS) e envia áudio `{ to, text, lang?, slow? }`.

## Curl rápido (texto)
```bash
curl -X POST http://localhost:3000/api/send/text \
  -H "Content-Type: application/json" \
  -H "x-api-token: $API_TOKEN" \
  -d '{ "to":"5599999999999", "message":"Olá do WaConnect!" }'
```

## Documentação Swagger
- Acesse `/api-docs` (UI) ou `/api-docs.json` (JSON).

## Estrutura
- `src/` — código TypeScript (Express, Baileys, serviços).
- `public/` — frontend (HTML/CSS/JS) + assets.
- `dist/` — build gerado pelo TypeScript.
- `auth/` — credenciais/sessão Baileys (criado em tempo de execução).

## Notas sobre TTS
- Usa `google-tts-api`; requer acesso externo à Google Translate. Se receber 403/500, tente novamente ou verifique conectividade.

## Licença
ISC (padrão do projeto). Ajuste conforme necessário.
