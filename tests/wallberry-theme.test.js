const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const {loadScripts} = require("./helpers/load-scripts");

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
		assert.equal(result.error, "The Unsplash API returned the error \"OAuth error: The access token is invalid\"");
	});

	it("names the rate limit for a plain-text 403 response", () => {
		const result = mod.parseUnsplashResponse(403, "Forbidden", "Rate Limit Exceeded", null);
		assert.match(result.error, /rate limit/i);
	});

	it("names the rate limit when no requests remain", () => {
		const result = mod.parseUnsplashResponse(403, "Forbidden", "", "0");
		assert.match(result.error, /rate limit/i);
	});

	it("returns a status error for a body that is not JSON", () => {
		const result = mod.parseUnsplashResponse(502, "Bad Gateway", "<html>Bad Gateway</html>", null);
		assert.equal(result.error, "Unsplash Error: 502, Bad Gateway");
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
		assert.match(mod.photoError, /did not answer/);
		assert.deepEqual(timers, [mod.config.updateInterval]);
	});
});
