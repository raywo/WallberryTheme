const NodeHelper = require("node_helper");

// MagicMirror² lists electron as an optional dependency, so it may be
// missing (server-only and container installations). Do not require it
// unguarded: a throwing require makes MagicMirror² skip this helper, and the
// module then waits forever for ELECTRON_CACHE_CLEARED.
let BrowserWindow = null;
try {
	({BrowserWindow} = require("electron"));
} catch (e) {
	console.log("WallberryTheme: Electron is not available, its cache will not be cleared.");
}

module.exports = NodeHelper.create({

	socketNotificationReceived: function(notification, payload) {
		switch(notification) {
		case "CLEAR_CACHE":
			if (!BrowserWindow) {
				this.sendSocketNotification("ELECTRON_CACHE_CLEARED", {});
				break;
			}

			try {
				const win = BrowserWindow.getAllWindows()[0];
				const ses = win.webContents.session;

				ses.clearCache().then(() => {
					console.log("Electron's cache successfully cleared.");
					this.sendSocketNotification("ELECTRON_CACHE_CLEARED", {});
				});

			} catch (e) {
				// We'll get a TypeError if MM is being run in server only mode because Electron won't be running the app - if that's the case we can just say the cache has been cleared and call it a day
				if (e.name == "TypeError") {
					this.sendSocketNotification("ELECTRON_CACHE_CLEARED", {});
				} else {
					console.log("WallberryTheme ERROR: ", e);
				}
			}

			break;
		}
	}
});
