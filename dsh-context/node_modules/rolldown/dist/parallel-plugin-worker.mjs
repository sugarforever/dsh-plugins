import { x as registerPlugins } from "./shared/binding-D7oxcV7l.mjs";
import { l as PluginContextData, u as bindingifyPlugin } from "./shared/src-CPA2meNe.mjs";
import "./shared/parse-ast-index-lp33x2Wb.mjs";
import "./shared/misc-usdOVIou.mjs";
import { parentPort, workerData } from "node:worker_threads";

//#region src/parallel-plugin-worker.ts
const { registryId, pluginInfos, threadNumber } = workerData;
(async () => {
	try {
		registerPlugins(registryId, await Promise.all(pluginInfos.map(async (pluginInfo) => {
			const definePluginImpl = (await import(pluginInfo.fileUrl)).default;
			const plugin = await definePluginImpl(pluginInfo.options, { threadNumber });
			return {
				index: pluginInfo.index,
				plugin: bindingifyPlugin(plugin, {}, {}, new PluginContextData(() => {}, {}, []), [], () => {}, "info", false)
			};
		})));
		parentPort.postMessage({ type: "success" });
	} catch (error) {
		parentPort.postMessage({
			type: "error",
			error
		});
	} finally {
		parentPort.unref();
	}
})();

//#endregion
export {  };