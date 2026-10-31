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
	img: null,
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
			this.sendSocketNotification("CLEAR_CACHE");
		} else {
			this.fetchPhoto();
		}
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
			this.fetchPhoto();
			break;
		}

	},

	fetchPhoto: function() {
		var url = "https://api.unsplash.com/photos/random?" +
			"client_id=" + this.config.unsplashAccessKey +
			"&collections=" + this.config.collections +
			"&orientation=" + this.config.orientation;

		if (this.config.queries.length > 0) {
			const query = this.config.queries[Math.floor(Math.random() * this.config.queries.length)];

			url = url +
				"&query=" + encodeURIComponent(query);
		}

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
	// when the next fetch is due.
	scheduleFetch: function(delay) {
		clearTimeout(this.fetchTimer);
		this.nextFetchTime = Date.now() + delay;
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
		this.photoData = p;

		if (this.img === null)
			this.img = document.createElement("img");

		this.img.style.opacity = this.config.backgroundOpacity;
		this.img.onload = () => {
			if (this.config.autoDimOn) {
				this.photoData.needsDimming = WBColor.needsDimming(this.img, this.getBarAreas(this.img.naturalHeight || this.img.height));
			}
			this.updateDom(2000);
			this.scheduleFetch(this.config.updateInterval);
		};

		this.img.crossOrigin = "Anonymous"; // otherwise we'll get a security error if we attempt to draw this image on the canvas later (when we check whether it needs dimming)
		this.img.src = this.photoData.url;
		this.photoElement = this.img;
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
		this.setBackgroundTint(null); // set background back to black
		clearTimeout(this.fetchTimer);
	},

	resume: function() {
		Log.info("Waking WallberryTheme...");
		clearTimeout(this.fetchTimer);
		if (this.config.newPhotoOnResume) {
			this.fetchPhoto();
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
