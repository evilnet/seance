// Repo paths shared by the i18n CLI scripts. Every script is documented to
// run from the repository root (`npx tsx tools/i18n/<script>.ts`), so the
// constants resolve against the process working directory.
import {resolve} from "node:path";

/** Where the pot and the compiled catalogs live. */
export const LOCALES_DIR = resolve("client/locales");

/** The fill-in table translators will see; source of all English copy. */
export const POT_PATH = resolve(LOCALES_DIR, "messages.pot");

/** The generated locale list the client imports. */
export const AVAILABLE_PATH = resolve("client/js/i18n/available.ts");
