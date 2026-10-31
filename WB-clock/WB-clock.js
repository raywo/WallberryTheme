/* MagicMirror² - WallberryTheme <3
 * Module: WB-clock
 *
 * By JSC (@delightedCrow)
 * MIT Licensed.
 */
Module.register("WB-clock",{
	// Module config defaults.
	defaults: {
		timeFormat: config.timeFormat,
		hourMinuteFormat: null,
		dateTimeFormat: null,
		localCityName: null,
		otherCities: []
	},

	updateTimer: null,
	// Define required scripts.
	getScripts: function() {
		return ["moment.js", "moment-timezone.js"];
	},
	// Define styles.
	getStyles: function() {
		return ["WB-clock.css"];
	},

	getTemplate: function() {
		return "WB-clock.njk";
	},

	getTemplateData: function() {

		var now = moment();
		var timeData = {};
		timeData.cities = [];

		timeData.localTime = now.format(this.config.hourMinuteFormat);
		timeData.date = now.format(this.config.dateTimeFormat);
		timeData.ampm = now.format("a");

		for (const cityElem in this.config.otherCities) {
			const city = {};
			city.name = this.config.otherCities[cityElem].name;
			const tz = this.config.otherCities[cityElem].timezone;
			city.time = now.tz(tz).format(this.config.hourMinuteFormat);
			city.ampm = now.tz(tz).format("a");
			timeData.cities.push(city);
		}

		return {
			config: this.config,
			timeData: timeData
		};
	},

	start: function() {
		Log.info(`Starting module: ${this.name}`);

		// Update clock every second
		this.updateTimer = setInterval(() => {
			this.updateDom();
		}, 1000);

		// Set locale.
		moment.locale(config.language);

		// if the user hasn't set a custom time format
		if (!this.config.hourMinuteFormat) {

			// then we try and choose an appropriate format based on MM2 config
			if (Number(this.config.timeFormat) === 12) {
				this.config.hourMinuteFormat = "h:mm";
			} else {
				this.config.hourMinuteFormat = "HH:mm";
			}
		}

		// if the user hasn't set a custom date format, follow the locale's word order
		if (!this.config.dateTimeFormat) {
			this.config.dateTimeFormat = this.dateFormatFromLongDate(moment.localeData().longDateFormat("LL"));
		}
	},

	/* Derives the date format from a locale's long date format (moment's
	 * "LL"): the weekday, then the long date without its year. The year
	 * goes together with the separator and words that belong to it, e.g.
	 * ", YYYY", " [de] YYYY", "YYYY г." or "YYYY年"; endings glued to the
	 * month or day, e.g. Finnish "MMMM[ta]" or an ordinal "D.", stay.
	 */
	dateFormatFromLongDate: function(longDateFormat) {
		const parts = longDateFormat.match(/\[[^\]]*\]|[A-Za-z]+|[^[A-Za-z]/g) || [];
		const isToken = (part) => /^[A-Za-z]+$/.test(part);
		const year = parts.findIndex((part) => /^[Yy]+$/.test(part));

		if (year !== -1) {
			let previous = year - 1;
			while (previous >= 0 && !isToken(parts[previous])) {
				previous--;
			}
			let next = year + 1;
			while (next < parts.length && !isToken(parts[next])) {
				next++;
			}

			if (previous === -1) {
				// year leads: drop it up to the next token
				parts.splice(0, next);
			} else {
				// keep literals and ordinal dots glued to the previous token
				let start = previous + 1;
				while (start < year && (parts[start].startsWith("[") || parts[start] === ".")) {
					start++;
				}
				// a trailing year takes everything after it along
				const end = next === parts.length ? parts.length : year + 1;
				parts.splice(start, end - start);
			}
		}

		return `dddd, ${parts.join("").trim()}`;
	},

	suspend: function() {
		Log.info("Suspending WB-clock...");
		clearInterval(this.updateTimer);
	},

	resume: function() {
		clearInterval(this.updateTimer);
		this.start();
	},

	nunjucksEnvironment: function() {
		if (this._nunjucksEnvironment !== null) {
			return this._nunjucksEnvironment;
		}

		this._nunjucksEnvironment = new nunjucks.Environment(new nunjucks.WebLoader(this.file(""), {async: true, useCache: true}), {
			trimBlocks: true,
			lstripBlocks: true
		});

		return this._nunjucksEnvironment;
	}
});
