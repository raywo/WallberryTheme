/* MagicMirror² - WallberryTheme <3
 * Module: WB-weather
 *
 * MIT Licensed.
 */
class WBOpenMeteo extends WBProvider {
	// Weather Icons classes for the WMO interpretation codes Open-Meteo
	// returns, as [day, night]. Not wi-wmo4680-*: code table 4680 gives the
	// same numbers a different meaning.
	static icons = {
		0: ["wi-day-sunny", "wi-night-clear"], // clear sky
		1: ["wi-day-sunny-overcast", "wi-night-alt-partly-cloudy"], // mainly clear
		2: ["wi-day-cloudy", "wi-night-alt-cloudy"], // partly cloudy
		3: ["wi-cloudy", "wi-cloudy"], // overcast
		45: ["wi-day-fog", "wi-night-fog"], // fog
		48: ["wi-day-fog", "wi-night-fog"], // depositing rime fog
		51: ["wi-day-sprinkle", "wi-night-alt-sprinkle"], // light drizzle
		53: ["wi-day-sprinkle", "wi-night-alt-sprinkle"], // moderate drizzle
		55: ["wi-day-sprinkle", "wi-night-alt-sprinkle"], // dense drizzle
		56: ["wi-day-rain-mix", "wi-night-alt-rain-mix"], // light freezing drizzle
		57: ["wi-day-rain-mix", "wi-night-alt-rain-mix"], // dense freezing drizzle
		61: ["wi-day-rain", "wi-night-alt-rain"], // slight rain
		63: ["wi-day-rain", "wi-night-alt-rain"], // moderate rain
		65: ["wi-day-rain", "wi-night-alt-rain"], // heavy rain
		66: ["wi-day-sleet", "wi-night-alt-sleet"], // light freezing rain
		67: ["wi-day-sleet", "wi-night-alt-sleet"], // heavy freezing rain
		71: ["wi-day-snow", "wi-night-alt-snow"], // slight snow fall
		73: ["wi-day-snow", "wi-night-alt-snow"], // moderate snow fall
		75: ["wi-day-snow", "wi-night-alt-snow"], // heavy snow fall
		77: ["wi-day-snow", "wi-night-alt-snow"], // snow grains
		80: ["wi-day-showers", "wi-night-alt-showers"], // slight rain showers
		81: ["wi-day-showers", "wi-night-alt-showers"], // moderate rain showers
		82: ["wi-day-showers", "wi-night-alt-showers"], // violent rain showers
		85: ["wi-day-snow", "wi-night-alt-snow"], // slight snow showers
		86: ["wi-day-snow", "wi-night-alt-snow"], // heavy snow showers
		95: ["wi-day-thunderstorm", "wi-night-alt-thunderstorm"], // thunderstorm
		96: ["wi-day-sleet-storm", "wi-night-alt-sleet-storm"], // thunderstorm with slight hail
		99: ["wi-day-sleet-storm", "wi-night-alt-sleet-storm"] // thunderstorm with heavy hail
	};

	// "not available", for a code Open-Meteo may add later
	static unknownIcon = "wi-na";

	// Translation keys of the WMO code groups, for the description of the
	// current weather
	static descriptionKeys = {
		0: "WMO_CLEAR",
		1: "WMO_MAINLY_CLEAR",
		2: "WMO_PARTLY_CLOUDY",
		3: "WMO_OVERCAST",
		45: "WMO_FOG",
		48: "WMO_FOG",
		51: "WMO_DRIZZLE",
		53: "WMO_DRIZZLE",
		55: "WMO_DRIZZLE",
		56: "WMO_FREEZING_DRIZZLE",
		57: "WMO_FREEZING_DRIZZLE",
		61: "WMO_RAIN",
		63: "WMO_RAIN",
		65: "WMO_RAIN",
		66: "WMO_FREEZING_RAIN",
		67: "WMO_FREEZING_RAIN",
		71: "WMO_SNOW",
		73: "WMO_SNOW",
		75: "WMO_SNOW",
		77: "WMO_SNOW_GRAINS",
		80: "WMO_RAIN_SHOWERS",
		81: "WMO_RAIN_SHOWERS",
		82: "WMO_RAIN_SHOWERS",
		85: "WMO_SNOW_SHOWERS",
		86: "WMO_SNOW_SHOWERS",
		95: "WMO_THUNDERSTORM",
		96: "WMO_THUNDERSTORM_HAIL",
		99: "WMO_THUNDERSTORM_HAIL"
	};

	static snowCodes = [71, 73, 75, 77, 85, 86];

	/**
	 * Returns the Weather Icons class for a WMO weather code, in its day or
	 * night variant.
	 */
	static icon(code, isDay) {
		var variants = WBOpenMeteo.icons[code];
		if (!variants) {
			return WBOpenMeteo.unknownIcon;
		}
		return isDay ? variants[0] : variants[1];
	}

	/**
	 * Returns the translation key describing a WMO weather code, or null
	 * for a code without one.
	 */
	static descriptionKey(code) {
		return WBOpenMeteo.descriptionKeys[code] ?? null;
	}

	/**
	 * Describes a WMO weather code in the language of the mirror, or
	 * returns null for a code without a description.
	 */
	description(code) {
		var key = WBOpenMeteo.descriptionKey(code);
		return key === null ? null : this.delegate.translate(key);
	}

	constructor(config, delegate) {
		super(config, delegate);
		this.baseURL = "https://api.open-meteo.com/v1/forecast";

		const params = {
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
			params.temperature_unit = "fahrenheit";
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
		w.wicon = WBOpenMeteo.icon(data.current.weather_code, data.current.is_day === 1);
		w.longDescription = this.description(data.current.weather_code);

		var daily = data.daily;
		w.forecast = daily.time.slice(0, this.daysToForecast).map((time, i) => {
			var f = new WBForecast();
			// time is the location's midnight; noon keeps the weekday for
			// mirror clocks up to 12 hours off the location's time zone
			f.date = time + 12 * 60 * 60;
			f.precipChance = daily.precipitation_probability_max[i];
			var code = daily.weather_code[i];
			var snowy = daily.snowfall_sum[i] > 0 || WBOpenMeteo.snowCodes.includes(code);
			f.precipType = snowy ? "snow" : "rain";
			f.minTemp = daily.temperature_2m_min[i];
			f.maxTemp = daily.temperature_2m_max[i];
			f.wicon = WBOpenMeteo.icon(code, true);

			return f;
		});

		return w;
	}
}

WBProviderManager.register("openmeteo", WBOpenMeteo);
