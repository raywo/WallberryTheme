# Module: WB-folder
Part of [WallberryTheme](../README.md), which describes the [installation](../README.md#installation) and [updating](../README.md#updating) of all its modules.

The `WB-folder` module shows your own photos from a folder on the mirror as WallberryTheme's background. It needs no API key and no internet connection. It picks a random photo from the folder, never the one on screen while there are others, and changes it every `updateInterval`.

WB-folder needs MagicMirror² 2.38.0 or later; an older MagicMirror² skips it and logs that its version is incorrect.

## Using the module

1.  Put your photos into a folder on the mirror, e.g. `/home/pi/photos`. WB-folder shows the `.jpg`, `.jpeg`, `.png` and `.webp` files directly in that folder; it ignores subfolders and hidden files.
2.  Add WB-folder to the modules array in the `config/config.js` file, next to WallberryTheme. It needs no `position`, as it shows nothing itself:
    ````javascript
    {
    	module: "WallberryTheme/WB-folder",
    	config: {
    		folder: "/home/pi/photos" // required
    	}
    },
    ````
3.  Restart MagicMirror.

To show only your own photos, leave out WallberryTheme's `unsplashAccessKey`. With the key, WallberryTheme shows the photos of both, the newest one on top, see [Photo sources](../README.md#photo-sources). Add WB-folder once: a second WB-folder entry shows the photos of the first entry's folder.

Photos you add to the folder or remove from it count from the next change of the photo on; MagicMirror needs no restart. A change of `folder` needs a restart of MagicMirror.

Each photo is scaled and cropped to the screen, centred, so that it fills the screen without distortion; the parts that do not fit the screen's aspect ratio are cut off. As the photos come from the mirror itself, WallberryTheme's `autoDimOn` checks each of them.

## Configuration options

| Option           | Default             | Type   | Description
| -----------------|---------------------|--------| -----------
| `folder`         | none, required      | String | The folder of the photos: an absolute path, e.g. `"/home/pi/photos"`, or a path relative to the MagicMirror² directory, e.g. `"photos"` for `~/MagicMirror/photos`. WB-folder reads it only from `config/config.js` on the mirror, so nobody who opens the mirror's page can make it show another folder. If the folder is missing, cannot be read or holds no photo, WallberryTheme shows a message that names the folder, as long as no other photo is on screen; WB-folder tries again after `updateInterval`.
| `updateInterval` | `300000` (5 minutes) | Number | How often the photo changes, in milliseconds. While WallberryTheme is hidden, e.g. by MMM-pages, the photo does not change; once WallberryTheme is shown again, a change that fell due while it was hidden comes right away.

WB-folder also changes the photo right away when another module sends the notification `WALLBERRY_FETCH_PHOTO`, see [Changing the photo from another module](../README.md#changing-the-photo-from-another-module); it ignores the notification's `queries` and `collections`, which choose Unsplash photos.

## Writing your own photo source

WB-folder is a complete example of a photo source: comments starting with "Every source" mark what each source has to do. See [Writing a photo source](../README.md#writing-a-photo-source).
