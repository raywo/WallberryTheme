# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## 4.0.0 - 2026-10-28
The first release of this fork. It breaks WB-weather configs that leave out `providerName` or use Dark Sky: the entries marked **Breaking** say what to change, and [WB-weather's README](WB-weather/README.md#upgrading-from-an-earlier-version) explains each case.

### Added
- Added a `package.json`, which the [MagicMirror² module list](https://modules.magicmirror.builders/) expects and from whose keywords it shows the module's tags ([#6](https://github.com/raywo/WallberryTheme/issues/6)).
- Added a German translation of WallberryTheme's texts (the photo attribution, the loading message and the error messages), shown with `language: "de"` ([#4](https://github.com/raywo/WallberryTheme/issues/4)).
- Added WB-weather's Open-Meteo provider, which needs no API key: set `providerName: "openmeteo"` with `latitude` and `longitude`. The `classic-wallberry` template now keeps the forecast in one row next to the current weather, which fits up to 5 days on a 1080 px wide portrait screen ([#7](https://github.com/raywo/WallberryTheme/issues/7)).
- Added weather icons to WB-weather's Open-Meteo provider: the current weather shows a day or night icon, depending on whether the sun is up, and forecast days a day icon; a forecast day with a snow weather code now shows the snowflake also when Open-Meteo forecasts no snowfall ([#8](https://github.com/raywo/WallberryTheme/issues/8)).
- Added a weather description to WB-weather's Open-Meteo provider, e.g. “Partly cloudy”, and a German translation of WB-weather's texts: with `language: "de"` in your MagicMirror config, the description, “Heute” and the forecast's weekdays are German; WB-weather now names the weekdays in that language also without WB-clock ([#9](https://github.com/raywo/WallberryTheme/issues/9)).
- Added a README section on removing the theme's text shadow from text on coloured backgrounds in other modules, such as the line numbers of MMM-PublicTransportHub ([#5](https://github.com/raywo/WallberryTheme/issues/5)).

### Changed
- **Breaking:** WB-weather's `providerName` no longer defaults to `"openweathermap"` and is required; a config without it shows an error instead of the weather. Add `providerName: "openweathermap",` to keep OpenWeatherMap, or `providerName: "openmeteo",` to use Open-Meteo without an `apiKey` ([#7](https://github.com/raywo/WallberryTheme/issues/7)).
- The README starts with a table of the three modules linking to their documentation, WB-clock's and WB-weather's READMEs link back to installation and updating, and the config examples are single modules ending in a comma, which you paste into your `modules` array as they are ([#6](https://github.com/raywo/WallberryTheme/issues/6)).
- Development continues in the fork [raywo/WallberryTheme](https://github.com/raywo/WallberryTheme), since [delightedCrow/WallberryTheme](https://github.com/delightedCrow/WallberryTheme) is no longer updated. Install from there, and submit pull requests to `main`.
- The README now explains why this fork exists, lists how it differs from the original's 3.1.0, and shows how to switch an existing clone of the original to this fork and how to update; it no longer requires an OpenWeatherMap key, and the announcements of earlier releases are now part of the feature list ([#18](https://github.com/raywo/WallberryTheme/issues/18)).
- The tints of the background and of the top and bottom fades now look equally dark whatever the photo's colour; they are derived in CSS with OKLCH, and browsers without relative colour syntax show neutral dark fades ([#19](https://github.com/raywo/WallberryTheme/issues/19)).
- WB-clock now shows the date in the word order of your `language` unless you set `dateTimeFormat`, e.g. “Montag, 26. Oktober” instead of “Montag, Oktober 26.” for `"de"`; English shows “Monday, October 26” instead of “Monday, October 26th” ([#22](https://github.com/raywo/WallberryTheme/issues/22)).
- `autoDimOn` now dims a photo when white text would be hard to read behind the top or bottom bar, by the APCA contrast of the photo under the fades in those areas, instead of counting light pixels over the whole photo; it reads a downscaled copy, which is quicker on a Raspberry Pi ([#20](https://github.com/raywo/WallberryTheme/issues/20)).

### Removed
- **Breaking:** Removed WB-weather's Dark Sky provider, whose API Apple shut down in 2023, and the fallback that switched configs without `apiKey` to Dark Sky; a config with `providerName: "darksky"` or `darkSkyApiKey` now shows an error instead of the weather, so switch it to `providerName: "openmeteo"`, which needs no key, or to `providerName: "openweathermap"` with an OpenWeatherMap `apiKey` that has the “One Call by Call” subscription. WB-weather no longer has a `node_helper.js`, and the provider base class `WBProviderWithHelper` is gone ([#11](https://github.com/raywo/WallberryTheme/issues/11)).

### Fixed
- Fixed WB-weather's OpenWeatherMap provider failing with “Invalid API key” for every request: it now uses One Call 3.0 instead of the shut-down One Call 2.5, which needs the separate “One Call by Call” subscription on your key, free up to 1,000 calls per day but requiring a payment method; without it, WB-weather shows OpenWeatherMap's error message ([#10](https://github.com/raywo/WallberryTheme/issues/10)).
- Fixed WB-clock's README naming the option `OtherCities`, which WB-clock ignores, instead of `otherCities`; WB-weather's README now tells upgraders from Dark Sky or One Call 2.5 to switch to Open-Meteo ([#12](https://github.com/raywo/WallberryTheme/issues/12)).
- Fixed text with characters beyond basic Latin, such as “Łódź”, “Plzeň” or “Győr”, mixing Rubik with the fallback font; the bundled Rubik now covers Latin Extended-A, except Ţ and ţ, which Rubik lacks ([#23](https://github.com/raywo/WallberryTheme/issues/23)).
- Fixed WallberryTheme no longer changing the photo after Unsplash answers with a response that is not JSON, such as an exceeded rate limit, or does not answer at all; it now shows the error and tries again ([#21](https://github.com/raywo/WallberryTheme/issues/21)).
- Fixed WallberryTheme never loading a background photo when Electron is not installed ([#3](https://github.com/raywo/WallberryTheme/issues/3)).
- Fixed [issue 36](https://github.com/delightedCrow/WallberryTheme/issues/36) where the openweathermap provider for WB-weather wasn't properly using the language setting.

## 3.1.0 - 2021-3-4
### Fixed
- Fixed [issue 35](https://github.com/delightedCrow/WallberryTheme/issues/35) of image not loading due to Unsplash API change.
- Fixed [issue 33](https://github.com/delightedCrow/WallberryTheme/issues/33) showing incorrect documentation for WallberryTheme config.

### Added
- Added the following config options to WallberryTheme for customizing images: `imageWidth`, `imageHeight`, and `imageOptions`.

### Removed
- Removed the `resizeForScreen` config option.

## 3.0.1 - 2021-1-15
### Fixed
- WB-weather: Fixed issue with blank forecast weather icons showing up when using DarkSky provider.
- Fixes [issue 29](https://github.com/delightedCrow/WallberryTheme/issues/29) of Wallberry not loading background images on start up due to a failure to clear the Electron Cache. WalberryTheme's node_helper.js has been updated to use the [Electron's newer promise API for session.clearCache()](https://github.com/electron/electron/pull/17185).
- WB-weather: fixes [issue 31](https://github.com/delightedCrow/WallberryTheme/issues/31); floating elements now get cleared properly, so WB-weather elements now stay together as a unified block.

## 3.0.0 - 2020-11-18
### Changed
- WB-weather now uses openweathermap as its default weather provider (as DarkSky has been acquired by Apple).
- Changed WalberryTheme, WB-weather, and WB-clock to all use cached web templates in their nunjucks environments instead of requesting a new version from the server every time.

### Fixed
- Memory leak described in [Issue 25](https://github.com/delightedCrow/WallberryTheme/issues/25) (authored by [@samusaran](https://github.com/samusaran)).
- General linting and code clean up.

### Added
- Wb-weather has been completely refactored and can now switch between multiple weather providers and display templates.

## 2.2.1 - 2019-10-30
### Fixed
- Requesting the proper font awesome stylesheet now - no more 404s on FA now :)

## 2.2.0 - 2019-3-08
### Added
- Contributing section to the README.md
- New feature to get a random Unsplash photo related to one or more keywords specified in the `queries` option (authored by [@samusaran](https://github.com/samusaran))

## 2.1.0 - 2019-2-21
### Fixed
- Fixed [Issue 10](https://github.com/delightedCrow/WallberryTheme/issues/10), where background fades did not reach to the edges of the screen for other 3rd party MM2 modules.
- Provided a more permanent fix for [Issue 8](https://github.com/delightedCrow/WallberryTheme/issues/8) by adding an option to clear Electron's cache on start up.
- WallberryTheme, WB-clock, and WB-weather all properly suspend their activity when hidden now, and resume properly when woken back up again.

## 2.0.0 - 2019-2-10
### Added
- the option `backgroundOpacity` in WallberryTheme to set the brightness of the background.
- the `autoDimOn` option in WallberryTheme, which automatically detects light images and darkens them to the value set in the `brightImageOpacity` option. This can help with readability, increasing contrast between the background image and the text an top of it.
- the `addBackgroundFade` option, which allows the user to turn on fading background gradients for the top and bottom regions of the magic mirror, increasing readability.
- both `autoDimOn` and `addBackgroundFade` use the color information sent by Unsplash to tint their backgrounds to the same general hue as the background image, causing them to blend better with most images.

### Changed
- WB-weather and WB-clock no longer have their own background gradients set in CSS (since the main WallberryTheme module handles this now).

## 1.1.0 - 2019-1-21
### Changed
- Updated all module READMEs to make the types of module options more explicit.

### Added
- This Changelog file :)
- WallberryTheme now displays error messages if something goes wrong when fetching the Unsplash background.

## 1.0.0 - 2018-11-7
### Added
- EVERYTHING (this was the initial WallberryTheme release)
