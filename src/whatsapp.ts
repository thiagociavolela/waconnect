import type { AnyMessageContent, Browsers, WAMessageKey, WASocket, WAUrlInfo } from "@whiskeysockets/baileys";
import { fetchLatestBaileysVersion, useMultiFileAuthState } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import PQueue from "p-queue";
import path from "path";
import fs from "fs/promises";
import { getAudioUrl } from "google-tts-api";

export type MediaKind = "image" | "video" | "audio" | "document";

export interface SendTextPayload {
  to: string;
  message: string;
}

export interface SendMediaPayload {
  to: string;
  kind: MediaKind;
  buffer: Buffer;
  mimetype?: string;
  fileName?: string;
  caption?: string;
}

export interface SendContactPayload {
  to: string;
  name: string;
  phone: string;
}

export interface SendNarrationPayload {
  to: string;
  text: string;
  lang?: string;
  slow?: boolean;
}

export class WhatsAppService {
  private socket: WASocket | null = null;
  private qrString: string | null = null;
  private connecting = false;
  private connected = false;
  private authFolder = path.join(process.cwd(), "auth");
  private meJid: string | undefined;
  private pushName: string | undefined;
  private profilePicUrl: string | undefined;
  private queue = new PQueue({ concurrency: 3 });
  private lastSendByJid = new Map<string, number>();

  constructor() {
    void this.start();
  }

  private baileysModule: Promise<typeof import("@whiskeysockets/baileys")> | null = null;

  private async loadProfilePic() {
    try {
      const jid = this.socket?.user?.id;
      if (!jid) return;
      const url = await this.socket?.profilePictureUrl(jid, "image");
      this.profilePicUrl = url ?? undefined;
    } catch (err) {
      console.warn("Não foi possível carregar foto de perfil", err);
    }
  }

  private loadBaileys() {
    if (!this.baileysModule) {
      // usa import nativo para evitar require() em ESM
      const dynamicImport = new Function("specifier", "return import(specifier);") as (
        s: string
      ) => Promise<typeof import("@whiskeysockets/baileys")>;
      this.baileysModule = dynamicImport("@whiskeysockets/baileys");
    }
    return this.baileysModule;
  }

  get status() {
    return {
      connected: this.connected,
      me: this.meJid,
      pushName: this.pushName,
      qr: this.qrString,
      profilePicUrl: this.profilePicUrl
    };
  }

  async statusWithFreshPic() {
    await this.loadProfilePic();
    return this.status;
  }

  async start() {
    if (this.connecting) return;
    this.connecting = true;

    const baileys = await this.loadBaileys();
    const { state, saveCreds } = await baileys.useMultiFileAuthState(this.authFolder);
    const { version } = await baileys.fetchLatestBaileysVersion();

    this.socket = baileys.makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: baileys.Browsers.macOS("Chrome"),
      // ativa thumbnails enviadas para gerar previews ricos de links
      generateHighQualityLinkPreview: true,
      // define user-agent para melhorar compatibilidade de scraping de OG tags
      options: {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
        }
      }
    });

    this.socket.ev.on("creds.update", saveCreds);

    this.socket.ev.on("connection.update", (update) => {
      console.log("conn update", update.connection, update.qr ? "qr-received" : "", update.lastDisconnect?.error?.message ?? "");
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log("qr received len", qr.length);
        this.qrString = qr;
        this.connected = false;
      }

      if (connection === "open") {
        this.connected = true;
        this.qrString = null;
        this.meJid = this.socket?.user?.id;
        this.pushName = this.socket?.user?.name;
        void this.loadProfilePic();
      }

      if (connection === "close") {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const shouldReconnect = statusCode !== baileys.DisconnectReason.loggedOut;
        if (shouldReconnect) {
          this.connecting = false;
          void this.start();
        } else {
          this.qrString = null;
          void this.resetAuthAndRestart();
        }
      }
    });

    this.connecting = false;
  }

  private async resetAuthAndRestart() {
    try {
      await fs.rm(this.authFolder, { recursive: true, force: true });
    } catch (err) {
      console.error("Erro ao limpar auth:", err);
    }
    this.connecting = false;
    this.connected = false;
    this.socket = null;
    this.qrString = null;
    this.profilePicUrl = undefined;
    void this.start();
  }

  async forceNewQr() {
    await this.resetAuthAndRestart();
  }

  async clearCacheOnly() {
    try {
      await fs.rm(this.authFolder, { recursive: true, force: true });
      this.qrString = null;
    } catch (err) {
      console.error("Erro ao limpar cache:", err);
    }
  }

  async disconnect() {
    try {
      await this.socket?.logout();
      await this.socket?.end(new Error("manual disconnect"));
    } catch (err) {
      console.error("Erro ao desconectar:", err);
    }
    await this.clearCacheOnly();
    this.connected = false;
    this.socket = null;
    this.qrString = null;
    this.profilePicUrl = undefined;
  }

  private assertSocket(): WASocket {
    if (!this.socket) throw new Error("WhatsApp socket not initialized");
    return this.socket;
  }

  private async scheduleSend<T>(jid: string, fn: () => Promise<T>): Promise<T> {
    return this.queue.add<T>(
      async () => {
        const now = Date.now();
        const last = this.lastSendByJid.get(jid) ?? 0;
        const baseGap = 1500; // 1.5s entre mensagens para o mesmo destino
        const jitter = Math.floor(Math.random() * 700); // +0-700ms para evitar padrão robótico
        const waitMs = Math.max(0, last + baseGap + jitter - now);
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        const result = await fn();
        this.lastSendByJid.set(jid, Date.now());
        return result;
      },
      { throwOnTimeout: true }
    );
  }

  /**
   * Ajusta números brasileiros que podem estar sem o 9º dígito nos celulares.
   * Se vier com DDI 55 + DDD + 8 dígitos iniciando em 6–9, insere o 9.
   */
  private normalizeBrazilNumber(raw: string): { formatted: string; addedNine: boolean } {
    let digits = raw.replace(/\D/g, "");
    let addedNine = false;

    if (digits.startsWith("55")) {
      const rest = digits.slice(2); // DDD + número
      if (rest.length === 10) {
        const ddd = rest.slice(0, 2);
        const local = rest.slice(2);
        if (/^[6-9]/.test(local)) {
          digits = `55${ddd}9${local}`;
          addedNine = true;
        }
      }
    }

    return { formatted: digits, addedNine };
  }

  private formatJid(raw: string): string {
    const normalized = raw.replace(/\s|-/g, "");
    if (normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@g.us")) {
      return normalized;
    }
    if (normalized.includes("@")) return normalized;
    const { formatted } = this.normalizeBrazilNumber(normalized);
    return `${formatted}@s.whatsapp.net`;
  }

  async sendText({ to, message }: SendTextPayload) {
    const jid = this.formatJid(to);
    return this.scheduleSend(jid, () =>
      this.withRetry(async () => {
        const baileys = await this.loadBaileys();
        const sock = this.assertSocket();
        let linkPreview: WAUrlInfo | undefined;
        const hasUrl = /(https?:\/\/[^\s]+)/i.test(message);
        if (hasUrl) {
          try {
            linkPreview = await baileys.getUrlInfo(message, {
              thumbnailWidth: 192,
              fetchOpts: {
                timeout: 8000,
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
                }
              }
            });
          } catch (err) {
            console.warn("Falha ao gerar link preview", err);
          }
        }
        const content: AnyMessageContent = linkPreview ? { text: message, linkPreview } : { text: message };
        const result = await sock.sendMessage(jid, content);
        return result?.key as WAMessageKey;
      })
    );
  }

  async sendMedia({ to, buffer, kind, mimetype, fileName, caption }: SendMediaPayload) {
    const jid = this.formatJid(to);
    return this.scheduleSend(jid, () =>
      this.withRetry(async () => {
        const sock = this.assertSocket();

        let content: AnyMessageContent;
        switch (kind) {
          case "image":
            content = { image: buffer, ...(caption ? { caption } : {}) };
            break;
          case "video":
            content = { video: buffer, ...(caption ? { caption } : {}) };
            break;
          case "audio":
            content = { audio: buffer, mimetype: mimetype ?? "audio/ogg; codecs=opus" };
            break;
          case "document":
          default:
            content = {
              document: buffer,
              mimetype: mimetype ?? "application/octet-stream",
              fileName: fileName ?? "document"
            };
            break;
        }

        const result = await sock.sendMessage(jid, content);
        return result?.key as WAMessageKey;
      })
    );
  }

  async sendContact({ to, name, phone }: SendContactPayload) {
    const jid = this.formatJid(to);
    return this.scheduleSend(jid, () =>
      this.withRetry(async () => {
        const sock = this.assertSocket();

        const vcard = [
          "BEGIN:VCARD",
          "VERSION:3.0",
          `FN:${name}`,
          `TEL;type=CELL;type=VOICE;waid=${phone.replace(/\D/g, "")}:${phone}`,
          "END:VCARD"
        ].join("\n");

        const content: AnyMessageContent = {
          contacts: {
            displayName: name,
            contacts: [{ vcard }]
          }
        };

        const result = await sock.sendMessage(jid, content);
        return result?.key as WAMessageKey;
      })
    );
  }

  async sendNarration({ to, text, lang = "pt-BR", slow = false }: SendNarrationPayload) {
    return this.withRetry(async () => {
      const url = getAudioUrl(text, { lang, slow, host: "https://translate.google.com" });
      const audioRes = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
        }
      });
      if (!audioRes.ok) throw new Error(`Falha ao gerar TTS: ${audioRes.status} ${audioRes.statusText}`);
      const arrayBuffer = await audioRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return this.sendMedia({
        to,
        buffer,
        kind: "audio",
        mimetype: "audio/mpeg",
        fileName: "narracao.mp3"
      });
    });
  }

  async checkNumber(to: string) {
    const sock = this.assertSocket();
    const jid = this.formatJid(to);
    const result = await sock.onWhatsApp(jid);
    return result;
  }

  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt < maxAttempts) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        attempt += 1;
        const backoff = 200 * attempt; // 200ms, 400ms, 600ms
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }
}
