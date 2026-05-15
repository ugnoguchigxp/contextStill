import { db } from "../src/db/index.js";
import { syncStates } from "../src/db/schema.js";

async function main() {
  try {
    const states = await db.select().from(syncStates);
    console.log(JSON.stringify(states, null, 2));
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}

main();
