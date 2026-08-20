import { TelegramClient } from "@mtcute/node";
import { loadConfig } from "../config/config.js";

const phone = process.argv[2];
if (!phone) throw new Error("Usage: tsx src/scripts/telegram-resolve-phone.ts <phone-number>");

const config = loadConfig();
if (!config.telegram.apiId || !config.telegram.apiHash) throw new Error("Configure TELEGRAM_API_ID and TELEGRAM_API_HASH first");

const client = new TelegramClient({ apiId: config.telegram.apiId, apiHash: config.telegram.apiHash, storage: config.telegram.sessionPath });
await client.start();

// Resolving a phone number the account has never talked to requires importing it as a
// contact first (Telegram has no other lookup-by-phone API). We immediately delete that
// contact again below so this script has no lasting side effect on the real account.
const result = await client.importContacts([{ phone: phone.replace(/^\+/, ""), firstName: "TelegramTrader Lookup", lastName: "" }]);
if (result.users.length === 0) {
  process.stdout.write("Not found: this phone number is not registered on Telegram, or its privacy settings hide it from lookup by phone.\n");
} else {
  for (const user of result.users) {
    process.stdout.write(`chatId\t${user.id}\tname\t${"firstName" in user ? user.firstName : ""} ${"lastName" in user ? user.lastName ?? "" : ""}\n`);
  }
  await client.deleteContacts(result.users.map((user) => user.id));
}

await client.destroy();
process.exit(0);
