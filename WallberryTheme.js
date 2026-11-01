/* MagicMirror² - WallberryTheme <3
 * Module: WallberryTheme
 *
 * By JSC (@delightedCrow)
 * MIT Licensed.
 */

Module.register("WallberryTheme", {
	defaults: {
		unsplashAccessKey: "", // the built-in Unsplash source runs only with a key

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
	photoReceived: false, // true once any source delivered a photo
	suspended: false, // true between suspend() and resume()
	waitingForCache: false, // true from start() until Electron's cache is cleared
	waitingForModules: false, // true from start() until MagicMirror² started all modules
	unsplash: null, // the WBUnsplashSource, created in start() with an unsplashAccessKey
	img: null,
	noPhotoDelay: 60 * 1000, // ms after the first awake until the message that no source delivered a photo
	fadeMinHeight: 250, // px, the min-height of .wbfade in css/WallberryTheme.css

	getStyles: function() {
		return [
			this.file("css/WallberryTheme.css"),
			"font-awesome.css"
		];
	},

	getScripts: function() {
		return ["colorHelpers.js", "unsplashSource.js"];
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
		// Without a key the Unsplash source would only fail: it requests
		// nothing, and its stored photo stays unshown.
		const key = this.config.unsplashAccessKey;
		this.unsplash = typeof key === "string" && key.trim() !== "" ? this.createUnsplashSource() : null;
		// MagicMirror² delivers notifications only once it started all
		// modules: a state sent before would reach no other source.
		this.waitingForModules = true;
		if (this.config.clearCacheOnStart) {
			this.waitingForCache = true;
			this.sendSocketNotification("CLEAR_CACHE");
		}
	},

	// The theme talks to its internal photo source only through the
	// interface described in unsplashSource.js: photos and errors come
	// in, the theme state and fetch requests go out. Other sources use the
	// same interface by notification, see notificationReceived().
	createUnsplashSource: function() {
		return new WBUnsplashSource({
			config: this.config,
			translate: (key, variables) => this.translate(key, variables),
			onPhoto: (photo) => this.receivePhoto(photo),
			onError: (error) => this.receiveError(error)
		});
	},

	// The first awake, once Electron's cache is cleared: a cached image
	// would fail the cross-origin check (delightedCrow/WallberryTheme#8),
	// and once all modules started, so that every source receives it.
	// A theme already suspended still lets the source deliver its first
	// photo, and is asleep right after.
	wakeSource: function() {
		if (this.waitingForCache || this.waitingForModules) {
			return;
		}
		this.sendThemeState("awake");
		if (this.suspended) {
			this.sendThemeState("asleep");
		}
		setTimeout(() => this.showNoPhotoMessage(), this.noPhotoDelay);
	},

	// state: "awake" or "asleep", to the internal source and, as
	// WALLBERRY_THEME_STATE, to all other sources; sent from the first
	// awake on
	sendThemeState: function(state) {
		if (this.waitingForCache || this.waitingForModules) {
			return;
		}
		if (this.unsplash !== null) {
			this.unsplash.setThemeState(state);
		}
		this.sendNotification("WALLBERRY_THEME_STATE", {state: state});
	},

	// Tells the user, once the first sources had their time, that none of
	// them delivered a photo; an error a source sent says more and stays.
	showNoPhotoMessage: function() {
		if (this.photoReceived || this.photoError !== null) {
			return;
		}
		this.photoError = {source: this.name, message: this.translate("ERROR_NO_PHOTO")};
		this.updateDom();
	},

	// photo: {source, url, color, author, needsDimming} from a source;
	// the newest photo received is shown once its image has loaded
	receivePhoto: function(photo) {
		this.photoReceived = true;
		this.loadPhoto({
			source: photo.source,
			url: photo.url,
			// A colour or author of another type is left out, as if the
			// source had not sent it.
			color: typeof photo.color === "string" ? photo.color : undefined,
			authorName: typeof photo.author === "string" ? photo.author : undefined,
			// With autoDimOn: false the photo is not dimmed, whatever the
			// source knows about it.
			needsDimming: this.config.autoDimOn && typeof photo.needsDimming === "boolean" ? photo.needsDimming : undefined
		});
	},

	// error: {source, message}, message already translated; the template
	// shows it only while no photo is on screen
	receiveError: function(error) {
		this.photoError = error;
		if (this.photoElement === null) {
			this.updateDom();
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
			// The helper answers every browser, also when another one
			// connects later: only the first answer wakes the sources.
			if (!this.waitingForCache) {
				break;
			}
			this.waitingForCache = false;
			this.wakeSource();
			break;
		}

	},

	// The notifications of the photo source contract, which the README
	// documents for authors of a source. Changing a field or its timing
	// breaks every source. MagicMirror² does not deliver a module's own
	// notifications to itself, so the internal source is called directly.
	notificationReceived: function(notification, payload) {
		switch (notification) {
		case "ALL_MODULES_STARTED":
			this.waitingForModules = false;
			this.wakeSource();
			break;
		case "WALLBERRY_PHOTO":
			if (!this.isFromSource(payload, "url")) {
				Log.warn("WallberryTheme: ignoring a WALLBERRY_PHOTO without source and url as strings ", payload);
				return;
			}
			this.receivePhoto(payload);
			break;
		case "WALLBERRY_PHOTO_ERROR":
			if (!this.isFromSource(payload, "message")) {
				Log.warn("WallberryTheme: ignoring a WALLBERRY_PHOTO_ERROR without source and message as strings ", payload);
				return;
			}
			this.receiveError({source: payload.source, message: payload.message});
			break;
		case "WALLBERRY_FETCH_PHOTO":
			// Other sources receive it from its sender, e.g. MMM-pages' page
			// change: sendNotification("WALLBERRY_FETCH_PHOTO", {queries:
			// ["sports"]}). The source decides when it fetches.
			if (this.unsplash !== null) {
				this.unsplash.requestPhoto(payload);
			}
			break;
		}
	},

	// Whether payload names its source and the given field as strings
	isFromSource: function(payload, field) {
		return payload !== null && typeof payload === "object" &&
			typeof payload.source === "string" && typeof payload[field] === "string";
	},

	// p: {source, url, color, authorName, needsDimming}; needsDimming is checked
	// on the image unless it is already known.
	loadPhoto: function(p) {
		// A fresh image per attempt, and photoData and photoElement only
		// change once it has loaded: the template, resume() and the tint
		// read them, and must keep describing the photo on screen if this
		// one fails to load. Only the latest image counts, should an
		// earlier one finish after it.
		// readable: load with crossOrigin, so that auto-dim may read the
		// pixels. The browser then refuses an image whose server sends no
		// Access-Control-Allow-Origin header, and does not tell that apart
		// from any other error, so every failed load is tried once more
		// without crossOrigin; a missing image fails twice.
		const load = (readable) => {
			const img = document.createElement("img");
			this.img = img;

			img.style.opacity = this.config.backgroundOpacity;
			img.onload = () => {
				if (img !== this.img) {
					return;
				}
				if (!readable) {
					// Its pixels cannot be read: shown at backgroundOpacity.
					p.needsDimming = undefined;
					Log.warn("WallberryTheme: the photo's server does not allow reading it, showing it without auto-dim ", p.url);
				} else if (this.config.autoDimOn && typeof p.needsDimming !== "boolean") {
					p.needsDimming = this.checkDimming(img, p.url);
				}
				this.photoData = p;
				this.photoElement = img;
				this.updateDom(2000);
			};
			img.onerror = () => {
				if (img !== this.img) {
					return;
				}
				if (readable) {
					load(false);
					return;
				}
				// The photo on screen stays until the source sends the next.
				Log.error("WallberryTheme: could not load the photo ", p.url);
			};

			if (readable) {
				img.crossOrigin = "Anonymous";
			}
			img.src = p.url;
		};
		load(true);
	},

	// Whether the loaded image needs dimming, or undefined if the check
	// fails, e.g. on a canvas the browser considers tainted. A failed
	// check must not keep the photo from being shown.
	checkDimming: function(img, url) {
		try {
			return WBColor.needsDimming(img, this.getBarAreas(img.naturalHeight || img.height));
		} catch (error) {
			Log.warn("WallberryTheme: could not check whether the photo needs dimming, showing it undimmed ", url, error);
			return undefined;
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
		this.sendThemeState("asleep");
	},

	resume: function() {
		Log.info("Waking WallberryTheme...");
		this.suspended = false;
		// Restore the tint suspend() reset; the source decides whether a
		// new photo comes.
		if (this.photoData) {
			this.setBackgroundTint(this.photoData.color);
		}
		this.sendThemeState("awake");
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
