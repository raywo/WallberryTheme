/* WBUnsplashSource is WallberryTheme's built-in photo source: it decides
 * which Unsplash photo comes when, and hands it to the theme, which only
 * shows it. Theme and source talk only through this interface:
 *
 * - setThemeState("awake" | "asleep"), theme to source. While asleep the
 *   source fetches nothing. The first awake delivers a photo: the stored
 *   one while it is valid, or a new one; a later awake fetches only if
 *   newPhotoOnResume or a fetch request asks for it, or a photo is due.
 * - requestPhoto(payload), theme to source: the payload of
 *   WALLBERRY_FETCH_PHOTO. Fetches a new photo right away, or once awake.
 * - onPhoto({source, url, color, author, needsDimming}), source to theme.
 * - onError({source, message}), source to theme, message translated.
 *
 * There is no channel back: the source does not learn whether its photo
 * loaded or what auto-dim found. Do not add one here; other sources fill
 * the same interface by notification.
 */
// biome-ignore lint/correctness/noUnusedVariables: a global for the other scripts MagicMirror² loads
class WBUnsplashSource {
	// options: {config, translate, onPhoto, onError}; config holds the
	// options of WallberryTheme, translate(key, variables) its translations
	constructor(options) {
		this.config = options.config;
		this.translate = options.translate;
		this.onPhoto = options.onPhoto;
		this.onError = options.onError;

		this.name = "unsplash";
		this.storageKey = "WallberryTheme.photo"; // localStorage key of the photo delivered last, see storePhoto()
		this.requestTimeout = 30 * 1000; // abort an Unsplash request that has not answered after 30 s
		this.state = "new"; // "new" until the first awake, then "awake" or "asleep"
		this.photo = null; // {url, color, authorName, needsDimming} delivered last
		this.fetchTimer = null;
		this.nextFetchTime = null; // ms timestamp the scheduled fetch is due at, null while a fetch runs
		this.fetchId = 0; // counts the fetches, so that only the latest one delivers its result
		this.requestedSource = null; // {queries, collections} of a request that arrived while it could not fetch
		this.probe = null; // the image of the stored photo while checkImage() loads it
	}

	setThemeState(state) {
		if (state === "asleep") {
			// Before the first awake nothing runs, and that awake still
			// delivers the first photo.
			if (this.state !== "new") {
				this.state = "asleep";
			}
			clearTimeout(this.fetchTimer);
			return;
		}
		if (state !== "awake") {
			return;
		}
		const first = this.state === "new";
		this.state = "awake";
		if (first) {
			this.deliverFirstPhoto();
		} else {
			this.wake();
		}
	}

	// Another module asks for a new photo, e.g. MMM-pages' page change:
	// sendNotification("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]}).
	requestPhoto(payload) {
		const source = this.photoSource(payload);
		// An asleep theme must not use up Unsplash requests, the first
		// fetch waits for the first awake, and a stored photo that is being
		// checked must not be dropped: fetch with this source once awake
		// or once the stored photo is delivered.
		if (this.state !== "awake" || this.probe !== null) {
			this.requestedSource = source;
			return;
		}
		this.fetchPhoto(source);
	}

	// Delivers the photo stored by the last run, if there is one, and
	// fetches a new one only when it is due, so that a restart costs no
	// Unsplash request. The theme sends the first awake after Electron's
	// cache is cleared: a cached image would fail the cross-origin check
	// (delightedCrow/WallberryTheme#8).
	deliverFirstPhoto() {
		const stored = this.readStoredPhoto();
		if (stored === null) {
			this.fetchRequestedPhoto();
			return;
		}
		// While the stored photo is checked, a request or awake only
		// records its source: fetching now would drop the stored photo.
		this.checkImage(stored.photo.url, () => {
			this.deliver(stored.photo);
			if (this.requestedSource !== null) {
				this.fetchRequestedPhoto();
				return;
			}
			// A due photo is replaced right away; until the new one arrives,
			// the stored one stays on screen. A shortened updateInterval
			// applies at once, not after the stored due time.
			this.scheduleFetch(Math.min(this.config.updateInterval, Math.max(0, stored.due - Date.now())));
		}, () => {
			this.discardStoredPhoto();
			this.fetchRequestedPhoto();
		});
	}

	// Loads the image of the stored photo before delivering it: the theme
	// does not report whether a photo loaded, and a stored photo whose
	// image fails must be discarded and replaced, not leave the screen
	// black. Tries once more without crossOrigin, as the theme does, so
	// that every photo the theme can show passes.
	checkImage(url, onLoaded, onFailed) {
		const load = (readable) => {
			const img = document.createElement("img");
			this.probe = img;
			img.onload = () => {
				if (img !== this.probe) {
					return;
				}
				this.probe = null;
				onLoaded();
			};
			img.onerror = () => {
				if (img !== this.probe) {
					return;
				}
				if (readable) {
					load(false);
					return;
				}
				this.probe = null;
				onFailed();
			};
			if (readable) {
				img.crossOrigin = "Anonymous";
			}
			img.src = url;
		};
		load(true);
	}

	// A later awake: fetches with a recorded request or with
	// newPhotoOnResume, and otherwise when the photo is due, counting the
	// time the theme was asleep.
	wake() {
		clearTimeout(this.fetchTimer);
		// The stored photo being checked fetches the recorded source once
		// it is delivered, and schedules the next fetch otherwise.
		if (this.probe !== null) {
			if (this.config.newPhotoOnResume && this.requestedSource === null) {
				this.requestedSource = this.photoSource();
			}
			return;
		}
		if (this.requestedSource !== null || this.config.newPhotoOnResume) {
			this.fetchRequestedPhoto();
			return;
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
	}

	// Fetches with the source a request recorded, or with the configured
	// one.
	fetchRequestedPhoto() {
		const requested = this.requestedSource;
		this.requestedSource = null;
		this.fetchPhoto(requested ?? undefined);
	}

	// The queries and collections a fetch uses: the payload's, if it names
	// either, otherwise the configured ones. A payload replaces both, since
	// Unsplash does not combine a query with collections, and a configured
	// value must not narrow a page's own search.
	photoSource(payload) {
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
	}

	// source: {queries, collections} from photoSource(), the configured
	// ones when left out
	fetchPhoto(source = this.photoSource()) {
		let url = "https://api.unsplash.com/photos/random?" +
			"client_id=" + this.config.unsplashAccessKey +
			"&collections=" + encodeURIComponent(source.collections) +
			"&orientation=" + this.config.orientation;

		if (source.queries.length > 0) {
			const query = source.queries[Math.floor(Math.random() * source.queries.length)];

			url = url +
				"&query=" + encodeURIComponent(query);
		}

		// This fetch replaces any that is scheduled or still running, and
		// a stored photo being checked: it schedules the next one itself,
		// and a running one must not deliver its photo or error after
		// this one's.
		clearTimeout(this.fetchTimer);
		this.probe = null;
		this.fetchId += 1;
		const fetchId = this.fetchId;
		const isLatest = () => fetchId === this.fetchId;
		this.nextFetchTime = null;

		// The rejection handler covers only the request and reading its
		// body, so an error while delivering the photo is not reported as
		// a connection error. Returns the promise for the tests.
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
	}

	// Turns an Unsplash response into either {photo} or {error}. Never
	// throws: a response whose body is not JSON, e.g. a rate limit
	// message or a proxy's error page, must still end in an error that
	// schedules the next fetch. An error is a translation key with its
	// variables.
	parseUnsplashResponse(status, statusText, responseText, rateLimitRemaining) {
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
	}

	// error: {key, variables} of a message in translations/
	processError(error) {
		this.onError({source: this.name, message: this.translate(error.key, error.variables)});
		this.scheduleFetch(this.config.updateInterval);
	}

	// Sizes the image for the screen, delivers the photo and schedules the
	// next fetch: whether its image loads, the source does not learn.
	processPhoto(photoData) {
		const width = this.config.imageWidth === "auto" ? window.innerWidth : this.config.imageWidth;
		const height = this.config.imageHeight === "auto" ? window.innerHeight : this.config.imageHeight;

		this.deliver({
			url: photoData.urls.raw +
				"&w=" + width +
				"&h=" + height +
				"&" + this.config.imageOptions,
			// Unsplash sends a colour swatch for the image; the theme derives
			// the tints of the background and the fades from its hue
			color: photoData.color,
			authorName: photoData.user.name
		});
		this.scheduleFetch(this.config.updateInterval);
	}

	// photo: {url, color, authorName, needsDimming}, the stored format;
	// needsDimming only comes from a photo an earlier version stored
	deliver(photo) {
		this.photo = photo;
		this.onPhoto({
			source: this.name,
			url: photo.url,
			color: photo.color,
			author: photo.authorName,
			needsDimming: photo.needsDimming
		});
	}

	// The only place that starts the fetch timer, so that wake() knows
	// when the next fetch is due. While not awake it only records the due
	// time: an asleep theme must not use up Unsplash requests. Every new
	// due time is stored with the photo, also after an error, so that a
	// restart does not fetch earlier than the running source would.
	scheduleFetch(delay) {
		clearTimeout(this.fetchTimer);
		this.nextFetchTime = Date.now() + delay;
		this.storePhoto();
		if (this.state !== "awake") {
			return;
		}
		this.fetchTimer = setTimeout(() => {
			this.fetchPhoto();
		}, delay);
	}

	// The options that decide which photo Unsplash returns and how its
	// image is sized. A stored photo is delivered only while they are the
	// same, so that a changed config shows a new photo at the next start.
	photoSettings() {
		const c = this.config;
		return JSON.stringify([c.queries, c.collections, c.orientation, c.imageWidth, c.imageHeight, c.imageOptions]);
	}

	// Keeps the photo delivered last and its due time in the browser, so
	// that a restart or reload shows it again without an Unsplash request.
	// Stored without a dimming result, which the source does not learn.
	// Each browser keeps its own. Without storage, e.g. when the browser
	// blocks it, the source works as if nothing was stored.
	storePhoto() {
		if (this.photo === null) {
			return;
		}
		try {
			localStorage.setItem(this.storageKey, JSON.stringify({
				settings: this.photoSettings(),
				photo: {url: this.photo.url, color: this.photo.color, authorName: this.photo.authorName},
				due: this.nextFetchTime
			}));
		} catch (error) {
			Log.warn("WallberryTheme: could not store the photo ", error);
		}
	}

	// Returns {photo, due} of the stored photo, or null without a usable
	// one. A photo stored with other settings is discarded.
	readStoredPhoto() {
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
				needsDimming: typeof photo.needsDimming === "boolean" ? photo.needsDimming : undefined
			},
			due: stored.due
		};
	}

	discardStoredPhoto() {
		try {
			localStorage.removeItem(this.storageKey);
		} catch {
			// nothing stored that could be delivered
		}
	}
}
