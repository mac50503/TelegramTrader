import { loadConfig } from "../config/config.js";
import { openDatabase } from "./database.js";

const config = loadConfig();
const db = openDatabase(config.databaseUrl);
db.close();
process.stdout.write("Database schema is up to date.\n");
