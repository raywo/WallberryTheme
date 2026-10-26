const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const {loadScripts} = require("./helpers/load-scripts");

const SCRIPTS = [
	"WB-weather/WB-dataObjects.js",
	"WB-weather/WB-provider.js",
	"WB-weather/WB-weather.js",
	"WB-weather/providers/WB-openweathermap.js",
	"WB-weather/providers/WB-openmeteo.js"
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
		clearTimeout: () => {},
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

	it("sends the request of the openmeteo provider to Open-Meteo without a key", () => {
		const {module, requests} = createModule({providerName: "openmeteo", latitude: 52.52, longitude: 13.41});
		module.start();
		assert.equal(module.getScripts().at(-1), "providers/WB-openmeteo.js");
		assert.equal(requests.length, 1);
		assert.match(requests[0], /^https:\/\/api\.open-meteo\.com\//);
	});

	describe("without providerName", () => {
		const keylessConfig = {latitude: 52.52, longitude: 13.41};

		it("loads no provider", () => {
			const {module} = createModule(keylessConfig);
			assert.equal(module.getScripts().filter((file) => file.startsWith("providers/")).length, 0);
		});

		it("shows an error that names the option and its values, and fetches nothing", () => {
			const {module, requests} = createModule({...keylessConfig, apiKey: "key"});
			module.start();
			assert.equal(module.error.isTemporary, false);
			assert.match(module.error.description, /providerName/);
			assert.match(module.error.description, /"openmeteo"/);
			assert.match(module.error.description, /"openweathermap"/);
			assert.equal(requests.length, 0);
		});

		it("still fetches nothing after a resume", () => {
			const {module, requests} = createModule(keylessConfig);
			module.start();
			module.resume();
			assert.equal(requests.length, 0);
		});
	});
});
