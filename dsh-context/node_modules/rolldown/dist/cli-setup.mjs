import { h as createTokioRuntime } from "./shared/binding-D7oxcV7l.mjs";

//#region src/cli/setup-index.ts
let isWatchMode = false;
for (let i = 0; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "--watch" || arg === "-w") {
		isWatchMode = true;
		break;
	}
}
if (isWatchMode) createTokioRuntime(32);
else createTokioRuntime(4);

//#endregion
export {  };