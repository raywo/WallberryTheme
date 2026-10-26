const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const {loadScripts} = require("./helpers/load-scripts");

describe("WB-clock", () => {
	it("takes its default time format from the MagicMirror config", () => {
		const scripts = loadScripts(["WB-clock/WB-clock.js"], {
			config: {language: "en", timeFormat: 12}
		});
		assert.equal(scripts.modules["WB-clock"].defaults.timeFormat, 12);
	});
});
