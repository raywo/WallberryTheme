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

// The theme's timer for the message that no source delivered a photo,
// started with the first awake
const NO_PHOTO = 60 * 1000;

const PHOTO = {urls: {raw: "https://images.unsplash.com/photo"}, color: "#336699", user: {name: "Jane"}};

/**
 * Fails the module's photo image to load: the attempt with crossOrigin
 * and the second one without it.
 */
function failToLoad(mod) {
	mod.img.onerror();
	mod.img.onerror();
}

/**
 * Gives the module its Unsplash source the way a running module has it:
 * awake, with the theme's translations stubbed. The notifications the
 * module sends are recorded in `mod.notifications`.
 */
function addSource(mod) {
	mod.translate = (key, variables) => translateError(EN, {key, variables});
	mod.notifications = [];
	mod.sendNotification = (notification, payload) => mod.notifications.push({notification, payload});
	mod.unsplash = mod.createUnsplashSource();
	mod.unsplash.state = "awake";
}

/**
 * Loads the image of the stored photo the source checks before
 * delivering it, or fails both of its attempts.
 */
function restore(mod) {
	mod.unsplash.probe.onload();
}

function failToRestore(mod) {
	mod.unsplash.probe.onerror();
	mod.unsplash.probe.onerror();
}

/**
 * Creates the WallberryTheme module the way MagicMirror² does, with the
 * DOM update stubbed out, timers recorded instead of run and a clock
 * that only moves when `clock.now` is set. `answer` stands in for the
 * network: it returns the Response for a request, or throws the error
 * fetch rejects with. `pending` holds the ids of the timers not cleared,
 * `callbacks` the function of each timer, by its id minus one.
 * `globals` adds or replaces globals, e.g. a `localStorage`. `config`
 * replaces options before the Unsplash source is created, which records
 * the photos it receives in `mod.photos` instead of delivering them.
 */
function createModule(answer = () => new Response(JSON.stringify(PHOTO)), globals = {}, config = {}) {
	const timers = [];
	const callbacks = [];
	const pending = new Set();
	const requests = [];
	const clock = {now: 0};
	const scripts = loadScripts(["unsplashSource.js", "WallberryTheme.js"], {
		fetch: async (url, options) => {
			requests.push({url, options});
			return answer();
		},
		// Records the timeout instead of starting one
		AbortSignal: {timeout: (milliseconds) => ({timeout: milliseconds})},
		setTimeout: (callback, delay) => {
			timers.push(delay);
			callbacks.push(callback);
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
	mod.config = {...definition.defaults, unsplashAccessKey: "key", ...config};
	mod.updateDom = () => {};
	// MagicMirror² starts every module, then tells them all.
	mod.start = function() {
		definition.start.call(this);
		this.notificationReceived("ALL_MODULES_STARTED");
	};
	addSource(mod);
	mod.photos = [];
	mod.unsplash.processPhoto = (photo) => mod.photos.push(photo);
	return {mod, timers, callbacks, pending, requests, clock, log: scripts.log};
}

describe("WallberryTheme parseUnsplashResponse", () => {
	const {mod} = createModule();

	it("returns the photo of a successful response", () => {
		const result = mod.unsplash.parseUnsplashResponse(200, "OK", JSON.stringify(PHOTO), "49");
		// The photo comes from the scripts' context, so compare its content
		assert.equal(JSON.stringify(result.photo), JSON.stringify(PHOTO));
	});

	it("returns Unsplash's error text of a JSON error response", () => {
		const result = mod.unsplash.parseUnsplashResponse(401, "Unauthorized", JSON.stringify({errors: ["OAuth error: The access token is invalid"]}), null);
		assert.equal(translateError(EN, result.error), "The Unsplash API returned the error \"OAuth error: The access token is invalid\"");
	});

	it("names the rate limit for a plain-text 403 response", () => {
		const result = mod.unsplash.parseUnsplashResponse(403, "Forbidden", "Rate Limit Exceeded", null);
		assert.equal(result.error.key, "ERROR_RATE_LIMIT");
	});

	it("names the rate limit when no requests remain", () => {
		const result = mod.unsplash.parseUnsplashResponse(403, "Forbidden", "", "0");
		assert.equal(result.error.key, "ERROR_RATE_LIMIT");
	});

	it("returns a status error for a body that is not JSON", () => {
		const result = mod.unsplash.parseUnsplashResponse(502, "Bad Gateway", "<html>Bad Gateway</html>", null);
		assert.equal(translateError(EN, result.error), "Unsplash Error: 502, Bad Gateway");
	});

	it("returns an error for a successful status whose body is not a photo", () => {
		for (const body of ["<html></html>", "null", "42", "{}"]) {
			assert.ok(mod.unsplash.parseUnsplashResponse(200, "OK", body, null).error, body);
		}
	});
});

describe("WallberryTheme fetchPhoto", () => {
	it("shows the photo of a successful response", async () => {
		const {mod, timers, requests} = createModule();
		await mod.unsplash.fetchPhoto();
		assert.equal(JSON.stringify(mod.photos), JSON.stringify([PHOTO]));
		assert.equal(mod.photoError, null);
		assert.deepEqual(timers, []);
		assert.equal(requests[0].options.headers["Accept-Version"], "v1");
	});

	for (const [status, body] of [[403, "Rate Limit Exceeded"], [502, "<html>Bad Gateway</html>"], [200, "not json"]]) {
		it(`shows an error and schedules the next fetch after a ${status} response that is not JSON`, async () => {
			const {mod, timers} = createModule(() => new Response(body, {status}));
			await mod.unsplash.fetchPhoto();
			assert.ok(mod.photoError);
			assert.deepEqual(timers, [mod.config.updateInterval]);
		});
	}

	it("names the rate limit from the response header", async () => {
		const {mod} = createModule(() => new Response("", {status: 403, headers: {"X-Ratelimit-Remaining": "0"}}));
		await mod.unsplash.fetchPhoto();
		assert.equal(mod.photoError.message, EN.ERROR_RATE_LIMIT);
	});

	it("gives up on a request after a timeout and schedules the next fetch", async () => {
		const {mod, timers, requests} = createModule(() => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		await mod.unsplash.fetchPhoto();
		assert.equal(requests[0].options.signal.timeout, mod.unsplash.requestTimeout);
		assert.equal(mod.photoError.message, "The Unsplash server did not answer within 30 seconds.");
		assert.deepEqual(timers, [mod.config.updateInterval]);
	});

	it("shows a connection error when Unsplash does not answer and schedules the next fetch", async () => {
		const {mod, timers} = createModule(() => {
			throw new TypeError("Failed to fetch");
		});
		await mod.unsplash.fetchPhoto();
		assert.equal(mod.photoError.message, EN.ERROR_CONNECTION);
		assert.deepEqual(timers, [mod.config.updateInterval]);
	});
});

describe("WallberryTheme photoSource", () => {
	const {mod} = createModule(undefined, {}, {queries: ["mountains"], collections: "1538150"});
	const source = (payload) => JSON.parse(JSON.stringify(mod.unsplash.photoSource(payload)));

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
		return createModule(answer, {}, {updateInterval: INTERVAL, queries: ["mountains"], collections: "1538150"});
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
		delete mod.unsplash.processPhoto; // use the module's own, which schedules the next fetch
		mod.unsplash.scheduleFetch(INTERVAL);
		clock.now = 200 * 1000;
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		assert.equal(pending.size, 0);
		await new Promise(setImmediate);
		mod.img.onload();
		assert.deepEqual(timers, [INTERVAL, INTERVAL]);
		assert.equal(pending.size, 1);
		assert.equal(mod.unsplash.nextFetchTime, 200 * 1000 + INTERVAL);
	});

	it("shows only the photo of the latest of several quick requests", async () => {
		const answers = [];
		const {mod, timers} = createConfiguredModule(() => new Promise((resolve) => answers.push(resolve)));
		const older = mod.unsplash.fetchPhoto(mod.unsplash.photoSource({queries: ["sports"]}));
		const newer = mod.unsplash.fetchPhoto(mod.unsplash.photoSource({queries: ["news"]}));
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
		const older = mod.unsplash.fetchPhoto();
		const newer = mod.unsplash.fetchPhoto(mod.unsplash.photoSource({queries: ["news"]}));
		await new Promise(setImmediate);
		answers[1].resolve(new Response(JSON.stringify(PHOTO)));
		await newer;
		answers[0].reject(new TypeError("Failed to fetch"));
		await older;
		assert.equal(mod.photoError, null);
		assert.deepEqual(timers, []);
	});

	it("ignores a photo of an older request that finishes loading after the newer photo arrived", async () => {
		const {mod} = createConfiguredModule();
		mod.config.autoDimOn = false;
		delete mod.unsplash.processPhoto; // use the source's own
		mod.updateDom = () => {};
		await mod.unsplash.fetchPhoto();
		const older = mod.img;
		await mod.unsplash.fetchPhoto(mod.unsplash.photoSource({queries: ["news"]}));
		older.onload();
		assert.equal(mod.photoElement, null);
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
		const created = createModule(answer, {}, {updateInterval: INTERVAL, ...config});
		const {mod} = created;
		mod.tints = [];
		mod.setBackgroundTint = (swatch) => mod.tints.push(swatch);
		mod.photoData = {color: "#336699"};
		mod.unsplash.scheduleFetch(INTERVAL);
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
		mod.unsplash.fetchPhoto();
		mod.resume();
		assert.equal(requests.length, 1);
		assert.deepEqual(timers, []);
	});

	it("schedules the next fetch when the photo fails to load", async () => {
		const {mod, requests, timers, clock} = createShowingModule();
		delete mod.unsplash.processPhoto; // use the module's own
		await mod.unsplash.fetchPhoto();
		failToLoad(mod);
		mod.suspend();
		clock.now = 100 * 1000;
		mod.resume();
		assert.equal(requests.length, 1);
		assert.deepEqual(timers, [INTERVAL, INTERVAL - 100 * 1000]);
	});

	it("keeps the shown photo, its tint and its author when the next photo fails to load", () => {
		const {mod} = createShowingModule({autoDimOn: false});
		delete mod.unsplash.processPhoto; // use the module's own
		const shown = {urls: {raw: "https://images.unsplash.com/shown?x"}, color: "#aa0000", user: {name: "Alice"}};
		const failed = {urls: {raw: "https://images.unsplash.com/failed?x"}, color: "#0000bb", user: {name: "Bob"}};
		mod.unsplash.processPhoto(shown);
		mod.img.onload();
		mod.unsplash.processPhoto(failed);
		failToLoad(mod);
		const data = mod.getTemplateData();
		assert.equal(data.photoData.authorName, "Alice");
		assert.match(data.photoElement.src, /\/shown\?/);
		mod.suspend();
		mod.resume();
		assert.equal(mod.tints.at(-1), "#aa0000");
	});

	it("ignores a photo that finishes loading after a newer one started", () => {
		const {mod, timers} = createShowingModule({autoDimOn: false});
		delete mod.unsplash.processPhoto; // use the module's own
		mod.unsplash.processPhoto({...PHOTO, user: {name: "Alice"}});
		const older = mod.img;
		mod.unsplash.processPhoto({...PHOTO, user: {name: "Bob"}});
		mod.img.onload();
		older.onload();
		older.onerror();
		assert.equal(mod.photoData.authorName, "Bob");
		assert.equal(mod.photoElement, mod.img);
		// The source schedules when it delivers a photo.
		assert.deepEqual(timers, [INTERVAL, INTERVAL]);
	});

	it("starts no timer while suspended and leaves it to resume", async () => {
		const {mod, timers, clock} = createShowingModule({autoDimOn: false});
		delete mod.unsplash.processPhoto; // use the module's own
		const fetching = mod.unsplash.fetchPhoto();
		mod.suspend();
		await fetching;
		mod.img.onload();
		assert.deepEqual(timers, []);
		clock.now = 100 * 1000;
		mod.resume();
		assert.deepEqual(timers, [INTERVAL - 100 * 1000]);
	});

	it("takes the due time from when the photo is delivered", () => {
		const {mod} = createModuleWithDocument();
		const before = Date.now();
		mod.unsplash.processPhoto(PHOTO);
		assert.ok(mod.unsplash.nextFetchTime >= before + mod.config.updateInterval);
		assert.ok(mod.unsplash.nextFetchTime <= Date.now() + mod.config.updateInterval);
	});

	it("retries after an error at the scheduled time and sets no tint without a photo", () => {
		const {mod, timers, clock, requests} = createShowingModule({newPhotoOnResume: false});
		mod.photoData = null;
		mod.unsplash.processError({key: "ERROR_CONNECTION"});
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
		const created = createModule(answer, storage === null ? {} : {localStorage: storage},
			{updateInterval: INTERVAL, clearCacheOnStart: false, queries: ["mountains"], ...config});
		const {mod} = created;
		delete mod.unsplash.processPhoto; // use the source's own
		if (stored !== null) {
			storage.setItem(mod.unsplash.storageKey, JSON.stringify({settings: mod.unsplash.photoSettings(), ...stored}));
		}
		return {...created, storage};
	}

	function storedRecord(storage, mod) {
		// start() replaces the source, whose key stays the same
		const text = storage.getItem(mod.unsplash.storageKey);
		return text === null ? null : JSON.parse(text);
	}

	it("shows the stored photo with its tint, author and dimming without an Unsplash request", () => {
		const {mod, requests, clock, timers} = createRestartedModule({stored: {photo: STORED, due: 400 * 1000}});
		clock.now = 100 * 1000;
		mod.start();
		restore(mod);
		assert.equal(mod.img.src, STORED.url);
		assert.equal(mod.img.crossOrigin, "Anonymous");
		mod.img.onload();
		const data = mod.getTemplateData();
		assert.equal(data.photoElement, mod.img);
		assert.equal(data.photoData.color, "#aa0000");
		assert.equal(data.photoData.authorName, "Alice");
		assert.equal(data.photoData.needsDimming, true);
		assert.equal(requests.length, 0);
		assert.deepEqual(timers, [NO_PHOTO, 300 * 1000]);
	});

	it("waits for Electron's cache to be cleared before showing the stored photo", () => {
		const {mod} = createRestartedModule({config: {clearCacheOnStart: true}, stored: {photo: STORED, due: INTERVAL}});
		mod.sendSocketNotification = () => {};
		mod.start();
		assert.equal(mod.img, null);
		assert.equal(mod.unsplash.probe, null);
		mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		restore(mod);
		assert.equal(mod.img.src, STORED.url);
	});

	it("replaces a photo that became due while MagicMirror was not running, and keeps it on screen until then", async () => {
		const {mod, requests, clock, timers} = createRestartedModule({config: {autoDimOn: false}, stored: {photo: STORED, due: INTERVAL}});
		clock.now = 3 * INTERVAL;
		mod.start();
		restore(mod);
		const restored = mod.img;
		restored.onload();
		assert.deepEqual(timers, [NO_PHOTO, 0]);
		await mod.unsplash.fetchPhoto(); // what the timer runs
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
		restore(mod);
		mod.img.onload();
		await mod.unsplash.fetchPhoto();
		const data = mod.getTemplateData();
		assert.equal(data.photoError.message, EN.ERROR_RATE_LIMIT);
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
		restore(mod);
		mod.img.onload();
		assert.equal(mod.photoData.authorName, "Alice");
		assert.equal(requests.length, 1);
		assert.equal(new URL(requests[0].url).searchParams.get("query"), "sports");
	});

	it("keeps the stored photo on screen when a notification arrives while it loads and the fetch fails", async () => {
		const {mod, requests} = createRestartedModule({
			stored: {photo: STORED, due: INTERVAL},
			answer: () => new Response("Rate Limit Exceeded", {status: 403})
		});
		mod.start();
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		assert.equal(requests.length, 0);
		restore(mod);
		const restored = mod.img;
		restored.onload();
		assert.equal(requests.length, 1);
		assert.equal(new URL(requests[0].url).searchParams.get("query"), "sports");
		await new Promise(setImmediate);
		const data = mod.getTemplateData();
		assert.equal(data.photoError.message, EN.ERROR_RATE_LIMIT);
		assert.equal(data.photoElement, restored);
	});

	it("fetches with a notification's payload that arrived while a stored photo failed to load", () => {
		const {mod, requests} = createRestartedModule({stored: {photo: STORED, due: INTERVAL}});
		mod.start();
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		failToRestore(mod);
		assert.equal(requests.length, 1);
		assert.equal(new URL(requests[0].url).searchParams.get("query"), "sports");
	});

	it("fetches a new photo on resume with newPhotoOnResume: true only once the stored photo is shown", () => {
		const {mod, requests} = createRestartedModule({config: {newPhotoOnResume: true}, stored: {photo: STORED, due: INTERVAL}});
		mod.setBackgroundTint = () => {};
		mod.start();
		mod.suspend();
		mod.resume();
		assert.equal(requests.length, 0);
		restore(mod);
		const restored = mod.img;
		restored.onload();
		assert.equal(mod.photoElement, restored);
		assert.equal(requests.length, 1);
		assert.equal(new URL(requests[0].url).searchParams.get("query"), "mountains");
	});

	it("stores every photo it delivers, with its due time", async () => {
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
		assert.equal(storedRecord(storage, mod).settings, mod.unsplash.photoSettings());
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
		assert.equal(mod.unsplash.probe.src, STORED.url);
	});

	it("changes the stored photo no later than updateInterval after a start, also when it was due later", () => {
		const {mod, timers} = createRestartedModule({stored: {photo: STORED, due: 24 * 60 * 60 * 1000}});
		mod.start();
		restore(mod);
		mod.img.onload();
		assert.deepEqual(timers, [NO_PHOTO, INTERVAL]);
	});

	it("does not dim a stored photo with autoDimOn: false", () => {
		const {mod} = createRestartedModule({config: {autoDimOn: false}, stored: {photo: STORED, due: INTERVAL}});
		mod.start();
		restore(mod);
		mod.img.onload();
		assert.equal(mod.photoData.needsDimming, undefined);
	});

	it("leaves a photo restored with autoDimOn: false to be checked for dimming once autoDimOn is on", () => {
		const {mod, storage} = createRestartedModule({config: {autoDimOn: false}, stored: {photo: STORED, due: INTERVAL}});
		mod.start();
		restore(mod);
		mod.img.onload();
		// Stored without a result, a start with autoDimOn: true checks it.
		assert.equal(typeof storedRecord(storage, mod).photo.needsDimming, "undefined");
	});

	it("discards a stored photo whose image fails to load and fetches a new one", () => {
		const {mod, requests, storage} = createRestartedModule({stored: {photo: STORED, due: INTERVAL}});
		mod.start();
		failToRestore(mod);
		assert.equal(storedRecord(storage, mod), null);
		assert.equal(requests.length, 1);
		assert.equal(mod.photoData, null);
	});

	it("fetches as before when nothing usable is stored", () => {
		for (const text of [null, "not json", "null", "42", JSON.stringify({photo: STORED})]) {
			const {mod, requests, storage} = createRestartedModule();
			if (text !== null) {
				storage.setItem(mod.unsplash.storageKey, text);
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
		assert.deepEqual(timers, [NO_PHOTO, INTERVAL]);
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
		const sources = ["WallberryTheme.js", "WallberryTheme.njk", "unsplashSource.js"]
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
	const scripts = loadScripts(["unsplashSource.js", "WallberryTheme.js"], {
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
	addSource(mod);
	return {mod, html, body};
}

describe("WallberryTheme background tint", () => {
	it("keeps the photo's colour swatch for the tints", () => {
		const {mod} = createModuleWithDocument();
		mod.unsplash.processPhoto(PHOTO);
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
		const scripts = loadScripts(["unsplashSource.js", "WallberryTheme.js"], {
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
		addSource(mod);
		return {mod, calls};
	}

	function loadPhoto(mod, height = 1920) {
		mod.unsplash.processPhoto(PHOTO);
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

describe("WallberryTheme photo without CORS header", () => {
	const INTERVAL = 300 * 1000;
	const URL_PATTERN = /https:\/\/images\.unsplash\.com\/photo/;

	/**
	 * Creates the module with its own processPhoto(), storage, bar regions
	 * and WBColor replaced by `needsDimming`, which records its calls.
	 */
	function createLoadingModule(needsDimming = () => true) {
		const calls = [];
		const storage = new FakeStorage();
		const created = createModule(undefined, {
			localStorage: storage,
			document: {
				createElement: () => ({style: {}}),
				getElementsByClassName: () => [{
					clientHeight: 100,
					getBoundingClientRect: () => ({top: 60, bottom: 160})
				}]
			},
			WBColor: {
				needsDimming: (...args) => {
					calls.push(args);
					return needsDimming(...args);
				}
			}
		}, {updateInterval: INTERVAL, clearCacheOnStart: false});
		const {mod} = created;
		delete mod.unsplash.processPhoto; // use the source's own
		return {...created, calls, storage};
	}

	function storedPhoto(storage, mod) {
		return JSON.parse(storage.getItem(mod.unsplash.storageKey)).photo;
	}

	it("loads the photo with crossOrigin first", () => {
		const {mod} = createLoadingModule();
		mod.unsplash.processPhoto(PHOTO);
		assert.equal(mod.img.crossOrigin, "Anonymous");
	});

	it("loads a photo that fails with crossOrigin once more without it", () => {
		const {mod, log} = createLoadingModule();
		mod.unsplash.processPhoto(PHOTO);
		const first = mod.img;
		first.onerror();
		assert.notEqual(mod.img, first);
		assert.equal(mod.img.crossOrigin, undefined);
		assert.equal(mod.img.src, first.src);
		assert.equal(log.error.length, 0);
	});

	it("shows the second attempt at backgroundOpacity without the auto-dim check and warns with its URL", () => {
		const {mod, calls, log, timers} = createLoadingModule();
		mod.unsplash.processPhoto(PHOTO);
		mod.img.onerror();
		mod.img.onload();
		assert.equal(mod.photoElement, mod.img);
		assert.equal(mod.photoData.authorName, "Jane");
		assert.equal(mod.photoData.needsDimming, undefined);
		assert.equal(mod.img.style.opacity, mod.config.backgroundOpacity);
		assert.equal(calls.length, 0);
		assert.equal(log.warn.length, 1);
		assert.match(log.warn[0], URL_PATTERN);
		assert.deepEqual(timers, [INTERVAL]);
	});

	it("stores a photo shown without the check without a dimming result", () => {
		const {mod, storage} = createLoadingModule();
		mod.unsplash.processPhoto(PHOTO);
		mod.img.onerror();
		mod.img.onload();
		assert.ok(!("needsDimming" in storedPhoto(storage, mod)));
	});

	it("drops a known dimming result when a stored photo loads only without crossOrigin", () => {
		const {mod, storage} = createLoadingModule();
		const photo = {url: "https://images.unsplash.com/stored", color: "#aa0000", authorName: "Alice", needsDimming: true};
		storage.setItem(mod.unsplash.storageKey, JSON.stringify({settings: mod.unsplash.photoSettings(), photo, due: INTERVAL}));
		mod.start();
		restore(mod);
		mod.img.onerror();
		mod.img.onload();
		assert.equal(mod.photoData.needsDimming, undefined);
		assert.ok(!("needsDimming" in storedPhoto(storage, mod)));
	});

	it("keeps the previous photo and schedules the next fetch when both attempts fail", () => {
		const {mod, log, timers} = createLoadingModule();
		mod.unsplash.processPhoto({...PHOTO, user: {name: "Alice"}});
		mod.img.onload();
		const shown = mod.img;
		timers.length = 0;
		mod.unsplash.processPhoto({...PHOTO, user: {name: "Bob"}});
		failToLoad(mod);
		assert.equal(mod.photoElement, shown);
		assert.equal(mod.photoData.authorName, "Alice");
		assert.equal(log.error.length, 1);
		assert.match(log.error[0], URL_PATTERN);
		assert.deepEqual(timers, [INTERVAL]);
	});

	it("ignores a second attempt that finishes after a newer photo started", () => {
		const {mod, timers} = createLoadingModule();
		mod.unsplash.processPhoto({...PHOTO, user: {name: "Alice"}});
		mod.img.onerror();
		const retry = mod.img;
		mod.unsplash.processPhoto({...PHOTO, user: {name: "Bob"}});
		mod.img.onload();
		retry.onload();
		retry.onerror();
		assert.equal(mod.photoData.authorName, "Bob");
		assert.equal(mod.photoElement, mod.img);
		// The source schedules when it delivers a photo.
		assert.deepEqual(timers, [INTERVAL, INTERVAL]);
	});

	it("ignores a second attempt that finishes after the photo of a new fetch arrived", async () => {
		const {mod} = createLoadingModule();
		mod.unsplash.processPhoto({...PHOTO, user: {name: "Alice"}});
		mod.img.onerror();
		const retry = mod.img;
		await mod.unsplash.fetchPhoto();
		retry.onload();
		assert.equal(mod.photoData, null);
	});

	it("shows the photo undimmed and warns when the auto-dim check throws", () => {
		const {mod, log, storage, timers} = createLoadingModule(() => {
			throw new DOMException("The canvas has been tainted by cross-origin data.", "SecurityError");
		});
		mod.unsplash.processPhoto(PHOTO);
		mod.img.onload();
		assert.equal(mod.photoElement, mod.img);
		assert.equal(mod.photoData.needsDimming, undefined);
		assert.ok(!("needsDimming" in storedPhoto(storage, mod)));
		assert.equal(log.warn.length, 1);
		assert.match(log.warn[0], URL_PATTERN);
		assert.deepEqual(timers, [INTERVAL]);
	});
});

describe("WallberryTheme photo source interface", () => {
	const INTERVAL = 300 * 1000;

	/**
	 * Creates the module as MagicMirror² starts it, with Electron's cache
	 * to be cleared, storage, the tints it sets recorded and the source's
	 * own processPhoto().
	 */
	function createStartingModule(config = {}) {
		const storage = new FakeStorage();
		const created = createModule(undefined, {localStorage: storage}, {updateInterval: INTERVAL, autoDimOn: false, ...config});
		const {mod} = created;
		mod.sendSocketNotification = () => {};
		mod.tints = [];
		mod.setBackgroundTint = (swatch) => mod.tints.push(swatch);
		return {...created, storage};
	}

	it("keeps Unsplash's request, response, schedule and stored photo out of the theme", () => {
		const theme = fs.readFileSync(path.join(REPO_ROOT, "WallberryTheme.js"), "utf8");
		for (const code of ["api.unsplash.com", "urls.raw", "fetch(", "scheduleFetch", "fetchTimer", "localStorage", "newPhotoOnResume:"]) {
			assert.equal(theme.includes(code), code === "newPhotoOnResume:", code);
		}
	});

	it("tells the source nothing before Electron's cache is cleared", () => {
		const {mod, requests} = createStartingModule({newPhotoOnResume: true});
		mod.start();
		mod.suspend();
		mod.resume();
		assert.equal(requests.length, 0);
		assert.equal(mod.unsplash.state, "new");
		mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		assert.equal(requests.length, 1);
	});

	it("lets a source of a theme hidden at the start deliver its first photo, then keeps it asleep", async () => {
		const {mod, requests, timers, clock} = createStartingModule();
		mod.start();
		delete mod.unsplash.processPhoto; // start() created the source anew
		mod.suspend();
		mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		assert.equal(requests.length, 1);
		await new Promise(setImmediate);
		mod.img.onload();
		assert.equal(mod.photoData.authorName, "Jane");
		assert.deepEqual(timers, [NO_PHOTO]);
		clock.now = 100 * 1000;
		mod.resume();
		assert.deepEqual(timers, [NO_PHOTO, INTERVAL - 100 * 1000]);
	});

	it("starts the source at once with clearCacheOnStart: false", () => {
		const {mod, requests} = createStartingModule({clearCacheOnStart: false});
		mod.start();
		assert.equal(mod.unsplash.state, "awake");
		assert.equal(requests.length, 1);
	});

	it("ignores a fetch request that arrives before the module started", () => {
		const {mod, requests} = createModule();
		mod.unsplash = null;
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		assert.equal(requests.length, 0);
	});

	it("sends the source's name and the translated message with an error", async () => {
		const {mod} = createModule(() => new Response("", {status: 500, statusText: "Server Error"}));
		await mod.unsplash.fetchPhoto();
		assert.equal(mod.photoError.source, "unsplash");
		assert.equal(mod.photoError.message, "Unsplash Error: 500, Server Error");
	});

	it("shows a photo with its colour and author, and skips the auto-dim check with a known result", () => {
		const {mod} = createModule(undefined, {}, {autoDimOn: true});
		mod.receivePhoto({source: "test", url: "https://example.com/photo.jpg", color: "#123456", author: "Ann", needsDimming: true});
		assert.equal(mod.img.src, "https://example.com/photo.jpg");
		mod.img.onload(); // WBColor is not loaded: a check would not return true
		assert.equal(mod.photoData.color, "#123456");
		assert.equal(mod.photoData.authorName, "Ann");
		assert.equal(mod.photoData.needsDimming, true);
	});

	it("does not dim a photo with autoDimOn: false, whatever its source knows", () => {
		const {mod} = createModule(undefined, {}, {autoDimOn: false});
		mod.receivePhoto({source: "test", url: "https://example.com/photo.jpg", needsDimming: true});
		mod.img.onload();
		assert.equal(mod.photoData.needsDimming, undefined);
	});

	it("shows the attribution only for a photo with an author, naming Unsplash only for its photos", () => {
		const template = fs.readFileSync(path.join(REPO_ROOT, "WallberryTheme.njk"), "utf8");
		assert.match(template, /{% if photoData\.authorName %}\s*<div class="wb-unsplash-bg-attribution">{{ \("PHOTO_BY" if photoData\.source == "unsplash" else "PHOTO_BY_AUTHOR"\)/);
		assert.match(EN.PHOTO_BY, /Unsplash/);
		assert.doesNotMatch(EN.PHOTO_BY_AUTHOR, /Unsplash/);
	});

	it("delivers the first photo also after an asleep that came before the first awake", () => {
		const {mod, requests} = createModule();
		mod.unsplash.state = "new";
		mod.unsplash.setThemeState("asleep");
		mod.unsplash.setThemeState("awake");
		assert.equal(requests.length, 1);
	});
});

describe("WallberryTheme photos from other modules", () => {
	const photo = (source, url, extra = {}) => ({source, url, color: "#123456", author: "Ann", ...extra});

	/**
	 * Creates the module as MagicMirror² creates it, with `config`, the
	 * DOM updates counted in `mod.updates` and the tint left out.
	 */
	function createSourcesModule(config = {}, globals = {}) {
		const created = createModule(undefined, globals, {autoDimOn: false, ...config});
		const {mod} = created;
		mod.sendSocketNotification = () => {};
		mod.setBackgroundTint = () => {};
		mod.updates = 0;
		mod.updateDom = () => {
			mod.updates += 1;
		};
		return created;
	}

	/**
	 * Starts the module of createSourcesModule() and clears Electron's cache.
	 */
	function startModule(config = {}, globals = {}) {
		const created = createSourcesModule(config, globals);
		created.mod.start();
		created.mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		return created;
	}

	const states = (mod) => mod.notifications
		.filter((sent) => sent.notification === "WALLBERRY_THEME_STATE")
		.map((sent) => sent.payload.state);

	it("shows the photo of any source, the newest one winning", () => {
		const {mod} = startModule({unsplashAccessKey: ""});
		mod.notificationReceived("WALLBERRY_PHOTO", photo("folder", "http://localhost:8080/a.jpg"));
		const first = mod.img;
		mod.notificationReceived("WALLBERRY_PHOTO", photo("nas", "http://nas/b.jpg", {author: "Bob"}));
		first.onload(); // finishes after the newer photo started
		assert.equal(mod.photoElement, null);
		mod.img.onload();
		assert.equal(mod.photoData.source, "nas");
		assert.equal(mod.photoData.url, "http://nas/b.jpg");
		assert.equal(mod.photoData.authorName, "Bob");
		mod.notificationReceived("WALLBERRY_PHOTO", photo("folder", "http://localhost:8080/c.jpg"));
		mod.img.onload();
		assert.equal(mod.photoData.source, "folder");
		assert.equal(mod.photoData.color, "#123456");
	});

	it("ignores a photo without source or url as strings, with a warning", () => {
		const {mod, log} = startModule({unsplashAccessKey: ""});
		const invalid = [undefined, null, "http://nas/a.jpg", {url: "http://nas/a.jpg"}, {source: "nas"},
			{source: 1, url: "http://nas/a.jpg"}, {source: "nas", url: {href: "http://nas/a.jpg"}}];
		for (const payload of invalid) {
			mod.notificationReceived("WALLBERRY_PHOTO", payload);
		}
		assert.equal(mod.img, null);
		assert.equal(log.warn.filter((message) => message.includes("WALLBERRY_PHOTO without source and url")).length, invalid.length);
	});

	it("leaves out a colour or author that is not a string", () => {
		const {mod} = startModule({unsplashAccessKey: ""});
		mod.notificationReceived("WALLBERRY_PHOTO", {source: "nas", url: "http://nas/a.jpg", color: 7, author: {name: "Ann"}});
		mod.img.onload();
		assert.equal(mod.photoData.color, undefined);
		assert.equal(mod.photoData.authorName, undefined);
	});

	it("sends every state it sends to the internal source to all sources, from the first awake on", () => {
		const {mod} = createSourcesModule();
		mod.start();
		const sent = [];
		const internal = mod.unsplash.setThemeState.bind(mod.unsplash);
		mod.unsplash.setThemeState = (state) => {
			sent.push(state);
			internal(state);
		};
		mod.suspend(); // hidden at the start, before the cache is cleared
		assert.deepEqual(states(mod), []);
		mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		mod.resume();
		mod.suspend();
		assert.deepEqual(sent, ["awake", "asleep", "awake", "asleep"]);
		assert.deepEqual(states(mod), sent);
		assert.deepEqual(Object.keys(mod.notifications[0].payload), ["state"]);
	});

	it("sends the states also without the Unsplash source", () => {
		const {mod} = createSourcesModule({unsplashAccessKey: "", clearCacheOnStart: false});
		mod.start();
		mod.suspend();
		mod.resume();
		assert.deepEqual(states(mod), ["awake", "asleep", "awake"]);
	});

	it("passes WALLBERRY_FETCH_PHOTO only to the internal source and sends it on to nobody", () => {
		const {mod, requests} = startModule();
		const before = requests.length;
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		assert.equal(requests.length, before + 1);
		assert.ok(mod.notifications.every((sent) => sent.notification !== "WALLBERRY_FETCH_PHOTO"));
	});

	it("shows a source's error while no photo is on screen, until a photo of any source replaces it", () => {
		const {mod} = startModule({unsplashAccessKey: ""});
		const updates = mod.updates;
		mod.notificationReceived("WALLBERRY_PHOTO_ERROR", {source: "nas", message: "The NAS is offline."});
		const error = mod.getTemplateData().photoError;
		assert.equal(error.source, "nas");
		assert.equal(error.message, "The NAS is offline.");
		assert.equal(mod.updates, updates + 1);
		mod.notificationReceived("WALLBERRY_PHOTO", photo("folder", "http://localhost:8080/a.jpg"));
		mod.img.onload();
		// The template shows a photo before an error.
		const template = fs.readFileSync(path.join(REPO_ROOT, "WallberryTheme.njk"), "utf8");
		assert.ok(template.indexOf("{% if photoElement %}") < template.indexOf("{% elif photoError %}"));
		assert.equal(mod.getTemplateData().photoElement, mod.img);
	});

	it("keeps the photo on screen and does not redraw for an error of any source", () => {
		const {mod} = startModule({unsplashAccessKey: ""});
		mod.notificationReceived("WALLBERRY_PHOTO", photo("folder", "http://localhost:8080/a.jpg"));
		mod.img.onload();
		const updates = mod.updates;
		mod.notificationReceived("WALLBERRY_PHOTO_ERROR", {source: "nas", message: "The NAS is offline."});
		mod.receiveError({source: "unsplash", message: "Unsplash Error: 500, Server Error"});
		assert.equal(mod.updates, updates);
		assert.equal(mod.getTemplateData().photoData.source, "folder");
	});

	it("ignores an error without source or message as strings, with a warning", () => {
		const {mod, log} = startModule({unsplashAccessKey: ""});
		for (const payload of [null, {message: "offline"}, {source: "nas"}, {source: "nas", message: 404}]) {
			mod.notificationReceived("WALLBERRY_PHOTO_ERROR", payload);
		}
		assert.equal(mod.photoError, null);
		assert.equal(log.warn.filter((message) => message.includes("WALLBERRY_PHOTO_ERROR without source and message")).length, 4);
	});

	it("runs no Unsplash source without an unsplashAccessKey: no request, no stored photo", () => {
		for (const unsplashAccessKey of ["", "  ", undefined]) {
			const storage = new FakeStorage();
			storage.setItem("WallberryTheme.photo", JSON.stringify({settings: "[]", photo: {url: "https://images.unsplash.com/stored", authorName: "Alice"}, due: 0}));
			const {mod, requests} = startModule({unsplashAccessKey}, {localStorage: storage});
			mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
			mod.resume();
			assert.equal(mod.unsplash, null, unsplashAccessKey);
			assert.equal(requests.length, 0, unsplashAccessKey);
			assert.equal(mod.img, null, unsplashAccessKey);
			assert.ok(storage.getItem("WallberryTheme.photo") !== null, unsplashAccessKey);
		}
	});

	it("says after 60 seconds that no source delivered a photo, until the first photo replaces it", () => {
		const {mod, timers, callbacks} = startModule({unsplashAccessKey: ""});
		assert.deepEqual(timers, [NO_PHOTO]);
		const updates = mod.updates;
		callbacks[0]();
		assert.equal(mod.getTemplateData().photoError.message, EN.ERROR_NO_PHOTO);
		assert.equal(mod.updates, updates + 1);
		mod.notificationReceived("WALLBERRY_PHOTO", photo("folder", "http://localhost:8080/a.jpg"));
		mod.img.onload();
		assert.equal(mod.getTemplateData().photoElement, mod.img);
	});

	it("names the Unsplash key and photo source modules in the message, in English and German", () => {
		const DE = readTranslation("translations/de.json");
		for (const text of [EN.ERROR_NO_PHOTO, DE.ERROR_NO_PHOTO]) {
			assert.match(text, /unsplashAccessKey/);
		}
		assert.match(EN.ERROR_NO_PHOTO, /No photo source/);
		assert.match(DE.ERROR_NO_PHOTO, /Keine Fotoquelle/);
	});

	it("says nothing after 60 seconds when a photo has loaded", () => {
		const {mod, callbacks} = startModule({unsplashAccessKey: ""});
		mod.notificationReceived("WALLBERRY_PHOTO", photo("folder", "http://localhost:8080/a.jpg"));
		mod.img.onload();
		callbacks[0]();
		assert.equal(mod.photoError, null);
	});

	it("says after 60 seconds that no source delivered a photo when the only photo fails to load", () => {
		const {mod, callbacks} = startModule({unsplashAccessKey: ""});
		mod.notificationReceived("WALLBERRY_PHOTO", photo("folder", "/photos/a.jpg"));
		failToLoad(mod);
		callbacks[0]();
		assert.equal(mod.getTemplateData().photoError.message, EN.ERROR_NO_PHOTO);
	});

	it("keeps a source's error after 60 seconds instead of the message, as with Unsplash today", () => {
		const {mod, callbacks} = startModule();
		mod.receiveError({source: "unsplash", message: EN.ERROR_RATE_LIMIT});
		callbacks[0]();
		assert.equal(mod.photoError.message, EN.ERROR_RATE_LIMIT);
	});

	it("starts the 60 seconds with the first awake, after Electron's cache is cleared", () => {
		const {mod, timers} = createSourcesModule({unsplashAccessKey: ""});
		mod.start();
		assert.deepEqual(timers, []);
		mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		assert.deepEqual(timers, [NO_PHOTO]);
	});

	it("sends no second awake when another browser's cache clearing is answered", () => {
		// The helper answers every browser at once, e.g. in server-only
		// mode with a second browser showing the mirror.
		const {mod, timers} = startModule({unsplashAccessKey: ""});
		mod.socketNotificationReceived("ELECTRON_CACHE_CLEARED");
		assert.deepEqual(states(mod), ["awake"]);
		assert.deepEqual(timers, [NO_PHOTO]);
	});
});

describe("WallberryTheme start", () => {
	/**
	 * Starts the module the way MagicMirror² calls start(), before it
	 * sends ALL_MODULES_STARTED.
	 */
	function startOnly(config) {
		const {mod, requests} = createModule(undefined, {}, {autoDimOn: false, ...config});
		mod.sendSocketNotification = () => {};
		Object.getPrototypeOf(mod).start.call(mod);
		return {mod, requests};
	}

	it("wakes the sources only once all modules started, which MagicMirror² sends notifications to", () => {
		const {mod, requests} = startOnly({clearCacheOnStart: false});
		assert.deepEqual(mod.notifications, []);
		assert.equal(requests.length, 0);
		mod.notificationReceived("ALL_MODULES_STARTED");
		assert.equal(mod.notifications[0].notification, "WALLBERRY_THEME_STATE");
		assert.equal(mod.notifications[0].payload.state, "awake");
		assert.equal(requests.length, 1);
	});

	it("waits for both Electron's cache and all modules, in either order", () => {
		for (const order of [["ELECTRON_CACHE_CLEARED", "ALL_MODULES_STARTED"], ["ALL_MODULES_STARTED", "ELECTRON_CACHE_CLEARED"]]) {
			const {mod, requests} = startOnly({clearCacheOnStart: true});
			const deliver = (event) => event === "ELECTRON_CACHE_CLEARED" ? mod.socketNotificationReceived(event) : mod.notificationReceived(event);
			deliver(order[0]);
			assert.deepEqual(mod.notifications, [], order[0]);
			deliver(order[1]);
			assert.equal(mod.notifications.length, 1, order[1]);
			assert.equal(requests.length, 1, order[1]);
		}
	});
});
