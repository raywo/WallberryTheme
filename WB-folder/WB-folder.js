/* MagicMirror² - WallberryTheme <3
 * Module: WB-folder
 *
 * A photo source for WallberryTheme: shows the photos of a folder on the
 * mirror. It is also meant as a template for writing a source; comments
 * starting with "Every source" mark what each source has to do, see
 * "Writing a photo source" in WallberryTheme's README.
 *
 * MIT Licensed.
 */

Module.register("WB-folder", {
	defaults: {
		folder: "", // required; absolute, or relative to the MagicMirror² directory
		updateInterval: 300 * 1000 // 5 min, as WallberryTheme's
	},

	// node_helper.js reads folder with getServerModuleConfig(), which came
	// with this version
	requiresVersion: "2.38.0",

	sourceName: "WB-folder", // the source of every photo and error this module sends
	state: "new", // "new" until the theme's first awake, then "awake" or "asleep"
	current: null, // the file name of the photo delivered last
	pickTimer: null,
	nextPickTime: null, // ms timestamp the scheduled pick is due at, null while a pick runs
	pickRequested: false, // true if WALLBERRY_FETCH_PHOTO arrived while asleep
	requestId: null, // the id of the running pick, null if none runs
	requestCount: 0,
	browserId: null, // tells this browser's picks from those of other browsers

	getTranslations: function() {
		return {
			en: "translations/en.json",
			de: "translations/de.json"
		};
	},

	start: function() {
		Log.info(`Starting module: ${this.name}`);
		this.browserId = Math.random().toString(36).slice(2);
		// Every source: deliver nothing before WallberryTheme's first
		// awake, which comes once all modules started and Electron's cache
		// is cleared.
	},

	notificationReceived: function(notification, payload) {
		switch (notification) {
		case "WALLBERRY_THEME_STATE":
			this.setThemeState(payload?.state);
			break;
		case "WALLBERRY_FETCH_PHOTO":
			// Every source decides itself whether a request changes its
			// photo; this one ignores the payload, which names Unsplash
			// queries.
			this.requestPhoto();
			break;
		}
	},

	// Every source: deliver a photo on the first awake, also if asleep
	// follows right after, and fetch nothing while asleep.
	setThemeState: function(state) {
		if (state === "asleep") {
			// Before the first awake nothing runs, and that awake still
			// delivers the first photo.
			if (this.state !== "new") {
				this.state = "asleep";
			}
			clearTimeout(this.pickTimer);
			return;
		}
		if (state !== "awake") {
			return;
		}
		const first = this.state === "new";
		this.state = "awake";
		if (first) {
			this.pickPhoto();
		} else {
			this.wake();
		}
	},

	// A later awake picks a photo if one was requested or is due, counting
	// the time the theme was asleep.
	wake: function() {
		clearTimeout(this.pickTimer);
		if (this.pickRequested) {
			this.pickRequested = false;
			this.pickPhoto();
			return;
		}
		// Without a due time a pick is running, and it schedules the next.
		if (this.nextPickTime !== null) {
			this.schedulePick(Math.max(0, this.nextPickTime - Date.now()));
		}
	},

	// WALLBERRY_FETCH_PHOTO: a new photo right away, or once awake. Before
	// the first awake, that awake brings one anyway.
	requestPhoto: function() {
		if (this.state === "awake") {
			this.pickPhoto();
		} else if (this.state === "asleep") {
			this.pickRequested = true;
		}
	},

	// Asks the node helper for a photo other than the one on screen. A
	// newer pick replaces a running one: only the latest id is answered.
	pickPhoto: function() {
		clearTimeout(this.pickTimer);
		this.nextPickTime = null;
		this.requestCount += 1;
		this.requestId = `${this.browserId}-${this.requestCount}`;
		this.sendSocketNotification("WB_FOLDER_PICK_PHOTO", {requestId: this.requestId, current: this.current});
	},

	// The only place that starts the pick timer, so that wake() knows when
	// the next pick is due. While not awake it only records the due time.
	schedulePick: function(delay) {
		clearTimeout(this.pickTimer);
		this.nextPickTime = Date.now() + delay;
		if (this.state !== "awake") {
			return;
		}
		this.pickTimer = setTimeout(() => this.pickPhoto(), delay);
	},

	// Every source with a node helper: ignore answers to other browsers,
	// as MagicMirror² sends a socket notification to all of them.
	socketNotificationReceived: function(notification, payload) {
		if (payload?.requestId !== this.requestId || this.requestId === null) {
			return;
		}
		switch (notification) {
		case "WB_FOLDER_PHOTO":
			this.loadPhoto(payload.name, payload.url);
			break;
		case "WB_FOLDER_ERROR":
			this.requestId = null;
			this.sendError(payload.error, payload.folder);
			this.schedulePick(this.config.updateInterval);
			break;
		}
	},

	// Every source: send WALLBERRY_PHOTO_ERROR with a message translated
	// into the user's language; WallberryTheme shows it as it is.
	// error: "noFolder", "missing", "unreadable" or "empty" from the helper
	sendError: function(error, folder) {
		const keys = {
			noFolder: "ERROR_NO_FOLDER",
			missing: "ERROR_FOLDER_MISSING",
			unreadable: "ERROR_FOLDER_UNREADABLE",
			empty: "ERROR_FOLDER_EMPTY"
		};
		this.sendNotification("WALLBERRY_PHOTO_ERROR", {
			source: this.sourceName,
			message: this.translate(keys[error] ?? "ERROR_FOLDER_UNREADABLE", {folder: folder})
		});
	},

	// Loads the photo from the mirror's server, sizes it for the screen
	// and delivers it.
	loadPhoto: function(name, url) {
		const requestId = this.requestId;
		const img = new Image();
		img.onload = () => {
			if (requestId !== this.requestId) {
				return;
			}
			this.requestId = null;
			let photoUrl = null;
			try {
				photoUrl = this.cropToScreen(img);
			} catch (error) {
				Log.error(`${this.name}: could not size the photo ${name} for the screen `, error);
			}
			if (photoUrl !== null) {
				this.deliver(name, photoUrl);
			}
			this.schedulePick(this.config.updateInterval);
		};
		img.onerror = () => {
			if (requestId !== this.requestId) {
				return;
			}
			this.requestId = null;
			Log.error(`${this.name}: could not load the photo ${name}`);
			this.schedulePick(this.config.updateInterval);
		};
		img.src = url;
	},

	// Every source: send WALLBERRY_PHOTO with source and url. WallberryTheme
	// shows the image at its natural size, so size it for the screen, and
	// serve it from the mirror's own origin or as a data URL, so that
	// auto-dim may read its pixels.
	deliver: function(name, url) {
		this.current = name;
		this.sendNotification("WALLBERRY_PHOTO", {source: this.sourceName, url: url});
	},

	// Draws the image scaled and cropped to the screen, centred, and
	// returns it as a JPEG data URL.
	cropToScreen: function(img) {
		const width = Math.round(window.innerWidth);
		const height = Math.round(window.innerHeight);
		const crop = this.coverCrop(img.naturalWidth, img.naturalHeight, width, height);
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		canvas.getContext("2d").drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
		return canvas.toDataURL("image/jpeg", 0.9);
	},

	// The part of an image of sourceWidth × sourceHeight that covers a
	// target of targetWidth × targetHeight without distortion: as much of
	// the image as fits the target's aspect ratio, centred.
	coverCrop: function(sourceWidth, sourceHeight, targetWidth, targetHeight) {
		const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
		const width = Math.min(sourceWidth, targetWidth / scale);
		const height = Math.min(sourceHeight, targetHeight / scale);
		return {
			x: (sourceWidth - width) / 2,
			y: (sourceHeight - height) / 2,
			width: width,
			height: height
		};
	}
});
