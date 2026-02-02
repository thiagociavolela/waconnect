import { WAMessageKey } from "@whiskeysockets/baileys";
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
export declare class WhatsAppService {
    private socket;
    private qrString;
    private connecting;
    private connected;
    private authFolder;
    private meJid;
    private pushName;
    constructor();
    get status(): {
        connected: boolean;
        me: string | undefined;
        pushName: string | undefined;
        qr: string | null;
    };
    start(): Promise<void>;
    private resetAuthAndRestart;
    forceNewQr(): Promise<void>;
    clearCacheOnly(): Promise<void>;
    disconnect(): Promise<void>;
    private assertSocket;
    private formatJid;
    sendText({ to, message }: SendTextPayload): Promise<WAMessageKey>;
    sendMedia({ to, buffer, kind, mimetype, fileName, caption }: SendMediaPayload): Promise<WAMessageKey>;
    sendContact({ to, name, phone }: SendContactPayload): Promise<WAMessageKey>;
    sendNarration({ to, text, lang, slow }: SendNarrationPayload): Promise<WAMessageKey>;
    checkNumber(to: string): Promise<{
        jid: string;
        exists: boolean;
    }[] | undefined>;
    private withRetry;
}
