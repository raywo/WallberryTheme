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

/**
 * Stands in for the browser's XMLHttpRequest: records the listeners and
 * the request, and lets a test answer it.
 */
class FakeXMLHttpRequest {
	constructor() {
		this.listeners = {};
		this.headers = {};
		FakeXMLHttpRequest.last = this;
	}
	addEventListener(type, listener) {
		this.listeners[type] = listener;
	}
	open(method, url) {
		this.url = url;
	}
	setRequestHeader() {}
	send() {}
	getResponseHeader(name) {
		return this.headers[name] ?? null;
	}
	respond(status, statusText, responseText, headers = {}) {
		Object.assign(this, {status, statusText, responseText, headers});
		this.listeners.load.call(this);
	}
	fire(type) {
		this.listeners[type].call(this);
	}
}

const PHOTO = {urls: {raw: "https://images.unsplash.com/photo"}, color: "#336699", user: {name: "Jane"}};

/**
 * Creates the WallberryTheme module the way MagicMirror² does, with the
 * DOM update stubbed out and timers recorded instead of run.
 */
function createModule() {
	const timers = [];
	const scripts = loadScripts(["WallberryTheme.js"], {
		XMLHttpRequest: FakeXMLHttpRequest,
		setTimeout: (callback, delay) => {
			timers.push(delay);
			return timers.length;
		}
	});
	const definition = scripts.modules["WallberryTheme"];
	const mod = Object.create(definition);
	mod.config = {...definition.defaults, unsplashAccessKey: "key"};
	mod.updateDom = () => {};
	mod.photos = [];
	mod.processPhoto = (photo) => mod.photos.push(photo);
	return {mod, timers, log: scripts.log};
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
	it("shows the photo of a successful response", () => {
		const {mod, timers} = createModule();
		mod.fetchPhoto();
		FakeXMLHttpRequest.last.respond(200, "OK", JSON.stringify(PHOTO));
		assert.equal(JSON.stringify(mod.photos), JSON.stringify([PHOTO]));
		assert.equal(mod.photoError, null);
		assert.deepEqual(timers, []);
	});

	for (const [status, body] of [[403, "Rate Limit Exceeded"], [502, "<html>Bad Gateway</html>"], [200, "not json"]]) {
		it(`shows an error and schedules the next fetch after a ${status} response that is not JSON`, () => {
			const {mod, timers} = createModule();
			mod.fetchPhoto();
			assert.doesNotThrow(() => FakeXMLHttpRequest.last.respond(status, "", body));
			assert.ok(mod.photoError);
			assert.deepEqual(timers, [mod.config.updateInterval]);
		});
	}

	it("gives up on a request after a timeout and schedules the next fetch", () => {
		const {mod, timers} = createModule();
		mod.fetchPhoto();
		const req = FakeXMLHttpRequest.last;
		assert.equal(req.timeout, mod.requestTimeout);
		req.fire("timeout");
		assert.equal(translateError(EN, mod.photoError), "The Unsplash server did not answer within 30 seconds.");
		assert.deepEqual(timers, [mod.config.updateInterval]);
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
	const definition = scripts.modules["WallberryTheme"];
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
