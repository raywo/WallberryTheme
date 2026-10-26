const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const CSS_FILE = path.join(REPO_ROOT, "css", "WallberryTheme.css");
const FONTS_DIR = path.join(REPO_ROOT, "fonts");

/**
 * Returns the font files the stylesheet loads, as absolute paths.
 */
function referencedFontFiles() {
	const css = fs.readFileSync(CSS_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	return [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
		.map((match) => path.resolve(path.dirname(CSS_FILE), match[1]))
		.filter((file) => file.startsWith(FONTS_DIR + path.sep));
}

describe("bundled fonts", () => {
	it("loads at least one font file from fonts/", () => {
		assert.ok(referencedFontFiles().length > 0);
	});

	it("loads only font files that exist", () => {
		for (const file of referencedFontFiles()) {
			assert.ok(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} is missing`);
		}
	});

	it("ships no font file the stylesheet does not load", () => {
		const referenced = new Set(referencedFontFiles());
		const shipped = fs.readdirSync(FONTS_DIR)
			.filter((name) => name !== "OFL.txt" && !name.startsWith("."))
			.map((name) => path.join(FONTS_DIR, name));
		assert.deepEqual(shipped.filter((file) => !referenced.has(file)), []);
	});
});
