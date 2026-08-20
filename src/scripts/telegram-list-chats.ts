import { TelegramClient } from "@mtcute/node";
import { loadConfig } from "../config/config.js";

const config = loadConfig();
if (!config.telegram.apiId || !config.telegram.apiHash) throw new Error("Configure TELEGRAM_API_ID and TELEGRAM_API_HASH first");

const client = new TelegramClient({ apiId: config.telegram.apiId, apiHash: config.telegram.apiHash, storage: config.telegram.sessionPath });
await client.start();

process.stdout.write("chatId\t\tname\n");
for await (const dialog of client.iterDialogs()) {
  const peer = dialog.peer;
  process.stdout.write(`${peer.id}\t${peer.displayName}\n`);
}

await client.destroy();
process.exit(0);
