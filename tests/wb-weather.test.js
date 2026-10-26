const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const {loadScripts} = require("./helpers/load-scripts");

const SCRIPTS = [
	"WB-weather/WB-dataObjects.js",
	"WB-weather/WB-provider.js",
	"WB-weather/WB-weather.js",
	"WB-weather/providers/WB-openweathermap.js"
];

/**
 * Builds a WB-weather instance the way MagicMirror² does: the module
 * definition merged with the user config. Timers fire at once, and
 * `fetch` records the requested URLs without answering.
 */
function createModule(userConfig) {
	const requests = [];
	const scripts = loadScripts(SCRIPTS, {
		setTimeout: (callback) => {
			callback();
			return 1;
		},
		fetch: (url) => {
			requests.push(url);
			return new Promise(() => {});
		}
	});
	const definition = scripts.modules["WB-weather"];
	const module = {
		...definition,
		name: "WB-weather",
		config: {...definition.defaults, ...userConfig},
		file: (file) => file,
		addNunjuckFilters: () => {},
		updateDom: () => {}
	};
	return {module, requests};
}

describe("WB-weather", () => {
	const owmConfig = {providerName: "openweathermap", latitude: 52.52, longitude: 13.41};

	it("loads the configured provider for a config without apiKey", () => {
		const {module} = createModule(owmConfig);
		assert.equal(module.getScripts().at(-1), "providers/WB-openweathermap.js");
	});

	it("keeps the configured provider for a config without apiKey", () => {
		const {module} = createModule(owmConfig);
		module.start();
		assert.equal(module.config.providerName, "openweathermap");
	});

	it("sends the request of the openweathermap provider to OpenWeatherMap", () => {
		const {module, requests} = createModule({...owmConfig, apiKey: "key"});
		module.start();
		assert.equal(requests.length, 1);
		assert.match(requests[0], /^https:\/\/api\.openweathermap\.org\/.*appid=key/);
	});
});
