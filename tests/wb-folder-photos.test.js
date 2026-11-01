const {describe, it, before, after} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {isPhotoName, findModuleConfig, resolveFolder, listPhotos, choosePhoto, photoPath} = require("../WB-folder/photoFolder");

describe("WB-folder isPhotoName", () => {
	it("accepts .jpg, .jpeg, .png and .webp in any case", () => {
		for (const name of ["a.jpg", "b.JPEG", "c.png", "d.WebP"]) {
			assert.ok(isPhotoName(name), name);
		}
	});

	it("refuses other types and hidden files", () => {
		for (const name of ["a.gif", "b.heic", "notes.txt", "jpg", "._a.jpg", ".hidden.png"]) {
			assert.ok(!isPhotoName(name), name);
		}
	});
});

describe("WB-folder choosePhoto", () => {
	it("never chooses the photo on screen while there are others", () => {
		for (const random of [0, 0.4, 0.99]) {
			assert.notEqual(choosePhoto(["a.jpg", "b.jpg", "c.jpg"], "b.jpg", () => random), "b.jpg");
		}
	});

	it("chooses among all other photos", () => {
		const names = ["a.jpg", "b.jpg", "c.jpg"];
		const chosen = new Set([0, 0.5, 0.99].map((random) => choosePhoto(names, "b.jpg", () => random)));
		assert.deepEqual([...chosen].sort(), ["a.jpg", "c.jpg"]);
	});

	it("chooses the only photo also when it is on screen", () => {
		assert.equal(choosePhoto(["a.jpg"], "a.jpg", () => 0.5), "a.jpg");
	});

	it("chooses any photo without one on screen", () => {
		assert.equal(choosePhoto(["a.jpg", "b.jpg"], null, () => 0), "a.jpg");
	});
});

describe("WB-folder findModuleConfig", () => {
	it("finds the module by its path in the repository", () => {
		const modules = [
			{module: "WallberryTheme", config: {}},
			{module: "WallberryTheme/WB-folder", config: {folder: "/photos"}}
		];
		assert.deepEqual(findModuleConfig(modules, "WB-folder"), {folder: "/photos"});
	});

	it("finds a module installed by its name alone", () => {
		assert.deepEqual(findModuleConfig([{module: "WB-folder", config: {folder: "x"}}], "WB-folder"), {folder: "x"});
	});

	it("skips disabled entries and modules whose name only ends alike", () => {
		const modules = [
			{module: "WallberryTheme/WB-folder", disabled: true, config: {folder: "/off"}},
			{module: "MMM-WB-folder", config: {folder: "/other"}},
			{module: "WallberryTheme/WB-folder", config: {folder: "/on"}}
		];
		assert.deepEqual(findModuleConfig(modules, "WB-folder"), {folder: "/on"});
	});

	it("returns an empty config without an entry or modules", () => {
		assert.deepEqual(findModuleConfig([], "WB-folder"), {});
		assert.deepEqual(findModuleConfig(undefined, "WB-folder"), {});
		assert.deepEqual(findModuleConfig([{module: "WB-folder"}], "WB-folder"), {});
	});
});

describe("WB-folder resolveFolder", () => {
	it("keeps an absolute folder", () => {
		assert.equal(resolveFolder("/home/pi/photos", "/opt/MagicMirror"), "/home/pi/photos");
	});

	it("resolves a relative folder against the MagicMirror² directory", () => {
		assert.equal(resolveFolder("photos", "/opt/MagicMirror"), "/opt/MagicMirror/photos");
	});

	it("returns null without a folder", () => {
		for (const folder of [undefined, "", "  ", 42]) {
			assert.equal(resolveFolder(folder, "/opt/MagicMirror"), null);
		}
	});
});

describe("WB-folder listPhotos and photoPath", () => {
	let root = null;
	let folder = null;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-folder-"));
		folder = path.join(root, "photos");
		fs.mkdirSync(path.join(folder, "sub.jpg"), {recursive: true});
		fs.mkdirSync(path.join(folder, "nested"));
		for (const name of ["b.png", "a.JPG", "c.webp", "notes.txt", "._a.JPG", "nested/d.jpg"]) {
			fs.writeFileSync(path.join(folder, name), "x");
		}
		fs.writeFileSync(path.join(root, "secret.jpg"), "x");
		fs.symlinkSync(path.join(root, "secret.jpg"), path.join(folder, "link.jpg"));
		fs.mkdirSync(path.join(root, "empty"));
	});

	after(() => {
		fs.rmSync(root, {recursive: true, force: true});
	});

	it("lists the photo files directly in the folder, with links to files", async () => {
		assert.deepEqual(await listPhotos(folder), {names: ["a.JPG", "b.png", "c.webp", "link.jpg"]});
	});

	it("reads the folder anew, so that added photos appear", async () => {
		fs.writeFileSync(path.join(folder, "e.jpeg"), "x");
		try {
			assert.ok((await listPhotos(folder)).names.includes("e.jpeg"));
		} finally {
			fs.rmSync(path.join(folder, "e.jpeg"));
		}
	});

	it("reports a missing folder, a file instead of a folder and an empty folder", async () => {
		assert.deepEqual(await listPhotos(path.join(root, "missing")), {error: "missing"});
		assert.deepEqual(await listPhotos(path.join(folder, "b.png")), {error: "missing"});
		assert.deepEqual(await listPhotos(path.join(root, "empty")), {error: "empty"});
	});

	it("serves a photo of the listing by its name", async () => {
		assert.equal(await photoPath(folder, "b.png"), path.join(folder, "b.png"));
	});

	it("refuses any name that is not in the listing", async () => {
		for (const name of ["notes.txt", "._a.JPG", "nested/d.jpg", "../secret.jpg", "sub.jpg", "missing.jpg", "", path.join(folder, "b.png")]) {
			assert.equal(await photoPath(folder, name), null, name);
		}
	});

	it("refuses every name when the folder cannot be read", async () => {
		assert.equal(await photoPath(path.join(root, "missing"), "b.png"), null);
	});
});
