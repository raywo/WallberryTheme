const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {loadScripts} = require("./helpers/load-scripts");

const REPO_ROOT = path.join(__dirname, "..");

function readTranslation(file) {
	return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "WB-weather", file), "utf8"));
}

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
function createModule(userConfig, globals = {}) {
	const requests = [];
	const scripts = loadScripts(SCRIPTS, {
		...globals,
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

describe("WB-weather translations", () => {
	const {module} = createModule({providerName: "openmeteo"});
	const files = module.getTranslations();
	const EN = readTranslation(files.en);

	it("lists English first, so that MagicMirror² falls back to it", () => {
		assert.equal(Object.keys(files)[0], "en");
		assert.ok(files.de);
	});

	it("translates every key into every language", () => {
		for (const file of Object.values(files)) {
			assert.deepEqual(Object.keys(readTranslation(file)).sort(), Object.keys(EN).sort(), file);
		}
	});

	it("keeps the placeholders of each English text", () => {
		const placeholders = (text) => (text.match(/{[^}]+}/g) ?? []).sort();
		for (const file of Object.values(files)) {
			const translation = readTranslation(file);
			for (const key of Object.keys(EN)) {
				assert.deepEqual(placeholders(translation[key]), placeholders(EN[key]), `${file} ${key}`);
			}
		}
	});

	it("has a text for every description key of the openmeteo provider", () => {
		const scripts = loadScripts(SCRIPTS);
		const keys = Object.values(scripts.get("WBOpenMeteo").descriptionKeys);
		for (const key of keys) {
			assert.ok(key in EN, key);
		}
	});
});

describe("WB-weather day labels", () => {
	/**
	 * Stands in for moment.js, which MagicMirror² provides: records the
	 * locale set on each date and on moment itself.
	 */
	function momentStub() {
		const calls = {dateLocales: [], globalLocales: []};
		const moment = {
			unix: (seconds) => ({
				locale(language) {
					calls.dateLocales.push(language);
					return {format: (pattern) => `${pattern} of ${seconds} in ${language}`};
				}
			}),
			locale: (language) => calls.globalLocales.push(language)
		};
		return {moment, calls};
	}

	it("names the weekday in MagicMirror²'s language", () => {
		const {moment, calls} = momentStub();
		const {module} = createModule({providerName: "openmeteo"}, {moment, config: {language: "de", units: "metric"}});
		assert.equal(module.dayLabel(1793012400), "ddd of 1793012400 in de");
		assert.deepEqual(calls.dateLocales, ["de"]);
	});

	it("leaves moment's global locale to other modules", () => {
		const {moment, calls} = momentStub();
		const {module} = createModule({providerName: "openmeteo"}, {moment});
		module.dayLabel(1793012400);
		assert.deepEqual(calls.globalLocales, []);
	});
});
