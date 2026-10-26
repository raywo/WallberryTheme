const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const {loadScripts} = require("./helpers/load-scripts");

const SCRIPTS = [
	"WB-weather/WB-dataObjects.js",
	"WB-weather/WB-provider.js",
	"WB-weather/providers/WB-openweathermap.js"
];

const CONFIG = {
	providerName: "openweathermap",
	apiKey: "key",
	latitude: 52.52,
	longitude: 13.41,
	units: "metric",
	language: "en",
	daysToForecast: 2
};

// The answer of One Call 3.0 for a key without the "One Call by Call" subscription.
const NO_SUBSCRIPTION = {
	cod: 401,
	message: "Please note that using One Call 3.0 requires a separate subscription to the One Call by Call plan. Learn more here https://openweathermap.org/price. If you have a valid subscription to the One Call by Call plan, but still receive this error, then please see https://openweathermap.org/faq#error401 for more info."
};

const ONE_CALL = {
	current: {temp: 12.3, weather: [{id: 801, description: "few clouds"}]},
	daily: [
		{dt: 1761476400, pop: 0.2, temp: {min: 8, max: 14}, weather: [{id: 500}]},
		{dt: 1761562800, pop: 0.6, snow: 1.5, temp: {min: -2, max: 1}, weather: [{id: 600}]},
		{dt: 1761649200, pop: 0, temp: {min: 3, max: 9}, weather: [{id: 800}]}
	]
};

/**
 * Runs one fetch of the OpenWeatherMap provider against a stubbed
 * `fetch` that answers with the given status and body, and resolves
 * once the provider has told its delegate.
 */
function fetchWith(status, body) {
	const requests = [];
	const scripts = loadScripts(SCRIPTS, {
		fetch: (url) => {
			requests.push(url);
			return Promise.resolve({ok: status >= 200 && status < 300, json: () => Promise.resolve(body)});
		}
	});
	const Provider = scripts.get("WBProviderManager").providers.openweathermap;

	return new Promise((resolve) => {
		const provider = new Provider(CONFIG, {updateAvailable: () => resolve({provider, requests})});
		provider.fetchWeather();
	});
}

describe("WBOpenWeatherMap", () => {
	it("requests One Call 3.0", async () => {
		const {requests} = await fetchWith(200, ONE_CALL);
		assert.equal(requests.length, 1);
		assert.match(requests[0], /^https:\/\/api\.openweathermap\.org\/data\/3\.0\/onecall\?/);
		assert.match(requests[0], /lat=52\.52&lon=13\.41&appid=key&units=metric&lang=en/);
	});

	it("fills current weather and forecast from a One Call 3.0 answer", async () => {
		const {provider} = await fetchWith(200, ONE_CALL);
		assert.equal(provider.error, null);
		assert.equal(provider.weather.temp, 12.3);
		assert.equal(provider.weather.wicon, "wi-owm-801");
		assert.equal(provider.weather.longDescription, "few clouds");
		assert.deepEqual(
			provider.weather.forecast.map((f) => [f.date, f.precipChance, f.precipType, f.minTemp, f.maxTemp, f.wicon]),
			[
				[1761476400, 20, "rain", 8, 14, "wi-owm-500"],
				[1761562800, 60, "snow", -2, 1, "wi-owm-600"]
			]
		);
	});

	it("shows OpenWeatherMap's message and stops for a key without the subscription", async () => {
		const {provider} = await fetchWith(401, NO_SUBSCRIPTION);
		assert.equal(provider.weather, null);
		assert.equal(provider.error.isTemporary, false);
		assert.equal(provider.error.description, NO_SUBSCRIPTION.message);
	});
});
