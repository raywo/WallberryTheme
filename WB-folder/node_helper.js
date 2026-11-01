const path = require("node:path");
const NodeHelper = require("node_helper");
const {findModuleConfig, resolveFolder, listPhotos, choosePhoto, photoPath} = require("./photoFolder");

// WB-folder's node side: it lists the folder, picks a photo and serves it.
// Every photo source that keeps photos on the mirror needs the same:
// - Read paths only from the server-side config, never from a socket
//   message: anyone who can open the mirror page can send one.
// - Serve the photos through MagicMirror²'s server, so that they come from
//   the mirror's own origin and WallberryTheme's auto-dim may read their
//   pixels.
// - Answer every request with the id it came with: MagicMirror² sends a
//   socket notification to every browser that shows the mirror.
module.exports = NodeHelper.create({
	// requiresVersion of WB-folder.js as well: getServerModuleConfig()
	// came with this version
	requiresVersion: "2.38.0",

	start: function() {
		this.folder = this.readFolder();
		// Express decodes the name; photoPath() refuses any name that is
		// not in the folder's current listing.
		this.expressApp.get(`/${this.name}/photos/:name`, (request, response) => {
			this.servePhoto(request.params.name, response);
		});
	},

	// The configured folder as an absolute path, or null without one
	readFolder: function() {
		let config = this.getServerModuleConfig();
		if (config.folder === undefined) {
			config = findModuleConfig(global.config?.modules, this.name);
		}
		return resolveFolder(config.folder, global.root_path);
	},

	servePhoto: async function(name, response) {
		const folder = this.folder;
		const file = folder === null ? null : await photoPath(folder, name);
		if (file === null) {
			response.sendStatus(404);
			return;
		}
		// Revalidate, so that a photo replaced under the same name shows
		// its new image.
		response.set("Cache-Control", "no-cache");
		// The folder as root: Express refuses a path with a hidden part,
		// which a folder such as ~/.photos would otherwise be.
		response.sendFile(path.basename(file), {root: folder}, (error) => {
			if (error && !response.headersSent) {
				response.sendStatus(404);
			}
		});
	},

	socketNotificationReceived: function(notification, payload) {
		if (notification === "WB_FOLDER_PICK_PHOTO") {
			this.pickPhoto(payload);
		}
	},

	// payload: {requestId, current}, current the name of the photo on
	// screen. Answers with WB_FOLDER_PHOTO {requestId, name, url} or
	// WB_FOLDER_ERROR {requestId, error, folder}. The folder is read anew
	// for every pick, so that added photos appear without a restart.
	pickPhoto: async function(payload) {
		const requestId = payload?.requestId;
		if (this.folder === null) {
			this.sendSocketNotification("WB_FOLDER_ERROR", {requestId, error: "noFolder", folder: ""});
			return;
		}
		const listing = await listPhotos(this.folder);
		if (listing.error !== undefined) {
			this.sendSocketNotification("WB_FOLDER_ERROR", {requestId, error: listing.error, folder: this.folder});
			return;
		}
		const name = choosePhoto(listing.names, payload?.current);
		this.sendSocketNotification("WB_FOLDER_PHOTO", {
			requestId,
			name,
			// Relative, like the module's own files, so that it also works
			// behind a proxy that serves the mirror under a path
			url: `${this.name}/photos/${encodeURIComponent(name)}`
		});
	}
});
