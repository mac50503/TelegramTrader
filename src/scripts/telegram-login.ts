import { loadConfig } from "../config/config.js";
import { MtcuteTelegramAdapter } from "../telegram/mtcute-telegram-adapter.js";

const config = loadConfig();
if (!config.telegram.apiId || !config.telegram.apiHash) throw new Error("Configure TELEGRAM_API_ID and TELEGRAM_API_HASH first");
const adapter = new MtcuteTelegramAdapter({ apiId: config.telegram.apiId, apiHash: config.telegram.apiHash,
  sessionPath: config.telegram.sessionPath, allowedChats: config.telegram.allowedChats });
await adapter.start(async (message) => { process.stdout.write(`Received message ${message.messageId} from configured chat.\n`); });
process.stdout.write("Telegram session is connected. Press Ctrl+C to stop.\n");
