const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const {loadScripts} = require("./helpers/load-scripts");

// A moment stub whose locale has the given long date format ("LL").
function momentWithLongDate(longDateFormat) {
	const moment = () => ({});
	moment.locale = () => {};
	moment.localeData = () => ({
		longDateFormat: (key) => (key === "LL" ? longDateFormat : undefined)
	});
	return moment;
}

function startClock(longDateFormat, config = {}) {
	const scripts = loadScripts(["WB-clock/WB-clock.js"], {
		moment: momentWithLongDate(longDateFormat),
		setInterval: () => 0
	});
	const clock = Object.create(scripts.modules["WB-clock"]);
	clock.config = {...clock.defaults, ...config};
	clock.start();
	return clock;
}

describe("WB-clock", () => {
	it("takes its default time format from the MagicMirror config", () => {
		const scripts = loadScripts(["WB-clock/WB-clock.js"], {
			config: {language: "en", timeFormat: 12}
		});
		assert.equal(scripts.modules["WB-clock"].defaults.timeFormat, 12);
	});

	describe("date format", () => {
		it("derives the date format from the locale's long date format", () => {
			assert.equal(startClock("MMMM D, YYYY").config.dateTimeFormat, "dddd, MMMM D");
			assert.equal(startClock("D. MMMM YYYY").config.dateTimeFormat, "dddd, D. MMMM");
		});

		it("reads the long date format of the configured language", () => {
			const longDates = {en: "MMMM D, YYYY", de: "D. MMMM YYYY"};
			let locale = "en";
			const moment = () => ({});
			moment.locale = (language) => {
				locale = language;
			};
			moment.localeData = () => ({longDateFormat: () => longDates[locale]});
			const scripts = loadScripts(["WB-clock/WB-clock.js"], {
				moment,
				setInterval: () => 0,
				config: {language: "de", timeFormat: 24}
			});
			const clock = Object.create(scripts.modules["WB-clock"]);
			clock.config = {...clock.defaults};
			clock.start();
			assert.equal(clock.config.dateTimeFormat, "dddd, D. MMMM");
		});

		it("uses a configured date format unchanged", () => {
			const clock = startClock("D. MMMM YYYY", {dateTimeFormat: "YYYY-MM-DD"});
			assert.equal(clock.config.dateTimeFormat, "YYYY-MM-DD");
		});
	});

	describe("dateFormatFromLongDate", () => {
		const clock = loadScripts(["WB-clock/WB-clock.js"]).modules["WB-clock"];
		const derive = (longDateFormat) => clock.dateFormatFromLongDate(longDateFormat);

		it("drops the year together with its separator", () => {
			assert.equal(derive("MMMM D, YYYY"), "dddd, MMMM D");
			assert.equal(derive("D. MMMM YYYY"), "dddd, D. MMMM");
			assert.equal(derive("D MMMM YYYY"), "dddd, D MMMM");
		});

		it("drops a word that joins the year", () => {
			assert.equal(derive("D [de] MMMM [de] YYYY"), "dddd, D [de] MMMM");
			assert.equal(derive("MMMM D. [b.] YYYY"), "dddd, MMMM D.");
		});

		it("drops what follows a trailing year", () => {
			assert.equal(derive("D MMMM YYYY г."), "dddd, D MMMM");
			assert.equal(derive("D. MMMM YYYY."), "dddd, D. MMMM");
		});

		it("drops a leading year up to the month or day", () => {
			assert.equal(derive("YYYY年M月D日"), "dddd, M月D日");
			assert.equal(derive("YYYY. MMMM D."), "dddd, MMMM D.");
			assert.equal(derive("YYYY [m.] MMMM D [d.]"), "dddd, MMMM D [d.]");
			assert.equal(derive("YYYY оны MMMMын D"), "dddd, MMMMын D");
		});

		it("keeps an ending glued to the month", () => {
			assert.equal(derive("Do MMMM[ta] YYYY"), "dddd, Do MMMM[ta]");
			assert.equal(derive("Do MMMM[a] YYYY[an]"), "dddd, Do MMMM[a]");
		});

		it("keeps a long date format without a year", () => {
			assert.equal(derive("D MMMM"), "dddd, D MMMM");
		});
	});
});
