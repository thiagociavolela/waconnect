import cors from "cors";
import express, { Request, Response } from "express";
import dotenv from "dotenv";
import multer from "multer";
import QRCode from "qrcode";
import path from "path";
import swaggerUi from "swagger-ui-express";
import swaggerJSDoc, { Options as SwaggerOptions } from "swagger-jsdoc";
import { MediaKind, WhatsAppService } from "./whatsapp";

dotenv.config();

type CachedResponse = { status: number; body: unknown; expiresAt: number };

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
const DASH_USER = process.env.DASH_USER ?? "admin";
const DASH_PASS = process.env.DASH_PASS ?? "admin123";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB cap for media
});

const API_TOKEN = process.env.API_TOKEN ?? "";
const IDEM_TTL_MS = 5 * 60 * 1000;
const idempotencyCache = new Map<string, CachedResponse>();
const rateWindowMs = 1000;
const rateMax = 3;
let rateTimestamps: number[] = [];

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const whatsapp = new WhatsAppService();

const swaggerOptions: SwaggerOptions = {
  definition: {
    openapi: "3.0.1",
    info: {
      title: "API WPP",
      version: "1.0.0",
      description: "Endpoints para controle da instância WhatsApp via Baileys."
    },
    servers: [{ url: SERVER_URL }],
    components: {
      securitySchemes: {
        ApiToken: {
          type: "apiKey",
          in: "header",
          name: "x-api-token",
          description: "Token definido na variável de ambiente API_TOKEN"
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer"
        }
      },
      schemas: {
        SendTextRequest: {
          type: "object",
          required: ["to", "message"],
          properties: {
            to: { type: "string", example: "5599999999999" },
            message: { type: "string", example: "Olá!" }
          }
        },
        SendContactRequest: {
          type: "object",
          required: ["to", "name", "phone"],
          properties: {
            to: { type: "string", example: "5599999999999" },
            name: { type: "string", example: "Fulano" },
            phone: { type: "string", example: "5598888888888" }
          }
        },
        SendNarrationRequest: {
          type: "object",
          required: ["to", "text"],
          properties: {
            to: { type: "string", example: "5599999999999" },
            text: { type: "string", example: "Seu pedido saiu para entrega." },
            lang: { type: "string", example: "pt-BR", description: "Código do idioma suportado pelo Google TTS" },
            slow: { type: "boolean", example: false }
          }
        },
        SendResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            key: { type: "object", description: "Mensagem retornada pelo Baileys" },
            error: { type: "string" }
          }
        },
        StatusResponse: {
          type: "object",
          properties: {
            connected: { type: "boolean" },
            qr: { type: "string", nullable: true },
            qrDataUrl: { type: "string", nullable: true },
            me: { type: "string", nullable: true },
            pushName: { type: "string", nullable: true }
          }
        }
      }
    },
    paths: {
      "/api/qr": {
        get: {
          summary: "Obter QR Code atual",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: "Status da sessão e QR", content: { "application/json": { schema: { $ref: "#/components/schemas/StatusResponse" } } } }
          }
        }
      },
      "/api/qr/new": {
        post: {
          summary: "Forçar novo QR (limpa sessão e reinicia conexão)",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: { 200: { description: "Sessão reiniciada" } }
        }
      },
      "/api/status": {
        get: {
          summary: "Status da sessão",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: {
            200: { description: "Status", content: { "application/json": { schema: { $ref: "#/components/schemas/StatusResponse" } } } }
          }
        }
      },
      "/api/disconnect": {
        post: {
          summary: "Desconectar e limpar sessão",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: { 200: { description: "Instância desconectada" } }
        }
      },
      "/api/clear-cache": {
        post: {
          summary: "Limpar cache/auth sem reiniciar",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          responses: { 200: { description: "Cache limpo" } }
        }
      },
      "/api/check-number": {
        post: {
          summary: "Verificar se número é WhatsApp",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["to"],
                  properties: { to: { type: "string", example: "5599999999999" } }
                }
              }
            }
          },
          responses: {
            200: {
              description: "Resultado da checagem",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      exists: { type: "boolean" },
                      jid: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/send/text": {
        post: {
          summary: "Enviar mensagem de texto",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendTextRequest" } } }
          },
          responses: {
            200: { description: "Resultado", content: { "application/json": { schema: { $ref: "#/components/schemas/SendResponse" } } } }
          }
        }
      },
      "/api/send/media": {
        post: {
          summary: "Enviar mídia (imagem, vídeo, áudio, documento)",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["to", "file"],
                  properties: {
                    to: { type: "string", example: "5599999999999" },
                    caption: { type: "string", example: "Legenda opcional" },
                    kind: { type: "string", enum: ["image", "video", "audio", "document"] },
                    file: { type: "string", format: "binary" }
                  }
                }
              }
            }
          },
          responses: {
            200: { description: "Resultado", content: { "application/json": { schema: { $ref: "#/components/schemas/SendResponse" } } } }
          }
        }
      },
      "/api/send/contact": {
        post: {
          summary: "Enviar contato vCard",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendContactRequest" } } }
          },
          responses: {
            200: { description: "Resultado", content: { "application/json": { schema: { $ref: "#/components/schemas/SendResponse" } } } }
          }
        }
      },
      "/api/send/narration": {
        post: {
          summary: "Enviar áudio narrado (TTS)",
          description: "Gera áudio via Google TTS e envia como mensagem de áudio.",
          security: [{ ApiToken: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SendNarrationRequest" } } }
          },
          responses: {
            200: { description: "Resultado", content: { "application/json": { schema: { $ref: "#/components/schemas/SendResponse" } } } }
          }
        }
      }
    }
  },
  apis: []
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/api-docs.json", (_req, res) => res.json(swaggerSpec));

function authGuard(req: Request, res: Response, next: () => void) {
  if (!API_TOKEN) return next(); // Sem token configurado, segue.

  const headerToken =
    (req.headers["x-api-token"] as string | undefined) ||
    (req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");

  if (headerToken && headerToken === API_TOKEN) return next();
  return res.status(401).json({ error: "Token inválido ou ausente." });
}

app.use("/api", authGuard);
app.use("/api/send", rateLimiter);

app.post("/login", (req: Request, res: Response) => {
  const { user, pass } = req.body;
  if (user === DASH_USER && pass === DASH_PASS) {
    return res.json({ token: API_TOKEN, user });
  }
  return res.status(401).json({ error: "Credenciais inválidas." });
});

app.get("/api/qr", async (_req: Request, res: Response) => {
  const status = whatsapp.status;
  const qr = status.qr;

  let qrDataUrl: string | null = null;
  if (qr) {
    qrDataUrl = await QRCode.toDataURL(qr);
  }

  res.json({
    connected: status.connected,
    qr,
    qrDataUrl,
    me: status.me,
    pushName: status.pushName
  });
});

app.get("/api/status", (_req: Request, res: Response) => {
  res.json(whatsapp.status);
});

app.post("/api/qr/new", async (_req: Request, res: Response) => {
  await whatsapp.forceNewQr();
  res.json({ success: true });
});

app.post("/api/disconnect", async (_req: Request, res: Response) => {
  await whatsapp.disconnect();
  res.json({ success: true });
});

app.post("/api/clear-cache", async (_req: Request, res: Response) => {
  await whatsapp.clearCacheOnly();
  res.json({ success: true });
});

app.post("/api/check-number", async (req: Request, res: Response) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Campo 'to' é obrigatório." });
  try {
    const result = await whatsapp.checkNumber(to);
    const first = result?.[0];
    res.json({ exists: !!(first && first.exists), jid: first?.jid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao checar número." });
  }
});

app.post("/api/send/text", async (req: Request, res: Response) => {
  const { to, message } = req.body;
  const idemKey = getIdemKey(req);
  if (idemKey && replyIfCached(idemKey, res)) return;
  if (!to || !message) {
    return res.status(400).json({ error: "Campos 'to' e 'message' são obrigatórios." });
  }

  try {
    const key = await whatsapp.sendText({ to, message });
    cacheIdem(idemKey, res, { success: true, key });
  } catch (err) {
    console.error(err);
    cacheIdem(idemKey, res, { error: "Falha ao enviar mensagem de texto." }, 500);
  }
});

app.post("/api/send/media", upload.single("file"), async (req: Request, res: Response) => {
  const { to, caption, kind: kindInput } = req.body;
  const file = req.file;

  if (!to || !file) {
    return res.status(400).json({ error: "Campos 'to' e arquivo 'file' são obrigatórios." });
  }

  const mimetype = file.mimetype;
  const kind = (kindInput as MediaKind) ?? deduceKind(mimetype);

  try {
    const key = await whatsapp.sendMedia({
      to,
      buffer: file.buffer,
      kind,
      mimetype,
      fileName: file.originalname,
      caption
    });
    res.json({ success: true, key });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao enviar mídia." });
  }
});

app.post("/api/send/contact", async (req: Request, res: Response) => {
  const { to, name, phone } = req.body;
  if (!to || !name || !phone) {
    return res.status(400).json({ error: "Campos 'to', 'name' e 'phone' são obrigatórios." });
  }

  try {
    const key = await whatsapp.sendContact({ to, name, phone });
    res.json({ success: true, key });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Falha ao enviar contato." });
  }
});

app.post("/api/send/narration", async (req: Request, res: Response) => {
  const { to, text, lang, slow } = req.body;
  const idemKey = getIdemKey(req);
  if (idemKey && replyIfCached(idemKey, res)) return;

  if (!to || !text) {
    return res.status(400).json({ error: "Campos 'to' e 'text' são obrigatórios." });
  }

  try {
    const key = await whatsapp.sendNarration({ to, text, lang, slow });
    cacheIdem(idemKey, res, { success: true, key });
  } catch (err) {
    console.error("Erro ao enviar áudio narrado:", err);
    cacheIdem(idemKey, res, { error: "Falha ao enviar áudio narrado.", detail: (err as Error)?.message }, 500);
  }
});

app.use(express.static(path.join(process.cwd(), "public")));

app.listen(PORT, () => {
  console.log(`API WPP iniciada na porta ${PORT}`);
});

function deduceKind(mimetype: string): MediaKind {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "audio";
  return "document";
}

function rateLimiter(_req: Request, res: Response, next: () => void) {
  const now = Date.now();
  rateTimestamps = rateTimestamps.filter((t) => now - t < rateWindowMs);
  if (rateTimestamps.length >= rateMax) {
    return res.status(429).json({ error: "Muitas requisições, tente novamente em instantes." });
  }
  rateTimestamps.push(now);
  next();
}

function getIdemKey(req: Request): string | null {
  return (req.headers["idempotency-key"] as string | undefined) ?? (req.body?.clientMessageId as string | undefined) ?? null;
}

function replyIfCached(key: string | null, res: Response): boolean {
  if (!key) return false;
  const cached = idempotencyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    res.status(cached.status).json(cached.body);
    return true;
  }
  return false;
}

function cacheIdem(key: string | null, res: Response, body: unknown, status = 200) {
  if (key) {
    idempotencyCache.set(key, { status, body, expiresAt: Date.now() + IDEM_TTL_MS });
  }
  res.status(status).json(body);
}
