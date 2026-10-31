/* MagicMirror² - WallberryTheme <3
 * Module: WallberryTheme
 *
 * By JSC (@delightedCrow)
 * MIT Licensed.
 */

Module.register("WallberryTheme", {
	defaults: {
		unsplashAccessKey: "", // REQUIRED

		collections: "", // comma-separated list of Unsplash collection ids
		queries: [], // list of search queries to search for

		updateInterval: 300 * 1000, // 5 min
		newPhotoOnResume: false, // true: fetch a new photo when the module is shown again after being hidden
		orientation: "portrait", // desired photo orientation - can be portrait, landscape, or squarish
		resizeForScreen: true, // resize image for screen - otherwise image is displayed at full height/width
		backgroundOpacity: 1, // between 0 (black background) and 1 (visible opaque background)
		brightImageOpacity: 0.85, // between 0 (black background) and 1 (visible opaque background), only used when autoDimOn is true
		autoDimOn: true, // automatically darken bright images
		addBackgroundFade: ["top", "bottom"], // adds fades for the top and bottom bar regions (leave an empty list to remove fades)
		clearCacheOnStart: true, // clear Electron's cache on MM start
		imageWidth: "auto", // "auto" set width to screen, or specify a hardcoded width in pixels
		imageHeight: "auto", // "auto" set height to screen, or specify a hardcoded height in pixels
		imageOptions: "fit=crop" // see https://unsplash.com/documentation#dynamically-resizable-images
	},

	photoData: null,
	photoElement: null,
	photoError: null,
	fetchTimer: null,
	nextFetchTime: null, // ms timestamp the scheduled fetch is due at, null while a fetch runs
	suspended: false, // true between suspend() and resume()
	waitingForCache: false, // true from start() until Electron's cache is cleared
	restoring: false, // true while the photo stored by the last run loads, see showFirstPhoto()
	fetchId: 0, // counts the fetches, so that only the latest one shows its result
	requestedSource: null, // {queries, collections} of a notification that arrived while suspended or waiting for the cache
	img: null,
	storageKey: "WallberryTheme.photo", // localStorage key of the photo shown last, see storePhoto()
	requestTimeout: 30 * 1000, // abort an Unsplash request that has not answered after 30 s
	fadeMinHeight: 250, // px, the min-height of .wbfade in css/WallberryTheme.css

	getStyles: function() {
		return [
			this.file("css/WallberryTheme.css"),
			"font-awesome.css"
		];
	},

	getScripts: function() {
		return ["colorHelpers.js"];
	},

	// English comes first: MagicMirror falls back to the first file for a
	// language without a translation.
	getTranslations: function() {
		return {
			en: "translations/en.json",
			de: "translations/de.json"
		};
	},

	start: function() {
		Log.info(`Starting module: ${this.name}`);
		if (this.config.clearCacheOnStart) {
			this.waitingForCache = true;
			this.sendSocketNotification("CLEAR_CACHE");
		} else {
			this.showFirstPhoto();
		}
	},

	// Shows the photo stored by the last run, if there is one, and fetches
	// a new one only when it is due, so that a restart costs no Unsplash
	// request. Runs after Electron's cache is cleared: a cached image
	// would fail the cross-origin check (delightedCrow/WallberryTheme#8).
	showFirstPhoto: function() {
		const stored = this.readStoredPhoto();
		if (stored === null) {
			this.fetchRequestedPhoto();
			return;
		}
		// While the stored photo loads, a notification or resume only
		// records its source, as while waiting for the cache: fetching now
		// would drop the stored photo, and a failing fetch would leave the
		// screen black with the error message.
		this.restoring = true;
		this.loadPhoto(stored.photo, () => {
			this.restoring = false;
			if (this.requestedSource !== null) {
				this.fetchRequestedPhoto();
				return;
			}
			// A due photo is replaced right away; until the new one has
			// loaded, the stored one stays on screen. A shortened
			// updateInterval applies at once, not after the stored due time.
			this.scheduleFetch(Math.min(this.config.updateInterval, Math.max(0, stored.due - Date.now())));
		}, () => {
			this.restoring = false;
			this.discardStoredPhoto();
			this.fetchRequestedPhoto();
		});
	},

	// Fetches with the source a notification recorded, or with the
	// configured one.
	fetchRequestedPhoto: function() {
		const requested = this.requestedSource;
		this.requestedSource = null;
		this.fetchPhoto(requested ?? undefined);
	},

	getTemplate: function() {
		return "WallberryTheme.njk";
	},

	getTemplateData: function() {
		return {
			config: this.config,
			photoElement: this.photoElement,
			photoData: this.photoData,
			photoError: this.photoError,
			setBackgroundTint: this.setBackgroundTint,
			getHeight: this.getFadeHeight
		};
	},

	socketNotificationReceived: function(notification) {
		switch(notification) {
		case "ELECTRON_CACHE_CLEARED":
			this.waitingForCache = false;
			this.showFirstPhoto();
			break;
		}

	},

	// Another module asks for a new photo, e.g. MMM-pages' page change:
	// sendNotification("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]}).
	notificationReceived: function(notification, payload) {
		if (notification !== "WALLBERRY_FETCH_PHOTO") {
			return;
		}
		const source = this.photoSource(payload);
		// A hidden module must not use up Unsplash requests, the first
		// fetch waits for the cache, and a stored photo that is loading
		// must not be dropped: fetch with this source once it is shown
		// again, the cache is cleared or the stored photo is shown.
		if (this.suspended || this.waitingForCache || this.restoring) {
			this.requestedSource = source;
			return;
		}
		this.fetchPhoto(source);
	},

	// The queries and collections a fetch uses: the payload's, if it names
	// either, otherwise the configured ones. A payload replaces both, since
	// Unsplash does not combine a query with collections, and a configured
	// value must not narrow a page's own search.
	photoSource: function(payload) {
		const has = (key) => payload !== null && typeof payload === "object" &&
			payload[key] !== undefined && payload[key] !== null;
		if (!has("queries") && !has("collections")) {
			return {queries: this.config.queries, collections: this.config.collections};
		}
		const queries = has("queries") ? payload.queries : [];
		return {
			queries: Array.isArray(queries) ? queries : [queries],
			collections: has("collections") ? String(payload.collections) : ""
		};
	},

	// source: {queries, collections} from photoSource(), the configured
	// ones when left out
	fetchPhoto: function(source = this.photoSource()) {
		var url = "https://api.unsplash.com/photos/random?" +
			"client_id=" + this.config.unsplashAccessKey +
			"&collections=" + encodeURIComponent(source.collections) +
			"&orientation=" + this.config.orientation;

		if (source.queries.length > 0) {
			const query = source.queries[Math.floor(Math.random() * source.queries.length)];

			url = url +
				"&query=" + encodeURIComponent(query);
		}

		// This fetch replaces any that is scheduled or still running: it
		// schedules the next one itself, and a running one must not show
		// its photo or error over this one's. Dropping the image that may
		// still be loading makes loadPhoto() ignore it, also a stored one.
		clearTimeout(this.fetchTimer);
		this.img = null;
		this.restoring = false;
		this.fetchId += 1;
		const fetchId = this.fetchId;
		const isLatest = () => fetchId === this.fetchId;
		this.photoError = null;
		this.nextFetchTime = null;

		// The rejection handler covers only the request and reading its
		// body, so an error while showing the photo is not reported as a
		// connection error. Returns the promise for the tests.
		return fetch(url, {
			headers: {"Accept-Version": "v1"},
			signal: AbortSignal.timeout(this.requestTimeout)
		}).then((response) => {
			return response.text().then((responseText) => ({response, responseText}));
		}).then(({response, responseText}) => {
			if (!isLatest()) {
				return;
			}
			const result = this.parseUnsplashResponse(
				response.status,
				response.statusText,
				responseText,
				response.headers.get("X-Ratelimit-Remaining")
			);
			if (result.photo) {
				this.processPhoto(result.photo);
			} else {
				Log.error("Unsplash Error: ", response.status, responseText);
				this.processError(result.error);
			}
		}, (error) => {
			if (!isLatest()) {
				return;
			}
			if (error.name === "TimeoutError") {
				this.processError({key: "ERROR_TIMEOUT", variables: {seconds: this.requestTimeout / 1000}});
			} else {
				// most likely an internet connection issue
				this.processError({key: "ERROR_CONNECTION"});
			}
		});
	},

	// Turns an Unsplash response into either {photo} or {error}. Never
	// throws: a response whose body is not JSON, e.g. a rate limit
	// message or a proxy's error page, must still end in an error that
	// schedules the next fetch. An error is a translation key with its
	// variables, translated when the template renders it.
	parseUnsplashResponse: function(status, statusText, responseText, rateLimitRemaining) {
		let data = null;
		try {
			data = JSON.parse(responseText);
		} catch {
			data = null;
		}
		const isObject = data !== null && typeof data === "object";

		if (status === 200 && isObject && data.urls) {
			return {photo: data};
		}
		// The header is only readable if Unsplash exposes it to the
		// browser, so the body text serves as a second hint.
		if (rateLimitRemaining === "0" || (status === 403 && /rate limit/i.test(responseText))) {
			return {error: {key: "ERROR_RATE_LIMIT"}};
		}
		if (isObject && Array.isArray(data.errors)) {
			return {error: {key: "ERROR_API", variables: {errors: data.errors.join(", ")}}};
		}
		return {error: {key: "ERROR_STATUS", variables: {status: status, statusText: statusText}}};
	},

	// error: {key, variables} of a message in translations/
	processError: function(error) {
		this.photoError = error;
		this.updateDom();
		this.scheduleFetch(this.config.updateInterval);
	},

	// The only place that starts the fetch timer, so that resume() knows
	// when the next fetch is due. While suspended it only records the due
	// time: a hidden module must not use up Unsplash requests. Every new
	// due time is stored with the photo, also after an error, so that a
	// restart does not fetch earlier than the running module would.
	scheduleFetch: function(delay) {
		clearTimeout(this.fetchTimer);
		this.nextFetchTime = Date.now() + delay;
		this.storePhoto();
		if (this.suspended) {
			return;
		}
		this.fetchTimer = setTimeout(() => {
			this.fetchPhoto();
		}, delay);
	},

	processPhoto: function(photoData) {
		var p = {};
		const width = this.config.imageWidth === "auto" ? window.innerWidth : this.config.imageWidth;
		const height = this.config.imageHeight === "auto" ? window.innerHeight : this.config.imageHeight;

		p.url = photoData.urls.raw +
			"&w=" + width +
			"&h=" + height +
			"&" + this.config.imageOptions;

		// Unsplash sends us a color swatch for the image; the CSS derives
		// the tints of the background and the fades from its hue
		p.color = photoData.color;
		p.authorName = photoData.user.name;

		// Keep showing the previous photo and try again later if this one
		// fails to load.
		this.loadPhoto(p, () => {
			this.scheduleFetch(this.config.updateInterval);
		}, () => {
			this.scheduleFetch(this.config.updateInterval);
		});
	},

	// p: {url, color, authorName, needsDimming}; needsDimming is checked
	// on the image unless it is already known. Calls onShown once the
	// photo is on screen, onFailed if its image does not load.
	loadPhoto: function(p, onShown, onFailed) {
		// A fresh image per photo, and photoData and photoElement only
		// change once it has loaded: the template, resume() and the tint
		// read them, and must keep describing the photo on screen if this
		// one fails to load. Only the latest image counts, should an
		// earlier one finish after it.
		const img = document.createElement("img");
		this.img = img;

		img.style.opacity = this.config.backgroundOpacity;
		img.onload = () => {
			if (img !== this.img) {
				return;
			}
			if (this.config.autoDimOn && typeof p.needsDimming !== "boolean") {
				p.needsDimming = WBColor.needsDimming(img, this.getBarAreas(img.naturalHeight || img.height));
			}
			this.photoData = p;
			this.photoElement = img;
			this.updateDom(2000);
			onShown();
		};
		img.onerror = () => {
			if (img !== this.img) {
				return;
			}
			Log.error("WallberryTheme: could not load the photo ", p.url);
			onFailed();
		};

		img.crossOrigin = "Anonymous"; // otherwise we'll get a security error if we attempt to draw this image on the canvas later (when we check whether it needs dimming)
		img.src = p.url;
	},

	// The options that decide which photo Unsplash returns and how its
	// image is sized. A stored photo is shown only while they are the
	// same, so that a changed config shows a new photo at the next start.
	photoSettings: function() {
		const c = this.config;
		return JSON.stringify([c.queries, c.collections, c.orientation, c.imageWidth, c.imageHeight, c.imageOptions]);
	},

	// Keeps the photo on screen and its due time in the browser, so that
	// a restart or reload shows it again without an Unsplash request.
	// Each browser keeps its own. Without storage, e.g. when the browser
	// blocks it, the module works as if nothing was stored.
	storePhoto: function() {
		if (this.photoData === null) {
			return;
		}
		try {
			localStorage.setItem(this.storageKey, JSON.stringify({
				settings: this.photoSettings(),
				photo: this.photoData,
				due: this.nextFetchTime
			}));
		} catch (error) {
			Log.warn("WallberryTheme: could not store the photo ", error);
		}
	},

	// Returns {photo, due} of the stored photo, or null without a usable
	// one. A photo stored with other settings is discarded.
	readStoredPhoto: function() {
		let stored = null;
		try {
			const text = localStorage.getItem(this.storageKey);
			if (text === null) {
				return null;
			}
			stored = JSON.parse(text);
		} catch {
			stored = null;
		}
		const photo = stored?.photo;
		if (stored?.settings !== this.photoSettings() || typeof stored.due !== "number" ||
			typeof photo?.url !== "string" || typeof photo.authorName !== "string") {
			this.discardStoredPhoto();
			return null;
		}
		return {
			photo: {
				url: photo.url,
				color: photo.color,
				authorName: photo.authorName,
				// With autoDimOn: false the photo is not dimmed, whatever
				// was stored, and is stored again without a result, so that
				// turning autoDimOn on checks it; a photo stored without the
				// check gets it now.
				needsDimming: this.config.autoDimOn ? photo.needsDimming : undefined
			},
			due: stored.due
		};
	},

	discardStoredPhoto: function() {
		try {
			localStorage.removeItem(this.storageKey);
		} catch {
			// nothing stored that could be shown
		}
	},

	// The areas of the photo behind the top and bottom bar, as rows in
	// fractions of imageHeight: the rows of the bar region, where the text
	// sits, and the rows of its fade, which is taller. The photo is shown
	// at its natural size from the top of the screen.
	getBarAreas: function(imageHeight) {
		const screenHeight = window.innerHeight;
		return ["top", "bottom"].map((position) => {
			const regionClassName = `region ${position} bar`;
			const region = document.getElementsByClassName(regionClassName)[0].getBoundingClientRect();
			const fadeHeight = Math.max(this.fadeMinHeight, this.getFadeHeight(regionClassName));
			const fadeStart = position === "top" ? 0 : screenHeight - fadeHeight;
			return {
				start: region.top / imageHeight,
				end: region.bottom / imageHeight,
				fade: this.config.addBackgroundFade.includes(position) ? position : null,
				fadeStart: fadeStart / imageHeight,
				fadeEnd: (fadeStart + fadeHeight) / imageHeight
			};
		});
	},

	suspend: function() {
		Log.info("Suspending WallberryTheme...");
		this.suspended = true;
		this.setBackgroundTint(null); // set background back to black
		clearTimeout(this.fetchTimer);
	},

	resume: function() {
		Log.info("Waking WallberryTheme...");
		this.suspended = false;
		clearTimeout(this.fetchTimer);
		// The stored photo that is loading fetches the recorded source once
		// it is shown, and schedules the next fetch otherwise.
		if (this.restoring) {
			if (this.config.newPhotoOnResume && this.requestedSource === null) {
				this.requestedSource = this.photoSource();
			}
			return;
		}
		if (this.requestedSource !== null || this.config.newPhotoOnResume) {
			this.fetchRequestedPhoto();
			return;
		}

		// Keep the photo: restore the tint suspend() reset, and fetch when
		// the photo is due, counting the time the module was hidden.
		if (this.photoData) {
			this.setBackgroundTint(this.photoData.color);
		}
		// Without a due time a fetch is running, and it schedules the next.
		if (this.nextFetchTime !== null) {
			const remaining = this.nextFetchTime - Date.now();
			if (remaining > 0) {
				this.scheduleFetch(remaining);
			} else {
				this.fetchPhoto();
			}
		}
	},

	nunjucksEnvironment: function() {
		if (this._nunjucksEnvironment !== null) {
			return this._nunjucksEnvironment;
		}

		var self = this;

		this._nunjucksEnvironment = new nunjucks.Environment(new nunjucks.WebLoader(this.file(""), {async: true, useCache: true}), {
			trimBlocks: true,
			lstripBlocks: true
		});
		this._nunjucksEnvironment.addFilter("translate", function(str, variables) {
			return self.translate(str, variables);
		});

		return this._nunjucksEnvironment;
	},

	/*
			NUNJUCKS TEMPLATE HELPERS
			The following functions are passed to and used by the nunjucks template
			TODO: These should probably be added as nunjucks filters to our nunjucks environment above
	*/
	getFadeHeight: function(regionClassName) {
		// we auto-adjust the height of the background fades to be at least the height of the top bar region and bottom bar regions, in case they're bigger than the 250px min height we set in the css
		const region = document.getElementsByClassName(regionClassName)[0];
		return region.clientHeight + 70; // +70 for margin+padding
	},

	// swatch: the photo's colour swatch as a CSS colour, or null for black
	setBackgroundTint: function(swatch) {
		// setting the html/body background colors to the dark shade gives a much richer color to the image when it becomes transparent.
		// We set the image to be transparent when we want to dim it (because the black background then comes through), but having a pure black background can cause the image to look greyish and washed out.
		// The fades read --wb-swatch too, through the tints in css/WallberryTheme.css.
		const html = document.documentElement;
		const body = document.body;
		let background = "black";
		if (swatch) {
			html.style.setProperty("--wb-swatch", swatch);
			background = "var(--wb-tint-dark)";
		} else {
			html.style.removeProperty("--wb-swatch");
		}
		body.style.backgroundColor = background;
		html.style.backgroundColor = background;
	},
});
