const {describe, it, beforeEach} = require("node:test");
const assert = require("node:assert/strict");
const {loadScripts} = require("./helpers/load-scripts");

const UPDATE_LIMIT = 10 * 60 * 1000;
const FORECAST_LIMIT = 7;

describe("WBProvider", () => {
	let scripts;
	let TestProvider;

	beforeEach(() => {
		scripts = loadScripts(["WB-weather/WB-dataObjects.js", "WB-weather/WB-provider.js"]);
		TestProvider = class extends scripts.get("WBProvider") {
			get updateIntervalLimit() {
				return UPDATE_LIMIT;
			}

			get daysToForecastLimit() {
				return FORECAST_LIMIT;
			}
		};
	});

	const provider = (config = {}) => new TestProvider({providerName: "test", ...config}, null);

	describe("getQueryStringURL", () => {
		it("appends the encoded parameters to the base URL", () => {
			const url = provider().getQueryStringURL("https://example.com/api", {lat: 51.34, q: "a b&c"});
			assert.equal(url, "https://example.com/api?lat=51.34&q=a%20b%26c");
		});

		it("returns the base URL unchanged without parameters", () => {
			assert.equal(provider().getQueryStringURL("https://example.com/api", {}), "https://example.com/api");
		});
	});

	describe("daysToForecast", () => {
		it("uses the provider's limit when the config sets none", () => {
			assert.equal(provider().daysToForecast, FORECAST_LIMIT);
		});

		it("keeps a value within the limit", () => {
			assert.equal(provider({daysToForecast: 4}).daysToForecast, 4);
		});

		it("caps a value above the limit and warns", () => {
			assert.equal(provider({daysToForecast: 16}).daysToForecast, FORECAST_LIMIT);
			assert.equal(scripts.log.warn.length, 1);
		});
	});

	describe("updateInterval", () => {
		it("uses the provider's limit when the config sets none", () => {
			assert.equal(provider().updateInterval, UPDATE_LIMIT);
		});

		it("keeps a value above the limit", () => {
			assert.equal(provider({updateInterval: 2 * UPDATE_LIMIT}).updateInterval, 2 * UPDATE_LIMIT);
		});

		it("raises a value below the limit and warns", () => {
			assert.equal(provider({updateInterval: 1000}).updateInterval, UPDATE_LIMIT);
			assert.equal(scripts.log.warn.length, 1);
		});
	});

	describe("WBProviderManager", () => {
		it("creates the registered provider for its name", () => {
			const manager = scripts.get("WBProviderManager");
			manager.register("test", TestProvider);
			assert.ok(manager.initialize({providerName: "test"}, null) instanceof TestProvider);
		});

		it("returns null for an unknown provider name", () => {
			assert.equal(scripts.get("WBProviderManager").initialize({providerName: "unknown"}, null), null);
		});
	});
});
