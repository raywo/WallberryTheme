const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {loadScripts} = require("./helpers/load-scripts");

const REPO_ROOT = path.join(__dirname, "..");
const INTERVAL = 300 * 1000;

// Objects made in the scripts' context have that context's prototypes,
// which deepEqual tells apart from this one's.
const plain = (value) => JSON.parse(JSON.stringify(value));

function readTranslation(language) {
	return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "WB-folder", "translations", `${language}.json`), "utf8"));
}

/**
 * Creates WB-folder's browser side with recorded timers, socket and
 * module notifications, and images that load only when a test says so.
 * cropToScreen is replaced, as the tests have no canvas.
 */
function createModule(config = {}, translation = readTranslation("en")) {
	const timers = new Map();
	let timerId = 0;
	const clock = {now: 0};
	const images = [];
	const scripts = loadScripts(["WB-folder/WB-folder.js"], {
		setTimeout: (callback, delay) => {
			timerId += 1;
			timers.set(timerId, {callback, delay});
			return timerId;
		},
		clearTimeout: (id) => timers.delete(id),
		Date: {now: () => clock.now},
		Image: function() {
			images.push(this);
		}
	});
	const definition = scripts.modules["WB-folder"];
	const mod = Object.create(definition);
	mod.name = "WB-folder";
	mod.config = {...definition.defaults, ...config};
	mod.socket = [];
	mod.notifications = [];
	mod.sendSocketNotification = (notification, payload) => mod.socket.push({notification, payload});
	mod.sendNotification = (notification, payload) => mod.notifications.push({notification, payload});
	mod.translate = (key, variables) => translation[key].replace(/{([^}]+)}/g, (_placeholder, name) => variables[name]);
	mod.cropToScreen = (img) => `data:image/jpeg;base64,${img.src}`;
	mod.start();

	const picks = () => mod.socket.filter((s) => s.notification === "WB_FOLDER_PICK_PHOTO");
	const lastPick = () => picks().at(-1).payload;
	// Answers the latest pick with a photo and loads its image.
	const answerPhoto = (name) => {
		mod.socketNotificationReceived("WB_FOLDER_PHOTO", {requestId: lastPick().requestId, name, url: `WB-folder/photos/${name}`});
		images.at(-1).onload();
	};
	const photos = () => mod.notifications.filter((n) => n.notification === "WALLBERRY_PHOTO").map((n) => n.payload);
	const errors = () => mod.notifications.filter((n) => n.notification === "WALLBERRY_PHOTO_ERROR").map((n) => n.payload);
	// Runs the timer that is due, as the browser would after its delay.
	const runTimer = () => {
		const [id, timer] = [...timers.entries()].at(-1);
		timers.delete(id);
		clock.now += timer.delay;
		timer.callback();
	};
	return {mod, timers, clock, images, picks, lastPick, answerPhoto, photos, errors, runTimer, log: scripts.log};
}

describe("WB-folder coverCrop", () => {
	const {mod} = createModule();

	it("crops the sides of a landscape image for a portrait screen, centred", () => {
		assert.deepEqual(plain(mod.coverCrop(4000, 3000, 1080, 1920)), {x: (4000 - 1687.5) / 2, y: 0, width: 1687.5, height: 3000});
	});

	it("crops top and bottom of a portrait image for a landscape screen, centred", () => {
		assert.deepEqual(plain(mod.coverCrop(3000, 4000, 1920, 1080)), {x: 0, y: (4000 - 1687.5) / 2, width: 3000, height: 1687.5});
	});

	it("keeps the whole image when it has the screen's aspect ratio, also when smaller", () => {
		assert.deepEqual(plain(mod.coverCrop(540, 960, 1080, 1920)), {x: 0, y: 0, width: 540, height: 960});
	});
});

describe("WB-folder and the theme's state", () => {
	it("picks nothing before the first awake", () => {
		const {mod, picks} = createModule();
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO");
		assert.equal(picks().length, 0);
	});

	it("delivers a photo on the first awake and picks the next one every updateInterval", () => {
		const {mod, timers, lastPick, answerPhoto, photos, runTimer} = createModule({updateInterval: 60000});
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		assert.equal(lastPick().current, null);
		answerPhoto("a.jpg");
		assert.deepEqual(plain(photos()), [{source: "WB-folder", url: "data:image/jpeg;base64,WB-folder/photos/a.jpg"}]);
		assert.deepEqual([...timers.values()].map((t) => t.delay), [60000]);

		runTimer();
		assert.equal(lastPick().current, "a.jpg");
		answerPhoto("b.jpg");
		assert.equal(photos().length, 2);
	});

	it("delivers the first photo when asleep follows right after the first awake", () => {
		const {mod, answerPhoto, photos, timers} = createModule();
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "asleep"});
		answerPhoto("a.jpg");
		assert.equal(photos().length, 1);
		assert.equal(timers.size, 0);
	});

	it("picks nothing while asleep and picks a due photo once awake", () => {
		const {mod, clock, picks, answerPhoto, timers} = createModule();
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		answerPhoto("a.jpg");
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "asleep"});
		assert.equal(timers.size, 0);
		clock.now += INTERVAL + 1;
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		assert.deepEqual([...timers.values()].map((t) => t.delay), [0]);
		assert.equal(picks().length, 1);
	});

	it("keeps the remaining time of the interval across sleep", () => {
		const {mod, clock, answerPhoto, timers} = createModule();
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		answerPhoto("a.jpg");
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "asleep"});
		clock.now += 100 * 1000;
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		assert.deepEqual([...timers.values()].map((t) => t.delay), [INTERVAL - 100 * 1000]);
	});

	it("picks a new photo right away on WALLBERRY_FETCH_PHOTO", () => {
		const {mod, picks, answerPhoto, timers} = createModule();
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		answerPhoto("a.jpg");
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO", {queries: ["sports"]});
		assert.equal(picks().length, 2);
		assert.equal(timers.size, 0);
	});

	it("records WALLBERRY_FETCH_PHOTO while asleep and picks once awake", () => {
		const {mod, picks, answerPhoto} = createModule();
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		answerPhoto("a.jpg");
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "asleep"});
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO");
		assert.equal(picks().length, 1);
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		assert.equal(picks().length, 2);
	});
});

describe("WB-folder answers of the node helper", () => {
	it("ignores answers to another browser's pick", () => {
		const {mod, images, photos} = createModule();
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		mod.socketNotificationReceived("WB_FOLDER_PHOTO", {requestId: "other-1", name: "a.jpg", url: "WB-folder/photos/a.jpg"});
		mod.socketNotificationReceived("WB_FOLDER_ERROR", {requestId: "other-1", error: "empty", folder: "/photos"});
		assert.equal(images.length, 0);
		assert.equal(photos().length, 0);
		assert.equal(mod.notifications.length, 0);
	});

	it("delivers only the photo of the latest pick", () => {
		const {mod, lastPick, images, photos} = createModule();
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		const first = lastPick().requestId;
		mod.socketNotificationReceived("WB_FOLDER_PHOTO", {requestId: first, name: "a.jpg", url: "WB-folder/photos/a.jpg"});
		mod.notificationReceived("WALLBERRY_FETCH_PHOTO");
		images[0].onload();
		assert.equal(photos().length, 0);
	});

	it("sends an error that names the folder and tries again after updateInterval", () => {
		const {mod, lastPick, errors, timers} = createModule();
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		mod.socketNotificationReceived("WB_FOLDER_ERROR", {requestId: lastPick().requestId, error: "missing", folder: "/home/pi/photos"});
		assert.deepEqual(plain(errors()), [{source: "WB-folder", message: "WB-folder cannot find the folder /home/pi/photos."}]);
		assert.deepEqual([...timers.values()].map((t) => t.delay), [INTERVAL]);
	});

	it("tries again after updateInterval when the image fails to load", () => {
		const {mod, lastPick, images, photos, timers, log} = createModule();
		mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
		mod.socketNotificationReceived("WB_FOLDER_PHOTO", {requestId: lastPick().requestId, name: "a.jpg", url: "WB-folder/photos/a.jpg"});
		images[0].onerror();
		assert.equal(photos().length, 0);
		assert.equal(log.error.length, 1);
		assert.deepEqual([...timers.values()].map((t) => t.delay), [INTERVAL]);
	});
});

describe("WB-folder translations", () => {
	const en = readTranslation("en");
	const de = readTranslation("de");

	it("has every key in English and German", () => {
		assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
	});

	for (const [error, folder] of [["missing", "/photos"], ["unreadable", "/photos"], ["empty", "/photos"], ["noFolder", ""]]) {
		it(`has a message for the error ${error} in both languages that names the folder`, () => {
			for (const translation of [en, de]) {
				const {mod, lastPick, errors} = createModule({}, translation);
				mod.notificationReceived("WALLBERRY_THEME_STATE", {state: "awake"});
				mod.socketNotificationReceived("WB_FOLDER_ERROR", {requestId: lastPick().requestId, error, folder});
				assert.ok(errors()[0].message.includes(folder));
				assert.ok(!errors()[0].message.includes("{"));
			}
		});
	}

	it("lists every translation file in getTranslations()", () => {
		const {mod} = createModule();
		const files = fs.readdirSync(path.join(REPO_ROOT, "WB-folder", "translations"));
		assert.deepEqual(Object.values(mod.getTranslations()).sort(), files.map((file) => `translations/${file}`).sort());
	});
});
