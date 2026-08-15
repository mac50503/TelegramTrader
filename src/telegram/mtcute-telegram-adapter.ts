import { TelegramClient } from "@mtcute/node";
import type { TelegramAdapter } from "../application/ports.js";
import type { TelegramMessage } from "../models/signal.js";

export interface MtcuteOptions {
  apiId: number;
  apiHash: string;
  sessionPath: string;
  allowedChats: ReadonlySet<string>;
}

export class MtcuteTelegramAdapter implements TelegramAdapter {
  private readonly client: TelegramClient;

  constructor(private readonly options: MtcuteOptions) {
    this.client = new TelegramClient({ apiId: options.apiId, apiHash: options.apiHash, storage: options.sessionPath });
  }

  async start(onMessage: (message: TelegramMessage) => Promise<void>): Promise<void> {
    this.client.onNewMessage.add(async (message) => {
      const chatId = String(message.chat.id);
      if (!this.options.allowedChats.has(chatId) || !message.text.trim()) return;
      await onMessage({
        chatId,
        messageId: String(message.id),
        timestamp: message.date.toISOString(),
        text: message.text,
        chatName: message.chat.displayName,
        source: "TELEGRAM"
      });
    });
    await this.client.start();
  }

  async stop(): Promise<void> { await this.client.destroy(); }
}
