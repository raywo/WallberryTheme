const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const {loadScripts} = require("./helpers/load-scripts");

const SCRIPTS = [
	"WB-weather/WB-dataObjects.js",
	"WB-weather/WB-provider.js",
	"WB-weather/providers/WB-openmeteo.js"
];

const CONFIG = {
	providerName: "openmeteo",
	latitude: 51.34,
	longitude: 12.37,
	units: "metric",
	language: "en",
	daysToForecast: 2
};

// An answer of Open-Meteo, shortened to three days.
const FORECAST = {
	current: {time: 1793043900, interval: 900, temperature_2m: 8.4, weather_code: 2, is_day: 0},
	daily: {
		time: [1792969200, 1793055600, 1793142000],
		weather_code: [61, 71, 3],
		temperature_2m_max: [12.9, 1.5, 14.5],
		temperature_2m_min: [7.6, -2.3, 8.1],
		precipitation_probability_max: [10, 70, 5],
		snowfall_sum: [0.00, 2.10, 0.00]
	}
};

// Open-Meteo's answer to a latitude out of range, with status 400.
const INVALID_LATITUDE = {error: true, reason: "Latitude must be in range of -90 to 90°. Given: 151.34."};

/**
 * Loads the Open-Meteo provider with a stubbed `fetch` and returns the
 * provider class and the requested URLs.
 */
function load(fetchStub) {
	const requests = [];
	const scripts = loadScripts(SCRIPTS, {
		fetch: (url) => {
			requests.push(url);
			return fetchStub(url);
		}
	});
	return {Provider: scripts.get("WBProviderManager").providers.openmeteo, requests, log: scripts.log};
}

/**
 * Runs one fetch of the provider and resolves once the provider has
 * told its delegate.
 */
function fetchWith(fetchStub, config = CONFIG) {
	const {Provider, requests} = load(fetchStub);
	return new Promise((resolve) => {
		const provider = new Provider(config, {updateAvailable: () => resolve({provider, requests})});
		provider.fetchWeather();
	});
}

function answer(status, body) {
	return () => Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body)
	});
}

function query(url) {
	return new URL(url).searchParams;
}

describe("WBOpenMeteo", () => {
	it("requests current weather and the daily forecast without a key", async () => {
		const {requests} = await fetchWith(answer(200, FORECAST));
		assert.equal(requests.length, 1);
		assert.match(requests[0], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
		const params = query(requests[0]);
		assert.equal(params.get("latitude"), "51.34");
		assert.equal(params.get("longitude"), "12.37");
		assert.equal(params.get("current"), "temperature_2m,weather_code,is_day");
		assert.equal(params.get("daily"), "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum");
		assert.equal(params.get("timezone"), "auto");
		assert.equal(params.get("timeformat"), "unixtime");
		assert.equal(params.get("forecast_days"), "2");
	});

	it("fills current temperature and one forecast per day", async () => {
		const {provider} = await fetchWith(answer(200, FORECAST));
		assert.equal(provider.error, null);
		assert.equal(provider.weather.temp, 8.4);
		assert.deepEqual(
			provider.weather.forecast.map((f) => [f.date, f.precipChance, f.precipType, f.minTemp, f.maxTemp]),
			[
				[1793012400, 10, "rain", 7.6, 12.9],
				[1793098800, 70, "snow", -2.3, 1.5]
			]
		);
	});

	it("dates each forecast so a clock in UTC reads the location's weekday", async () => {
		// Leipzig's Monday and Tuesday start at 23:00 UTC of the day before
		const {provider} = await fetchWith(answer(200, FORECAST));
		assert.deepEqual(
			provider.weather.forecast.map((f) => new Date(f.date * 1000).getUTCDay()),
			[1, 2]
		);
	});

	it("requests Fahrenheit for imperial units", async () => {
		const {requests} = await fetchWith(answer(200, FORECAST), {...CONFIG, units: "imperial"});
		assert.equal(query(requests[0]).get("temperature_unit"), "fahrenheit");
	});

	for (const units of ["metric", "standard", undefined]) {
		it(`requests Celsius for units ${units}`, async () => {
			const {requests} = await fetchWith(answer(200, FORECAST), {...CONFIG, units});
			assert.equal(query(requests[0]).has("temperature_unit"), false);
		});
	}

	it("forecasts at most 16 days", () => {
		const {Provider} = load(answer(200, FORECAST));
		const provider = new Provider({...CONFIG, daysToForecast: 20}, {updateAvailable: () => {}});
		assert.equal(provider.daysToForecast, 16);
		assert.equal(query(provider.url).get("forecast_days"), "16");
	});

	it("updates at most every 15 minutes", () => {
		const {Provider} = load(answer(200, FORECAST));
		const provider = new Provider({...CONFIG, updateInterval: 60 * 1000}, {updateAvailable: () => {}});
		assert.equal(provider.updateInterval, 15 * 60 * 1000);
	});

	it("shows Open-Meteo's reason and stops for a rejected request", async () => {
		const {provider} = await fetchWith(answer(400, INVALID_LATITUDE));
		assert.equal(provider.weather, null);
		assert.equal(provider.error.isTemporary, false);
		assert.equal(provider.error.description, INVALID_LATITUDE.reason);
	});

	it("retries after a network error", async () => {
		const {provider} = await fetchWith(() => Promise.reject(new TypeError("Failed to fetch")));
		assert.equal(provider.error.isTemporary, true);
		assert.equal(provider.error.description, "Failed to fetch");
		assert.equal(provider.error.retryDelay, 15 * 60 * 1000);
	});

	it("retries after Open-Meteo's request limit is reached", async () => {
		const {provider} = await fetchWith(answer(429, {error: true, reason: "Daily API request limit exceeded. Please try again tomorrow."}));
		assert.equal(provider.error.isTemporary, true);
		assert.equal(provider.error.description, "Daily API request limit exceeded. Please try again tomorrow.");
	});

	it("retries after a server error", async () => {
		const {provider} = await fetchWith(answer(502, {error: true, reason: "Bad gateway"}));
		assert.equal(provider.error.isTemporary, true);
	});
});
