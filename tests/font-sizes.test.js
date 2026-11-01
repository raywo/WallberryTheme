const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const STYLESHEETS = [
	"css/WallberryTheme.css",
	"WB-clock/WB-clock.css",
	"WB-weather/css/classic-wallberry.css"
];

// Pixel values that belong to the screen and the photo, not to the text,
// and so keep their size whatever --wb-font-size is.
const FIXED = {
	"css/WallberryTheme.css": [
		"margin: 60px",
		"text-shadow: -1px 2px 2px rgba(0, 0, 0, 0.6)",
		"min-height: 250px",
		"top: 0px",
		"bottom: 0px",
		"margin-right: 60px"
	],
	"WB-clock/WB-clock.css": [],
	"WB-weather/css/classic-wallberry.css": []
};

const BASE = "var(--wb-font-size, 27px)";
const SCALED = /calc\(var\(--wb-font-size, 27px\) \* -?\d+ \/ 27\)/g;

/**
 * Returns the declarations of a stylesheet as "property: value" strings.
 */
function declarations(file) {
	const css = fs.readFileSync(path.join(REPO_ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	return [...css.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)].map((match) => `${match[1]}: ${match[2].trim()}`);
}

/**
 * Returns a declaration with the values derived from --wb-font-size removed.
 */
function withoutScaledValues(declaration) {
	return declaration.replace(SCALED, "").replaceAll(BASE, "");
}

describe("sizes follow --wb-font-size", () => {
	for (const file of STYLESHEETS) {
		it(`derives every font size in ${file} from --wb-font-size`, () => {
			const sizes = declarations(file).filter((declaration) => declaration.startsWith("font-size:"));
			assert.ok(sizes.length > 0);
			for (const size of sizes) {
				assert.equal(withoutScaledValues(size), "font-size: ", `${size} does not follow --wb-font-size`);
			}
		});

		it(`keeps only the listed pixel values fixed in ${file}`, () => {
			const fixed = declarations(file).filter((declaration) => /\dpx/.test(withoutScaledValues(declaration)));
			assert.deepEqual(fixed, FIXED[file]);
		});
	}

	it("checks every stylesheet in the repository", () => {
		const css = fs.readdirSync(REPO_ROOT, {recursive: true})
			.map((name) => name.split(path.sep).join("/"))
			.filter((name) => name.endsWith(".css") && !name.startsWith("tmp/") && !name.startsWith("node_modules/"));
		assert.deepEqual(css.sort(), [...STYLESHEETS].sort());
	});
});
