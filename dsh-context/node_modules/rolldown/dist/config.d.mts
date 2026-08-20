import { n as ConfigExport, t as defineConfig } from "./shared/define-config-BhR6ffrr.mjs";
import "./shared/binding-S7w0fEEX.mjs";

//#region src/utils/load-config.d.ts
declare function loadConfig(configPath: string): Promise<ConfigExport>;
//#endregion
//#region src/config.d.ts
declare const VERSION: string;
//#endregion
export { VERSION, defineConfig, loadConfig };