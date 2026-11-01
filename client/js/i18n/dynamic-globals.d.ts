// The instrument loader (tools/i18n/instrument-loader.mjs) renames t()/
// tCount() calls with non-literal key arguments to these globals in
// development builds; core.ts assigns them under DEV_I18N. Declared here
// so every transformed module type-checks.
declare function __tDyn(key: string, vars?: unknown): string;
declare function __tDynC(key: string, count: number, vars?: unknown): string;
