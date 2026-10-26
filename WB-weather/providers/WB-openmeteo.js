/* Magic Mirror - WallberryTheme <3
 * Module: WB-weather
 *
 * MIT Licensed.
 */
class WBOpenMeteo extends WBProvider {
	constructor(config, delegate) {
		super(config, delegate);
		this.baseURL = "https://api.open-meteo.com/v1/forecast";

		let params = {
			"latitude": config.latitude,
			"longitude": config.longitude,
			"current": "temperature_2m,weather_code,is_day",
			"daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,snowfall_sum",
			"timezone": "auto",
			"timeformat": "unixtime", // WBForecast.date is in Unix seconds
			"forecast_days": this.daysToForecast
		};
		// Open-Meteo has no Kelvin, so everything but "imperial" stays Celsius
		if (config.units === "imperial") {
			params["temperature_unit"] = "fahrenheit";
		}
		this.url = this.getQueryStringURL(this.baseURL, params);
	}

	get updateIntervalLimit() {
		return 15 * 60 * 1000; // 15 minutes, Open-Meteo's update rate
	}

	get daysToForecastLimit() {
		return 16;
	}

	fetchWeather() {
		var status = null;
		fetch(this.url).then(response => {
			status = response.status;
			return response.json();
		}).then(jsonData => {
			if (status >= 200 && status < 300) {
				this.resolveWithSuccess(this.process(jsonData));
			} else if (status >= 400 && status < 500 && status !== 429) {
				// Open-Meteo rejected the request, e.g. invalid coordinates -- the user needs to fix the config
				this.resolveWithCriticalError(jsonData.reason);
			} else {
				// a server error, or the request limit (429) -- should resolve in a bit
				this.resolveWithTemporaryError(jsonData.reason || `server answered with status ${status}`);
			}
		}).catch(error => {
			// a network error, or a server error without JSON -- should resolve in a bit
			this.resolveWithTemporaryError(error.message);
		});
	}

	process(data) {
		var w = new WBWeather();
		w.temp = data.current.temperature_2m;

		var daily = data.daily;
		w.forecast = daily.time.slice(0, this.daysToForecast).map((time, i) => {
			var f = new WBForecast();
			f.date = time;
			f.precipChance = daily.precipitation_probability_max[i];
			f.precipType = (daily.snowfall_sum[i] > 0) ? "snow" : "rain";
			f.minTemp = daily.temperature_2m_min[i];
			f.maxTemp = daily.temperature_2m_max[i];

			return f;
		});

		return w;
	}
}

WBProviderManager.register("openmeteo", WBOpenMeteo);
