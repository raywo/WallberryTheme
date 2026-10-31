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
 * fetch rejects with. `pending` holds the ids of the timers not cleared.
 * `globals` adds or replaces globals, e.g. a `localStorage`.
 */
function createModule(answer = () => new Response(JSON.stringify(PHOTO)), globals = {}) {
	const timers = [];
	const pending = new Set();
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
			pending.add(timers.length);
			return timers.length;
		},
		clearTimeout: (id) => pending.delete(id),
		Date: {now: () => clock.now},
		document: {createElement: () => ({style: {}})},
		window: {innerWidth: 1080, innerHeight: 1920},
		...globals
	});
	const definition = scripts.modules.WallberryTheme;
	const mod = Object.create(definition);
	mod.config = {...definition.defaults, unsplashAccessKey: "key"};
	mod.updateDom = () => {};
	mod.photos = [];
	mod.processPhoto = (photo) => mod.photos.push(photo);
	return {mod, timers, pending, requests, clock, log: scripts.log};
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

describe("WallberryTheme photoSource", () => {
	const {mod} = createModule();
	mod.config = {...mod.config, queries: ["mountains"], collections: "1538150"};
	const source = (payload) => JSON.parse(JSON.stringify(mod.photoSource(payload)));

	it("uses the configured queries and collections without a payload", () => {
		for (const payload of [undefined, null, {}, "text", {queries: null, collections: undefined}]) {
			assert.deepEqual(source(payload), {queries: ["mountains"], collections: "1538150"}, JSON.stringify(payload));
		}
	});

	it("replaces both configured values with a payload that names queries", () => {
		assert.deepEqual(source({queries: ["sports", "football"]}), {queries: ["sports", "football"], collections: ""});
	});

	it("replaces both configured values with a payload that names collections", () => {
		assert.deepEqual(source({collections: "162213"}), {queries: [], collections: "162213"});
	});

	it("takes both from a payload that names both", () => {
		assert.deepEqual(source({queries: ["sports"], collections: "162213"}), {queries: ["sports"], collections: "162213"});
	});

	it("accepts a single query as a string", () => {
		assert.deepEqual(source({queries: "sports"}), {queries: ["sports"], collections: ""});
	});
});

describe("WallberryTheme WALLBERRY_FETCH_PHOTO notification", () => {
	const INTERVAL = 300 * 1000;

	function createConfiguredModule(answer = undefined) {
		const created = createModule(answer);
		created.mod.config = {...created.mod.config, updateInterval: INTERVAL, queries: ["mountains"], collections: "1538150"};
		return created;
	}

	it("fetches right away with the payload's query instead of the configured values", () => {
		const {mod, requests} = createConfiguredModule();
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]}, {name: "MMM-pages"});
		assert.equal(requests.length, 1);
		const url = new URL(requests[0].url);
		assert.equal(url.searchParams.get("query"), "sports");
		assert.equal(url.searchParams.get("collections"), "");
	});

	it("fetches with the configured values without a payload", () => {
		const {mod, requests} = createConfiguredModule();
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", undefined, {name: "MMM-pages"});
		const url = new URL(requests[0].url);
		assert.equal(url.searchParams.get("query"), "mountains");
		assert.equal(url.searchParams.get("collections"), "1538150");
	});

	it("ignores other notifications", () => {
		const {mod, requests} = createConfiguredModule();
		mod.notificationReceived("FETCH_PHOTO", {queries: ["sports"]}, {name: "other"});
		mod.notificationReceived("DOM_OBJECTS_CREATED");
		assert.equal(requests.length, 0);
	});

	it("schedules the next automatic change a full updateInterval later, with one pending timer", async () => {
		const {mod, timers, pending, clock} = createConfiguredModule();
		mod.config.autoDimOn = false;
		delete mod.processPhoto; // use the module's own, which schedules the next fetch
		mod.scheduleFetch(INTERVAL);
		clock.now = 200 * 1000;
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		assert.equal(pending.size, 0);
		await new Promise(setImmediate);
		mod.img.onload();
		assert.deepEqual(timers, [INTERVAL, INTERVAL]);
		assert.equal(pending.size, 1);
		assert.equal(mod.nextFetchTime, 200 * 1000 + INTERVAL);
	});

	it("shows only the photo of the latest of several quick requests", async () => {
		const answers = [];
		const {mod, timers} = createConfiguredModule(() => new Promise((resolve) => answers.push(resolve)));
		const older = mod.fetchPhoto(mod.photoSource({queries: ["sports"]}));
		const newer = mod.fetchPhoto(mod.photoSource({queries: ["news"]}));
		await new Promise(setImmediate);
		answers[1](new Response(JSON.stringify({...PHOTO, user: {name: "Newer"}})));
		await newer;
		answers[0](new Response(JSON.stringify({...PHOTO, user: {name: "Older"}})));
		await older;
		assert.deepEqual(mod.photos.map((photo) => photo.user.name), ["Newer"]);
		assert.deepEqual(timers, []);
	});

	it("ignores an error of an older request", async () => {
		const answers = [];
		const {mod, timers} = createConfiguredModule(() => new Promise((resolve, reject) => answers.push({resolve, reject})));
		const older = mod.fetchPhoto();
		const newer = mod.fetchPhoto(mod.photoSource({queries: ["news"]}));
		await new Promise(setImmediate);
		answers[1].resolve(new Response(JSON.stringify(PHOTO)));
		await newer;
		answers[0].reject(new TypeError("Failed to fetch"));
		await older;
		assert.equal(mod.photoError, null);
		assert.deepEqual(timers, []);
	});

	it("ignores a photo of an older request that is still loading", async () => {
		const {mod} = createConfiguredModule();
		mod.config.autoDimOn = false;
		delete mod.processPhoto; // use the module's own
		mod.updateDom = () => {};
		await mod.fetchPhoto();
		const older = mod.img;
		const newer = mod.fetchPhoto(mod.photoSource({queries: ["news"]}));
		older.onload();
		assert.equal(mod.photoElement, null);
		await newer;
		mod.img.onload();
		assert.equal(mod.photoElement, mod.img);
	});

	it("waits for Electron's cache to be cleared and then fetches with the payload", () => {
		const {mod, requests} = createConfiguredModule();
		mod.sendSocketNotification = () => {};
		mod.start();
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		assert.equal(requests.length, 0);
		mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		assert.equal(requests.length, 1);
		assert.equal(new URL(requests[0].url).searchParams.get("query"), "sports");
	});

	it("fetches with the payload once a hidden module is shown again", () => {
		const {mod, requests} = createConfiguredModule();
		mod.setBackgroundTint = () => {};
		mod.suspend();
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		assert.equal(requests.length, 0);
		mod.resume();
		assert.equal(requests.length, 1);
		assert.equal(new URL(requests[0].url).searchParams.get("query"), "sports");
		mod.suspend();
		mod.resume();
		assert.equal(requests.length, 1);
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

	it("schedules the next fetch when the photo fails to load", async () => {
		const {mod, requests, timers, clock} = createShowingModule();
		delete mod.processPhoto; // use the module's own
		await mod.fetchPhoto();
		mod.img.onerror();
		mod.suspend();
		clock.now = 100 * 1000;
		mod.resume();
		assert.equal(requests.length, 1);
		assert.deepEqual(timers, [INTERVAL, INTERVAL - 100 * 1000]);
	});

	it("keeps the shown photo, its tint and its author when the next photo fails to load", () => {
		const {mod} = createShowingModule({autoDimOn: false});
		delete mod.processPhoto; // use the module's own
		const shown = {urls: {raw: "https://images.unsplash.com/shown?x"}, color: "#aa0000", user: {name: "Alice"}};
		const failed = {urls: {raw: "https://images.unsplash.com/failed?x"}, color: "#0000bb", user: {name: "Bob"}};
		mod.processPhoto(shown);
		mod.img.onload();
		mod.processPhoto(failed);
		mod.img.onerror();
		const data = mod.getTemplateData();
		assert.equal(data.photoData.authorName, "Alice");
		assert.match(data.photoElement.src, /\/shown\?/);
		mod.suspend();
		mod.resume();
		assert.equal(mod.tints.at(-1), "#aa0000");
	});

	it("ignores a photo that finishes loading after a newer one started", () => {
		const {mod, timers} = createShowingModule({autoDimOn: false});
		delete mod.processPhoto; // use the module's own
		mod.processPhoto({...PHOTO, user: {name: "Alice"}});
		const older = mod.img;
		mod.processPhoto({...PHOTO, user: {name: "Bob"}});
		mod.img.onload();
		older.onload();
		older.onerror();
		assert.equal(mod.photoData.authorName, "Bob");
		assert.equal(mod.photoElement, mod.img);
		assert.deepEqual(timers, [INTERVAL]);
	});

	it("starts no timer while suspended and leaves it to resume", async () => {
		const {mod, timers, clock} = createShowingModule({autoDimOn: false});
		delete mod.processPhoto; // use the module's own
		const fetching = mod.fetchPhoto();
		mod.suspend();
		await fetching;
		mod.img.onload();
		assert.deepEqual(timers, []);
		clock.now = 100 * 1000;
		mod.resume();
		assert.deepEqual(timers, [INTERVAL - 100 * 1000]);
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

/**
 * Stands in for the browser's localStorage. With `failing`, every access
 * throws, as in a browser that blocks storage.
 */
class FakeStorage {
	constructor(failing = false) {
		this.items = new Map();
		this.failing = failing;
	}
	check() {
		if (this.failing) {
			throw new DOMException("The operation is insecure.", "SecurityError");
		}
	}
	getItem(key) {
		this.check();
		return this.items.has(key) ? this.items.get(key) : null;
	}
	setItem(key, value) {
		this.check();
		this.items.set(key, String(value));
	}
	removeItem(key) {
		this.check();
		this.items.delete(key);
	}
}

describe("WallberryTheme stored photo", () => {
	const INTERVAL = 300 * 1000;
	const STORED = {url: "https://images.unsplash.com/stored?w=1080", color: "#aa0000", authorName: "Alice", needsDimming: true};

	/**
	 * Creates the module the way a restart finds it: with storage holding
	 * `stored` and the module's own processPhoto(). WBColor is left out,
	 * so a check of the image for dimming fails the test. `answer`
	 * stands in for the network as in createModule(). With `storage: null`
	 * the browser has no localStorage.
	 */
	function createRestartedModule({config = {}, stored = null, storage = new FakeStorage(), answer = undefined} = {}) {
		const created = createModule(answer, storage === null ? {} : {localStorage: storage});
		const {mod} = created;
		mod.config = {...mod.config, updateInterval: INTERVAL, clearCacheOnStart: false, queries: ["mountains"], ...config};
		delete mod.processPhoto; // use the module's own
		if (stored !== null) {
			storage.setItem(mod.storageKey, JSON.stringify({settings: mod.photoSettings(), ...stored}));
		}
		return {...created, storage};
	}

	function storedRecord(storage, mod) {
		const text = storage.getItem(mod.storageKey);
		return text === null ? null : JSON.parse(text);
	}

	it("shows the stored photo with its tint, author and dimming without an Unsplash request", () => {
		const {mod, requests, clock, timers} = createRestartedModule({stored: {photo: STORED, due: 400 * 1000}});
		clock.now = 100 * 1000;
		mod.start();
		assert.equal(mod.img.src, STORED.url);
		assert.equal(mod.img.crossOrigin, "Anonymous");
		mod.img.onload();
		const data = mod.getTemplateData();
		assert.equal(data.photoElement, mod.img);
		assert.equal(data.photoData.color, "#aa0000");
		assert.equal(data.photoData.authorName, "Alice");
		assert.equal(data.photoData.needsDimming, true);
		assert.equal(requests.length, 0);
		assert.deepEqual(timers, [300 * 1000]);
	});

	it("waits for Electron's cache to be cleared before showing the stored photo", () => {
		const {mod} = createRestartedModule({config: {clearCacheOnStart: true}, stored: {photo: STORED, due: INTERVAL}});
		mod.sendSocketNotification = () => {};
		mod.start();
		assert.equal(mod.img, null);
		mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		assert.equal(mod.img.src, STORED.url);
	});

	it("replaces a photo that became due while MagicMirror was not running, and keeps it on screen until then", async () => {
		const {mod, requests, clock, timers} = createRestartedModule({config: {autoDimOn: false}, stored: {photo: STORED, due: INTERVAL}});
		clock.now = 3 * INTERVAL;
		mod.start();
		const restored = mod.img;
		restored.onload();
		assert.deepEqual(timers, [0]);
		await mod.fetchPhoto(); // what the timer runs
		assert.equal(requests.length, 1);
		assert.equal(mod.photoElement, restored);
		mod.img.onload();
		assert.notEqual(mod.photoElement, restored);
	});

	it("keeps the stored photo on screen when the first fetch fails", async () => {
		const {mod, storage, clock} = createRestartedModule({
			stored: {photo: STORED, due: 0},
			answer: () => new Response("Rate Limit Exceeded", {status: 403})
		});
		clock.now = INTERVAL;
		mod.start();
		mod.img.onload();
		await mod.fetchPhoto();
		const data = mod.getTemplateData();
		assert.equal(data.photoError.key, "ERROR_RATE_LIMIT");
		assert.equal(data.photoData.authorName, "Alice");
		// The template shows a photo before an error.
		const template = fs.readFileSync(path.join(REPO_ROOT, "WallberryTheme.njk"), "utf8");
		assert.ok(template.indexOf("{% if photoElement %}") < template.indexOf("{% elif photoError %}"));
		// The retry's due time is stored, so that a restart does not fetch earlier.
		assert.equal(storedRecord(storage, mod).due, 2 * INTERVAL);
	});

	it("fetches with a notification's payload that arrived while waiting for the cache, after showing the stored photo", () => {
		const {mod, requests} = createRestartedModule({config: {clearCacheOnStart: true}, stored: {photo: STORED, due: INTERVAL}});
		mod.sendSocketNotification = () => {};
		mod.start();
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		mod.img.onload();
		assert.equal(mod.photoData.authorName, "Alice");
		assert.equal(requests.length, 1);
		assert.equal(new URL(requests[0].url).searchParams.get("query"), "sports");
	});

	it("stores every photo that loads, with its due time", async () => {
		const {mod, storage, clock} = createRestartedModule({config: {autoDimOn: false}});
		mod.start();
		await new Promise(setImmediate);
		mod.img.onload();
		assert.equal(storedRecord(storage, mod).photo.authorName, "Jane");
		assert.equal(storedRecord(storage, mod).due, INTERVAL);
		clock.now = 60 * 1000;
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		await new Promise(setImmediate);
		mod.img.onload();
		assert.equal(storedRecord(storage, mod).due, 60 * 1000 + INTERVAL);
		assert.equal(storedRecord(storage, mod).settings, mod.photoSettings());
	});

	it("discards the stored photo when an option that selects or sizes photos changed", () => {
		const changes = {queries: ["sea"], collections: "1538150", orientation: "landscape", imageWidth: 1920, imageHeight: 1080, imageOptions: "fit=max"};
		for (const [option, value] of Object.entries(changes)) {
			const {mod, requests, storage} = createRestartedModule({stored: {photo: STORED, due: INTERVAL}});
			mod.config = {...mod.config, [option]: value};
			mod.start();
			assert.equal(requests.length, 1, option);
			assert.equal(storedRecord(storage, mod), null, option);
		}
	});

	it("keeps the stored photo when another option changed", () => {
		const {mod, requests} = createRestartedModule({stored: {photo: STORED, due: INTERVAL}});
		mod.config = {...mod.config, updateInterval: 60 * 1000, backgroundOpacity: 0.5};
		mod.start();
		assert.equal(requests.length, 0);
		assert.equal(mod.img.src, STORED.url);
	});

	it("changes the stored photo no later than updateInterval after a start, also when it was due later", () => {
		const {mod, timers} = createRestartedModule({stored: {photo: STORED, due: 24 * 60 * 60 * 1000}});
		mod.start();
		mod.img.onload();
		assert.deepEqual(timers, [INTERVAL]);
	});

	it("does not dim a stored photo with autoDimOn: false", () => {
		const {mod} = createRestartedModule({config: {autoDimOn: false}, stored: {photo: STORED, due: INTERVAL}});
		mod.start();
		mod.img.onload();
		assert.equal(mod.photoData.needsDimming, undefined);
	});

	it("leaves a photo restored with autoDimOn: false to be checked for dimming once autoDimOn is on", () => {
		const {mod, storage} = createRestartedModule({config: {autoDimOn: false}, stored: {photo: STORED, due: INTERVAL}});
		mod.start();
		mod.img.onload();
		// Stored without a result, a start with autoDimOn: true checks it.
		assert.equal(typeof storedRecord(storage, mod).photo.needsDimming, "undefined");
	});

	it("discards a stored photo whose image fails to load and fetches a new one", () => {
		const {mod, requests, storage} = createRestartedModule({stored: {photo: STORED, due: INTERVAL}});
		mod.start();
		mod.img.onerror();
		assert.equal(storedRecord(storage, mod), null);
		assert.equal(requests.length, 1);
		assert.equal(mod.photoData, null);
	});

	it("fetches as before when nothing usable is stored", () => {
		for (const text of [null, "not json", "null", "42", JSON.stringify({photo: STORED})]) {
			const {mod, requests, storage} = createRestartedModule();
			if (text !== null) {
				storage.setItem(mod.storageKey, text);
			}
			mod.start();
			assert.equal(requests.length, 1, text);
		}
	});

	it("works as before when the browser's storage cannot be read or written", async () => {
		const {mod, requests, timers} = createRestartedModule({config: {autoDimOn: false}, storage: new FakeStorage(true)});
		mod.start();
		assert.equal(requests.length, 1);
		await new Promise(setImmediate);
		mod.img.onload();
		assert.equal(mod.photoData.authorName, "Jane");
		assert.deepEqual(timers, [INTERVAL]);
	});

	it("works as before in a browser without localStorage", () => {
		const {mod, requests} = createRestartedModule({storage: null});
		mod.start();
		assert.equal(requests.length, 1);
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
		mod.img.onload();
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
