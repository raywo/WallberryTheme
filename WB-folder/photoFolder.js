// The node side of WB-folder that needs no MagicMirror²: reading the
// configured folder, listing its photos and choosing one. node_helper.js
// wires it to MagicMirror²; the tests use it directly.
const fs = require("node:fs/promises");
const path = require("node:path");

const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

// Whether a file name is a photo WB-folder shows. Hidden files are left
// out: Express does not serve them, and macOS writes "._" files with a
// photo's extension next to the photos on some drives.
function isPhotoName(name) {
	return !name.startsWith(".") && PHOTO_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

// The config of the module in the server-side config: the first entry,
// not disabled, whose module is helperName or a path ending in it, e.g.
// "WallberryTheme/WB-folder". MagicMirror² names a helper after the last
// part of the module's path, and its getServerModuleConfig() compares the
// whole path with that name, so it finds nothing for a module in a
// subfolder.
function findModuleConfig(modules, helperName) {
	const entry = (Array.isArray(modules) ? modules : []).find((module) => {
		return module !== null && typeof module === "object" && module.disabled !== true &&
			typeof module.module === "string" &&
			(module.module === helperName || module.module.endsWith(`/${helperName}`));
	});
	return entry?.config ?? {};
}

// The absolute path of the configured folder, or null without one. A
// relative folder is relative to the MagicMirror² directory.
function resolveFolder(folder, rootPath) {
	if (typeof folder !== "string" || folder.trim() === "") {
		return null;
	}
	return path.resolve(rootPath, folder);
}

// Lists the photos directly in folder, sorted by name. Resolves to
// {names} or, if the folder cannot be read or holds no photo, to {error}:
// "missing", "unreadable" or "empty".
async function listPhotos(folder) {
	let entries = null;
	try {
		entries = await fs.readdir(folder, {withFileTypes: true});
	} catch (error) {
		return {error: error.code === "ENOENT" || error.code === "ENOTDIR" ? "missing" : "unreadable"};
	}
	const names = [];
	for (const entry of entries) {
		if (!isPhotoName(entry.name)) {
			continue;
		}
		if (entry.isFile() || (entry.isSymbolicLink() && await isLinkToFile(path.join(folder, entry.name)))) {
			names.push(entry.name);
		}
	}
	if (names.length === 0) {
		return {error: "empty"};
	}
	return {names: names.sort()};
}

async function isLinkToFile(file) {
	try {
		return (await fs.stat(file)).isFile();
	} catch {
		return false;
	}
}

// A random name from names, never current while there are others.
// random: a function like Math.random, for the tests.
function choosePhoto(names, current, random = Math.random) {
	const others = names.filter((name) => name !== current);
	const candidates = others.length > 0 ? others : names;
	return candidates[Math.floor(random() * candidates.length)];
}

// The absolute path of the photo name in folder, or null if name is not
// in the folder's current listing. Only names from the listing are
// served, so a request cannot reach another file, e.g. with "../".
async function photoPath(folder, name) {
	const listing = await listPhotos(folder);
	if (listing.names === undefined || !listing.names.includes(name)) {
		return null;
	}
	return path.join(folder, name);
}

module.exports = {isPhotoName, findModuleConfig, resolveFolder, listPhotos, choosePhoto, photoPath};
