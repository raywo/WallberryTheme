const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {loadScripts} = require("./helpers/load-scripts");

const REPO_ROOT = path.join(__dirname, "..");

function readTranslation(file) {
	return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"));
}

/**
 * Translates an error of the module the way MagicMirror²'s Translator
 * fills a translation's placeholders.
 */
function translateError(translation, error) {
	const variables = error.variables ?? {};
	return translation[error.key].replace(/{([^}]+)}/g, (placeholder, name) => {
		return name in variables ? variables[name] : placeholder;
	});
}

const EN = readTranslation("translations/en.json");

// Keys of MagicMirror²'s core translations (translations/en.json, v2.38.0).
// MagicMirror²'s Translator looks a key up in the core translations before
// the module's fallback file, so a module key from this list shows the
// core text in every language without a module translation.
const CORE_KEYS = [
	"LOADING", "YESTERDAY", "TODAY", "TOMORROW", "RUNNING", "EMPTY", "WEEK",
	"WEEK_SHORT", "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW",
	"SW", "WSW", "W", "WNW", "NW", "NNW", "FEELS", "PRECIP_POP",
	"PRECIP_AMOUNT", "MODULE_CONFIG_CHANGED", "MODULE_CONFIG_ERROR",
	"MODULE_ERROR_MALFORMED_URL", "MODULE_ERROR_NO_CONNECTION",
	"MODULE_ERROR_UNAUTHORIZED", "MODULE_ERROR_RATE_LIMITED",
	"MODULE_ERROR_SERVER_ERROR", "MODULE_ERROR_CLIENT_ERROR",
	"MODULE_ERROR_UNSPECIFIED", "NEWSFEED_NO_ITEMS",
	"NEWSFEED_ARTICLE_UNAVAILABLE", "UPDATE_NOTIFICATION",
	"UPDATE_NOTIFICATION_MODULE", "UPDATE_INFO_SINGLE", "UPDATE_INFO_MULTIPLE",
	"UPDATE_NOTIFICATION_DONE", "UPDATE_NOTIFICATION_ERROR",
	"UPDATE_NOTIFICATION_NEED-RESTART", "ALERT_TITLE", "ALERT_WELCOME"
];

const PHOTO = {urls: {raw: "https://images.unsplash.com/photo"}, color: "#336699", user: {name: "Jane"}};

/**
 * Creates the WallberryTheme module the way MagicMirror² does, with the
 * DOM update stubbed out, timers recorded instead of run and a clock
 * that only moves when `clock.now` is set. `answer` stands in for the
 * network: it returns the Response for a request, or throws the error
 * fetch rejects with.
 */
function createModule(answer = () => new Response(JSON.stringify(PHOTO))) {
	const timers = [];
	const requests = [];
	const clock = {now: 0};
	const scripts = loadScripts(["WallberryTheme.js"], {
		fetch: async (url, options) => {
			requests.push({url, options});
			return answer();
		},
		// Records the timeout instead of starting one
		AbortSignal: {timeout: (milliseconds) => ({timeout: milliseconds})},
		setTimeout: (_callback, delay) => {
			timers.push(delay);
			return timers.length;
		},
		clearTimeout: () => {},
		Date: {now: () => clock.now}
	});
	const definition = scripts.modules.WallberryTheme;
	const mod = Object.create(definition);
	mod.config = {...definition.defaults, unsplashAccessKey: "key"};
	mod.updateDom = () => {};
	mod.photos = [];
	mod.processPhoto = (photo) => mod.photos.push(photo);
	return {mod, timers, requests, clock, log: scripts.log};
}

describe("WallberryTheme parseUnsplashResponse", () => {
	const {mod} = createModule();

	it("returns the photo of a successful response", () => {
		const result = mod.parseUnsplashResponse(200, "OK", JSON.stringify(PHOTO), "49");
		// The photo comes from the scripts' context, so compare its content
		assert.equal(JSON.stringify(result.photo), JSON.stringify(PHOTO));
	});

	it("returns Unsplash's error text of a JSON error response", () => {
		const result = mod.parseUnsplashResponse(401, "Unauthorized", JSON.stringify({errors: ["OAuth error: The access token is invalid"]}), null);
		assert.equal(translateError(EN, result.error), "The Unsplash API returned the error \"OAuth error: The access token is invalid\"");
	});

	it("names the rate limit for a plain-text 403 response", () => {
		const result = mod.parseUnsplashResponse(403, "Forbidden", "Rate Limit Exceeded", null);
		assert.equal(result.error.key, "ERROR_RATE_LIMIT");
	});

	it("names the rate limit when no requests remain", () => {
		const result = mod.parseUnsplashResponse(403, "Forbidden", "", "0");
		assert.equal(result.error.key, "ERROR_RATE_LIMIT");
	});

	it("returns a status error for a body that is not JSON", () => {
		const result = mod.parseUnsplashResponse(502, "Bad Gateway", "<html>Bad Gateway</html>", null);
		assert.equal(translateError(EN, result.error), "Unsplash Error: 502, Bad Gateway");
	});

	it("returns an error for a successful status whose body is not a photo", () => {
		for (const body of ["<html></html>", "null", "42", "{}"]) {
			assert.ok(mod.parseUnsplashResponse(200, "OK", body, null).error, body);
		}
	});
});

describe("WallberryTheme fetchPhoto", () => {
	it("shows the photo of a successful response", async () => {
		const {mod, timers, requests} = createModule();
		await mod.fetchPhoto();
		assert.equal(JSON.stringify(mod.photos), JSON.stringify([PHOTO]));
		assert.equal(mod.photoError, null);
		assert.deepEqual(timers, []);
		assert.equal(requests[0].options.headers["Accept-Version"], "v1");
	});

	for (const [status, body] of [[403, "Rate Limit Exceeded"], [502, "<html>Bad Gateway</html>"], [200, "not json"]]) {
		it(`shows an error and schedules the next fetch after a ${status} response that is not JSON`, async () => {
			const {mod, timers} = createModule(() => new Response(body, {status}));
			await mod.fetchPhoto();
			assert.ok(mod.photoError);
			assert.deepEqual(timers, [mod.config.updateInterval]);
		});
	}

	it("names the rate limit from the response header", async () => {
		const {mod} = createModule(() => new Response("", {status: 403, headers: {"X-Ratelimit-Remaining": "0"}}));
		await mod.fetchPhoto();
		assert.equal(mod.photoError.key, "ERROR_RATE_LIMIT");
	});

	it("gives up on a request after a timeout and schedules the next fetch", async () => {
		const {mod, timers, requests} = createModule(() => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		await mod.fetchPhoto();
		assert.equal(requests[0].options.signal.timeout, mod.requestTimeout);
		assert.equal(translateError(EN, mod.photoError), "The Unsplash server did not answer within 30 seconds.");
		assert.deepEqual(timers, [mod.config.updateInterval]);
	});

	it("shows a connection error when Unsplash does not answer and schedules the next fetch", async () => {
		const {mod, timers} = createModule(() => {
			throw new TypeError("Failed to fetch");
		});
		await mod.fetchPhoto();
		assert.equal(mod.photoError.key, "ERROR_CONNECTION");
		assert.deepEqual(timers, [mod.config.updateInterval]);
	});
});

describe("WallberryTheme resume", () => {
	const INTERVAL = 300 * 1000;

	/**
	 * Creates the module with the given config, a photo shown at time 0
	 * whose next fetch is due one updateInterval later, and the tints it
	 * sets recorded. `answer` stands in for the network as in
	 * createModule().
	 */
	function createShowingModule(config = {}, answer = undefined) {
		const created = createModule(answer);
		const {mod} = created;
		mod.config = {...mod.config, updateInterval: INTERVAL, ...config};
		mod.tints = [];
		mod.setBackgroundTint = (swatch) => mod.tints.push(swatch);
		mod.photoData = {color: "#336699"};
		mod.scheduleFetch(INTERVAL);
		created.timers.length = 0;
		return created;
	}

	it("fetches a new photo on resume with newPhotoOnResume: true", () => {
		const {mod, requests} = createShowingModule({newPhotoOnResume: true});
		mod.resume();
		assert.equal(requests.length, 1);
	});

	it("keeps the photo and its tint by default", () => {
		const {mod, requests, clock, timers} = createShowingModule();
		clock.now = 100 * 1000;
		mod.resume();
		assert.equal(requests.length, 0);
		assert.deepEqual(mod.tints, ["#336699"]);
		assert.deepEqual(timers, [INTERVAL - 100 * 1000]);
	});

	it("fetches right away when the photo is due by the time the module resumes", () => {
		for (const hidden of [INTERVAL, 2 * INTERVAL]) {
			const {mod, requests, clock, timers} = createShowingModule({newPhotoOnResume: false});
			clock.now = hidden;
			mod.resume();
			assert.equal(requests.length, 1, `${hidden}`);
			assert.deepEqual(timers, [], `${hidden}`);
		}
	});

	it("leaves the next fetch to a fetch that is still running", () => {
		const {mod, requests, timers} = createShowingModule({newPhotoOnResume: false}, () => new Promise(() => {}));
		mod.fetchPhoto();
		mod.resume();
		assert.equal(requests.length, 1);
		assert.deepEqual(timers, []);
	});

	it("takes the due time from when the photo loaded", () => {
		const {mod} = createModuleWithDocument();
		const before = Date.now();
		mod.processPhoto(PHOTO);
		mod.img.onload();
		assert.ok(mod.nextFetchTime >= before + mod.config.updateInterval);
		assert.ok(mod.nextFetchTime <= Date.now() + mod.config.updateInterval);
	});

	it("retries after an error at the scheduled time and sets no tint without a photo", () => {
		const {mod, timers, clock, requests} = createShowingModule({newPhotoOnResume: false});
		mod.photoData = null;
		mod.processError({key: "ERROR_CONNECTION"});
		timers.length = 0;
		clock.now = 60 * 1000;
		mod.resume();
		assert.deepEqual(mod.tints, []);
		assert.equal(requests.length, 0);
		assert.deepEqual(timers, [INTERVAL - 60 * 1000]);
	});
});

describe("WallberryTheme translations", () => {
	const {mod} = createModule();
	const files = mod.getTranslations();

	it("lists English first, so that MagicMirror² falls back to it", () => {
		assert.equal(Object.keys(files)[0], "en");
		assert.ok(files.de);
	});

	it("translates every key into every language", () => {
		for (const file of Object.values(files)) {
			assert.deepEqual(Object.keys(readTranslation(file)).sort(), Object.keys(EN).sort(), file);
		}
	});

	it("uses no key of MagicMirror²'s core translations", () => {
		for (const key of Object.keys(EN)) {
			assert.ok(!CORE_KEYS.includes(key), key);
		}
	});

	it("keeps the placeholders of each English text", () => {
		const placeholders = (text) => (text.match(/{[^}]+}/g) ?? []).sort();
		for (const file of Object.values(files)) {
			const translation = readTranslation(file);
			for (const key of Object.keys(EN)) {
				assert.deepEqual(placeholders(translation[key]), placeholders(EN[key]), `${file} ${key}`);
			}
		}
	});

	it("has a text for every key the module and its template use", () => {
		const sources = ["WallberryTheme.js", "WallberryTheme.njk"]
			.map((file) => fs.readFileSync(path.join(REPO_ROOT, file), "utf8"))
			.join("\n");
		const used = [...sources.matchAll(/"((?:ERROR|PHOTO|LOADING)[A-Z_]*)"/g)].map((match) => match[1]);
		assert.ok(used.length > 0);
		for (const key of used) {
			assert.ok(key in EN, key);
		}
	});
});

/**
 * Stands in for an element's style: records the properties set on it.
 */
class FakeStyle {
	constructor() {
		this.properties = {};
	}
	setProperty(name, value) {
		this.properties[name] = value;
	}
	removeProperty(name) {
		delete this.properties[name];
	}
}

/**
 * Creates the WallberryTheme module with a document whose html and body
 * record their styles, and a photo element that loads at once.
 */
function createModuleWithDocument() {
	const html = {style: new FakeStyle()};
	const body = {style: new FakeStyle()};
	const scripts = loadScripts(["WallberryTheme.js"], {
		document: {
			documentElement: html,
			body: body,
			createElement: () => ({style: {}})
		},
		window: {innerWidth: 1080, innerHeight: 1920},
		setTimeout: () => 1,
		clearTimeout: () => {}
	});
	const definition = scripts.modules.WallberryTheme;
	const mod = Object.create(definition);
	mod.config = {...definition.defaults, unsplashAccessKey: "key", autoDimOn: false};
	mod.updateDom = () => {};
	return {mod, html, body};
}

describe("WallberryTheme background tint", () => {
	it("keeps the photo's colour swatch for the tints", () => {
		const {mod} = createModuleWithDocument();
		mod.processPhoto(PHOTO);
		assert.equal(mod.photoData.color, "#336699");
	});

	it("tints the background with the swatch", () => {
		const {mod, html, body} = createModuleWithDocument();
		mod.setBackgroundTint("#336699");
		assert.equal(html.style.properties["--wb-swatch"], "#336699");
		assert.equal(html.style.backgroundColor, "var(--wb-tint-dark)");
		assert.equal(body.style.backgroundColor, "var(--wb-tint-dark)");
	});

	it("resets the background to black on suspend", () => {
		const {mod, html, body} = createModuleWithDocument();
		mod.setBackgroundTint("#336699");
		mod.suspend();
		assert.equal(html.style.properties["--wb-swatch"], undefined);
		assert.equal(html.style.backgroundColor, "black");
		assert.equal(body.style.backgroundColor, "black");
	});
});

describe("WallberryTheme auto-dim", () => {
	/**
	 * Creates the WallberryTheme module on a 1080 × 1920 screen whose bar
	 * regions are barHeight px high and sit 60 px from the top and bottom
	 * edge, with WBColor replaced by a recorder that answers dim.
	 */
	function createModuleWithBars(config, barHeight = 100, dim = true) {
		const calls = [];
		const scripts = loadScripts(["WallberryTheme.js"], {
			document: {
				createElement: () => ({style: {}}),
				getElementsByClassName: (name) => {
					const top = name === "region top bar" ? 60 : 1920 - 60 - barHeight;
					return [{
						clientHeight: barHeight,
						getBoundingClientRect: () => ({top: top, bottom: top + barHeight})
					}];
				}
			},
			window: {innerWidth: 1080, innerHeight: 1920},
			setTimeout: () => 1,
			clearTimeout: () => {},
			WBColor: {
				needsDimming: (_img, bars) => {
					calls.push(bars);
					return dim;
				}
			}
		});
		const definition = scripts.modules.WallberryTheme;
		const mod = Object.create(definition);
		mod.config = {...definition.defaults, unsplashAccessKey: "key", ...config};
		mod.updateDom = () => {};
		return {mod, calls};
	}

	function loadPhoto(mod, height = 1920) {
		mod.processPhoto(PHOTO);
		mod.img.naturalHeight = height;
		mod.img.onload();
	}

	it("dims the photo by the contrast behind both bars, under the whole fades", () => {
		const {mod, calls} = createModuleWithBars({});
		loadPhoto(mod);
		assert.equal(mod.photoData.needsDimming, true);
		assert.equal(calls.length, 1);
		assert.equal(JSON.stringify(calls[0]), JSON.stringify([
			{start: 60 / 1920, end: 160 / 1920, fade: "top", fadeStart: 0, fadeEnd: 250 / 1920},
			{start: 1760 / 1920, end: 1860 / 1920, fade: "bottom", fadeStart: 1670 / 1920, fadeEnd: 1}
		]));
	});

	it("measures a fade taller than its minimum height with the bar's margin", () => {
		const {mod, calls} = createModuleWithBars({}, 330);
		loadPhoto(mod);
		assert.equal(JSON.stringify(calls[0]), JSON.stringify([
			{start: 60 / 1920, end: 390 / 1920, fade: "top", fadeStart: 0, fadeEnd: 400 / 1920},
			{start: 1530 / 1920, end: 1860 / 1920, fade: "bottom", fadeStart: 1520 / 1920, fadeEnd: 1}
		]));
	});

	it("measures the bars in rows of a photo taller than the screen", () => {
		const {mod, calls} = createModuleWithBars({addBackgroundFade: ["bottom"]});
		loadPhoto(mod, 3840);
		assert.equal(JSON.stringify(calls[0]), JSON.stringify([
			{start: 60 / 3840, end: 160 / 3840, fade: null, fadeStart: 0, fadeEnd: 250 / 3840},
			{start: 1760 / 3840, end: 1860 / 3840, fade: "bottom", fadeStart: 1670 / 3840, fadeEnd: 1920 / 3840}
		]));
	});

	it("does not check the photo with autoDimOn: false", () => {
		const {mod, calls} = createModuleWithBars({autoDimOn: false});
		loadPhoto(mod);
		assert.equal(calls.length, 0);
		assert.ok(!mod.photoData.needsDimming);
	});

	it("shows a dimmed photo at brightImageOpacity, any other at backgroundOpacity", () => {
		const template = fs.readFileSync(path.join(REPO_ROOT, "WallberryTheme.njk"), "utf8");
		assert.match(template, /opacity: {{ config\.brightImageOpacity if photoData\.needsDimming else config\.backgroundOpacity }}/);
	});

	it("keeps the fades' minimum height in step with the styles", () => {
		const css = fs.readFileSync(path.join(REPO_ROOT, "css/WallberryTheme.css"), "utf8");
		const {mod} = createModuleWithBars({});
		assert.match(css, new RegExp(`\\.wbfade \\{[^}]*min-height: ${mod.fadeMinHeight}px;`));
	});
});

describe("WallberryTheme tint styles", () => {
	const css = fs.readFileSync(path.join(REPO_ROOT, "css/WallberryTheme.css"), "utf8");
	const supportsStart = css.indexOf("@supports (color: oklch(from red l c h))");
	const definedNames = (text) => [...text.matchAll(/(--wb-tint-[a-z-]+):/g)].map((match) => match[1]).sort();

	it("derives every tint from the swatch where relative colour syntax works", () => {
		assert.ok(supportsStart >= 0);
		const supported = css.slice(supportsStart, css.indexOf("\n}", supportsStart));
		const tints = [...supported.matchAll(/--wb-tint-[a-z-]+: (.*);/g)].map((match) => match[1]);
		assert.ok(tints.length > 0);
		for (const tint of tints) {
			assert.match(tint, /^oklch\(from var\(--wb-swatch\) /, tint);
		}
	});

	it("gives every tint a fallback for browsers without relative colour syntax", () => {
		const fallback = css.slice(0, supportsStart);
		const supported = css.slice(supportsStart, css.indexOf("\n}", supportsStart));
		assert.deepEqual(definedNames(fallback), definedNames(supported));
	});

	it("falls back to the neutral tints in the fades when there is no swatch", () => {
		const neutral = Object.fromEntries([...css.slice(0, supportsStart).matchAll(/(--wb-tint-[a-z-]+): (.*);/g)].map((match) => [match[1], match[2]]));
		const fades = css.slice(css.indexOf(".topfade"), css.indexOf(".light"));
		const uses = [...fades.matchAll(/var\((--wb-tint-[a-z-]+)(?:, ([^()]*(?:\([^()]*\))?))?\)/g)];
		assert.ok(uses.length > 0);
		for (const [use, name, fallback] of uses) {
			assert.equal(fallback, neutral[name], use);
		}
	});

	it("defines every tint the styles and the module use", () => {
		const module = fs.readFileSync(path.join(REPO_ROOT, "WallberryTheme.js"), "utf8");
		const used = [...(css + module).matchAll(/var\((--wb-tint-[a-z-]+)[,)]/g)].map((match) => match[1]);
		assert.ok(used.length > 0);
		for (const name of used) {
			assert.ok(definedNames(css.slice(0, supportsStart)).includes(name), name);
		}
	});
});
