"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhatsAppService = void 0;
const p_queue_1 = __importDefault(require("p-queue"));
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const google_tts_api_1 = require("google-tts-api");
class WhatsAppService {
    constructor() {
        this.socket = null;
        this.qrString = null;
        this.connecting = false;
        this.connected = false;
        this.authFolder = path_1.default.join(process.cwd(), "auth");
        this.queue = new p_queue_1.default({ concurrency: 3 });
        this.lastSendByJid = new Map();
        this.baileysModule = null;
        void this.start();
    }
    loadBaileys() {
        if (!this.baileysModule) {
            // usa import nativo para evitar require() em ESM
            const dynamicImport = new Function("specifier", "return import(specifier);");
            this.baileysModule = dynamicImport("@whiskeysockets/baileys");
        }
        return this.baileysModule;
    }
    get status() {
        return {
            connected: this.connected,
            me: this.meJid,
            pushName: this.pushName,
            qr: this.qrString
        };
    }
    async start() {
        if (this.connecting)
            return;
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
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
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
            }
            if (connection === "close") {
                this.connected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== baileys.DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    this.connecting = false;
                    void this.start();
                }
                else {
                    this.qrString = null;
                    void this.resetAuthAndRestart();
                }
            }
        });
        this.connecting = false;
    }
    async resetAuthAndRestart() {
        try {
            await promises_1.default.rm(this.authFolder, { recursive: true, force: true });
        }
        catch (err) {
            console.error("Erro ao limpar auth:", err);
        }
        this.connecting = false;
        this.connected = false;
        this.socket = null;
        this.qrString = null;
        void this.start();
    }
    async forceNewQr() {
        await this.resetAuthAndRestart();
    }
    async clearCacheOnly() {
        try {
            await promises_1.default.rm(this.authFolder, { recursive: true, force: true });
            this.qrString = null;
        }
        catch (err) {
            console.error("Erro ao limpar cache:", err);
        }
    }
    async disconnect() {
        try {
            await this.socket?.logout();
            await this.socket?.end(new Error("manual disconnect"));
        }
        catch (err) {
            console.error("Erro ao desconectar:", err);
        }
        await this.clearCacheOnly();
        this.connected = false;
        this.socket = null;
        this.qrString = null;
    }
    assertSocket() {
        if (!this.socket)
            throw new Error("WhatsApp socket not initialized");
        return this.socket;
    }
    async scheduleSend(jid, fn) {
        return this.queue.add(async () => {
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
        }, { throwOnTimeout: true });
    }
    /**
     * Ajusta números brasileiros que podem estar sem o 9º dígito nos celulares.
     * Se vier com DDI 55 + DDD + 8 dígitos iniciando em 6–9, insere o 9.
     */
    normalizeBrazilNumber(raw) {
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
    formatJid(raw) {
        const normalized = raw.replace(/\s|-/g, "");
        if (normalized.endsWith("@s.whatsapp.net") || normalized.endsWith("@g.us")) {
            return normalized;
        }
        if (normalized.includes("@"))
            return normalized;
        const { formatted } = this.normalizeBrazilNumber(normalized);
        return `${formatted}@s.whatsapp.net`;
    }
    async sendText({ to, message }) {
        const jid = this.formatJid(to);
        return this.scheduleSend(jid, () => this.withRetry(async () => {
            const baileys = await this.loadBaileys();
            const sock = this.assertSocket();
            let linkPreview;
            const hasUrl = /(https?:\/\/[^\s]+)/i.test(message);
            if (hasUrl) {
                try {
                    linkPreview = await baileys.getUrlInfo(message, {
                        thumbnailWidth: 192,
                        fetchOpts: {
                            timeout: 8000,
                            headers: {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
                            }
                        }
                    });
                }
                catch (err) {
                    console.warn("Falha ao gerar link preview", err);
                }
            }
            const content = linkPreview ? { text: message, linkPreview } : { text: message };
            const result = await sock.sendMessage(jid, content);
            return result?.key;
        }));
    }
    async sendMedia({ to, buffer, kind, mimetype, fileName, caption }) {
        const jid = this.formatJid(to);
        return this.scheduleSend(jid, () => this.withRetry(async () => {
            const sock = this.assertSocket();
            let content;
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
            return result?.key;
        }));
    }
    async sendContact({ to, name, phone }) {
        const jid = this.formatJid(to);
        return this.scheduleSend(jid, () => this.withRetry(async () => {
            const sock = this.assertSocket();
            const vcard = [
                "BEGIN:VCARD",
                "VERSION:3.0",
                `FN:${name}`,
                `TEL;type=CELL;type=VOICE;waid=${phone.replace(/\D/g, "")}:${phone}`,
                "END:VCARD"
            ].join("\n");
            const content = {
                contacts: {
                    displayName: name,
                    contacts: [{ vcard }]
                }
            };
            const result = await sock.sendMessage(jid, content);
            return result?.key;
        }));
    }
    async sendNarration({ to, text, lang = "pt-BR", slow = false }) {
        return this.withRetry(async () => {
            const url = (0, google_tts_api_1.getAudioUrl)(text, { lang, slow, host: "https://translate.google.com" });
            const audioRes = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
                }
            });
            if (!audioRes.ok)
                throw new Error(`Falha ao gerar TTS: ${audioRes.status} ${audioRes.statusText}`);
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
    async checkNumber(to) {
        const sock = this.assertSocket();
        const jid = this.formatJid(to);
        const result = await sock.onWhatsApp(jid);
        return result;
    }
    async withRetry(fn, maxAttempts = 3) {
        let attempt = 0;
        let lastErr;
        while (attempt < maxAttempts) {
            try {
                return await fn();
            }
            catch (err) {
                lastErr = err;
                attempt += 1;
                const backoff = 200 * attempt; // 200ms, 400ms, 600ms
                await new Promise((r) => setTimeout(r, backoff));
            }
        }
        throw lastErr;
    }
}
exports.WhatsAppService = WhatsAppService;
//# sourceMappingURL=whatsapp.js.map