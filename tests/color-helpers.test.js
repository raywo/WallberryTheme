const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {loadScripts} = require("./helpers/load-scripts");

const REPO_ROOT = path.join(__dirname, "..");

const WBColor = loadScripts(["colorHelpers.js"]).get("WBColor");

const WIDTH = 36;
const HEIGHT = 64;

/**
 * Creates the RGBA pixels of an image whose colour depends on the row.
 *
 * @param {function(number): number[]} colorAt - [r, g, b] for a row, by its position from 0 (top) to 1 (bottom)
 */
function pixels(colorAt, width = WIDTH, height = HEIGHT) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const color = colorAt((y + 0.5) / height);
		for (let x = 0; x < width; x++) {
			data.set([...color, 255], (y * width + x) * 4);
		}
	}
	return data;
}

const DARK = [20, 25, 30];
const BRIGHT = [235, 235, 225];
const DEEP_BLUE = [0, 0, 200];

/** The areas behind the bars, a sixth of the image each. */
function bars(fades = {top: null, bottom: null}) {
	return [
		{start: 0, end: 1 / 6, fade: fades.top},
		{start: 5 / 6, end: 1, fade: fades.bottom}
	];
}

const WITH_FADES = {top: "top", bottom: "bottom"};

describe("WBColor barsNeedDimming", () => {
	it("dims a photo with a dark top and a bright bottom", () => {
		const data = pixels((y) => (y < 0.5 ? DARK : BRIGHT));
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, bars()), true);
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, bars(WITH_FADES)), true);
	});

	it("leaves a photo with a bright middle and dark bars alone", () => {
		const data = pixels((y) => (y > 0.25 && y < 0.75 ? BRIGHT : DARK));
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, bars()), false);
	});

	it("leaves a photo of saturated dark colours alone", () => {
		const data = pixels(() => DEEP_BLUE);
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, bars()), false);
	});

	/** A dark photo with a bright patch over the given share of the top bar's width. */
	function withPatch(share) {
		const data = pixels(() => DARK);
		for (let y = 0; y < Math.ceil(HEIGHT / 6); y++) {
			for (let x = 0; x < Math.round(WIDTH * share); x++) {
				data.set(BRIGHT, (y * WIDTH + x) * 4);
			}
		}
		return data;
	}

	it("dims a dark bar with a bright patch behind more than a tenth of it", () => {
		assert.equal(WBColor.barsNeedDimming(withPatch(0.15), WIDTH, HEIGHT, bars()), true);
	});

	it("leaves a dark bar with a small bright patch alone", () => {
		assert.equal(WBColor.barsNeedDimming(withPatch(0.05), WIDTH, HEIGHT, bars()), false);
	});

	it("measures the photo under the fade", () => {
		// bright only in the lower part of the bottom bar, where its fade is darkest
		const data = pixels((y) => (y > 0.95 ? BRIGHT : DARK));
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, bars()), true);
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, bars(WITH_FADES)), false);
	});

	it("measures a bar that reaches past the photo under the part of the fade over the photo", () => {
		// the bar runs from 0.8 to 1.2 of the image height, so only the
		// lighter upper half of its fade lies over the photo
		const data = pixels((y) => (y > 0.9 ? BRIGHT : DARK));
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, [{start: 0.8, end: 1.2, fade: "bottom"}]), true);
	});

	it("measures only the rows behind a bar, under the part of the fade over them", () => {
		// a 1920 px screen with a 100 px bar 60 px below the top and above
		// the bottom, under fades 250 px high; white text there reads well
		// on a mid grey, while the whole fade's area would be too bright
		const data = pixels(() => [150, 150, 150]);
		const screen = (px) => px / 1920;
		const behindBars = [
			{start: screen(60), end: screen(160), fade: "top", fadeStart: 0, fadeEnd: screen(250)},
			{start: screen(1760), end: screen(1860), fade: "bottom", fadeStart: screen(1670), fadeEnd: 1}
		];
		const wholeFades = [
			{start: 0, end: screen(250), fade: "top"},
			{start: screen(1670), end: 1, fade: "bottom"}
		];
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, behindBars), false);
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, wholeFades), true);
	});

	it("ignores a bar without rows", () => {
		const data = pixels(() => BRIGHT);
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, [{start: 0.1, end: 0.1, fade: null}]), false);
	});

	it("ignores an area outside the image", () => {
		const data = pixels(() => BRIGHT);
		assert.equal(WBColor.barsNeedDimming(data, WIDTH, HEIGHT, [{start: 1.1, end: 1.3, fade: null}]), false);
	});
});

describe("WBColor contrastAPCA", () => {
	// Reference values of the README of github.com/Myndex/apca-w3
	it("matches the APCA reference values for white text", () => {
		assert.ok(Math.abs(WBColor.contrastAPCA([255, 255, 255], [0, 0, 0]) - -107.88) < 0.01);
		assert.ok(Math.abs(WBColor.contrastAPCA([255, 255, 255], [136, 136, 136]) - -68.54) < 0.01);
		assert.equal(WBColor.contrastAPCA([255, 255, 255], [255, 255, 255]), 0);
	});

	it("matches the APCA reference values for dark text on a light background", () => {
		assert.ok(Math.abs(WBColor.contrastAPCA([0, 0, 0], [255, 255, 255]) - 106.04) < 0.01);
		assert.ok(Math.abs(WBColor.contrastAPCA([136, 136, 136], [255, 255, 255]) - 63.06) < 0.01);
	});
});

describe("WBColor needsDimming", () => {
	/**
	 * A document whose canvas draws a photo of the given pixel colours,
	 * scaled to the canvas size, and records what is read from it.
	 */
	function documentWithCanvas(colorAt) {
		const reads = [];
		const document = {
			createElement: () => {
				const canvas = {
					getContext: () => ({
						drawImage: (img, x, y, width, height) => {
							canvas.drawn = {width, height};
						},
						getImageData: (x, y, width, height) => {
							reads.push({width, height});
							return {data: pixels(colorAt, width, height)};
						}
					})
				};
				return canvas;
			}
		};
		return {document, reads};
	}

	function load(colorAt) {
		const {document, reads} = documentWithCanvas(colorAt);
		return {WBColor: loadScripts(["colorHelpers.js"], {document}).get("WBColor"), reads};
	}

	it("reads no more than a few thousand pixels of a full HD photo", () => {
		const {WBColor, reads} = load(() => BRIGHT);
		assert.equal(WBColor.needsDimming({naturalWidth: 1080, naturalHeight: 1920}, bars()), true);
		const read = reads.reduce((sum, area) => sum + area.width * area.height, 0);
		assert.ok(read > 0 && read <= 4096, `read ${read} pixels`);
		assert.deepEqual(reads, [{width: 36, height: 64}]);
	});

	it("keeps the size of a photo smaller than the sample", () => {
		const {WBColor, reads} = load(() => DARK);
		assert.equal(WBColor.needsDimming({naturalWidth: 20, naturalHeight: 30}, bars()), false);
		assert.deepEqual(reads, [{width: 20, height: 30}]);
	});
});

describe("WBColor fades", () => {
	const css = fs.readFileSync(path.join(REPO_ROOT, "css/WallberryTheme.css"), "utf8");
	const neutral = css.slice(0, css.indexOf("@supports"));

	it("models the top fade with the neutral grey of the CSS", () => {
		assert.match(neutral, /--wb-tint-dark-fade: rgba\(15, 15, 15, 0\.7\);/);
		assert.deepEqual([...WBColor.FADES.top.color], [15, 15, 15]);
		assert.equal(WBColor.FADES.top.alpha(0), 0.7);
		assert.equal(WBColor.FADES.top.alpha(1), 0);
	});

	it("models the bottom fade as a fade to black", () => {
		assert.match(css, /\.bottomfade \{[^}]*linear-gradient\(var\(--wb-tint-light-fade[^)]*\)\), black\)/);
		assert.match(neutral, /--wb-tint-light-fade: rgba\([^)]*, 0\);/);
		assert.deepEqual([...WBColor.FADES.bottom.color], [0, 0, 0]);
		assert.equal(WBColor.FADES.bottom.alpha(0), 0);
		assert.equal(WBColor.FADES.bottom.alpha(1), 1);
	});
});
