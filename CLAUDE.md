# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A MagicMirror² module (`WallberryTheme`) plus two companion modules
(`WB-clock`, `WB-weather`) living in subfolders. Users clone the repo into
`MagicMirror/modules/` and reference the companions as
`WallberryTheme/WB-clock` and `WallberryTheme/WB-weather`.

This repository is a fork of `delightedCrow/WallberryTheme`, which is no
longer maintained; this fork carries the development on.

## Build, lint, test

There is no `package.json`, no bundler and no linter config. Files are
loaded as-is by MagicMirror. The workflow in `.github/workflows/` runs lint
and tests on every pull request.

- Lint (syntax only): `git ls-files '*.js' | xargs -n1 node --check`
- Tests: `node --test "tests/**/*.test.js"` (Node's built-in runner, no
  dependencies). Single file: `node --test tests/<name>.test.js`.
- Module scripts are browser scripts that define globals; load them in a
  test with `loadScripts()` from `tests/helpers/load-scripts.js`, which
  stubs `Module`, `Log` and `config`. Do not turn them into ES modules or
  add `module.exports` for testing – MagicMirror loads them as plain
  scripts.
- New logic gets tests. Keep it testable without a DOM, e.g. pixel
  analysis as a function on an array rather than on a canvas.
- What is visible on the mirror is verified by running it inside a
  MagicMirror installation with the module configured in
  `config/config.js`; say in the report that it was not verified there if
  you could not.
- Do not add an external test runner (Vitest, Jest): it needs a
  `package.json`, a lockfile and dependency updates.

Runtime dependencies come from the MagicMirror host, not from this repo:
`Module`, `Log`, `config`, `nunjucks`, `moment.js`, `moment-timezone.js`,
`font-awesome.css`, `weather-icons.css` (browser side) and `node_helper`,
`electron` (node side). Do not add a dependency that the host
does not ship without also adding a way to install it.

## Architecture

Each module follows the MagicMirror split:

- `<Module>.js` – browser side, `Module.register(...)` with `defaults`,
  `getScripts`/`getStyles`/`getTemplate`/`getTemplateData`.
- `<Module>.njk` – Nunjucks template rendered by MagicMirror.
- `node_helper.js` – node side, talks to the browser via
  `sendSocketNotification` / `socketNotificationReceived`.

Both `WallberryTheme.js` and `WB-weather.js` override `nunjucksEnvironment()`
to register their own filters (`translate`, `dayLabel`, `precipIcons`).

### WallberryTheme (root)

- Fetches a random Unsplash photo via XHR in the browser, renders it as a
  `fullscreen_below` background.
- `node_helper.js` clears Electron's cache on start (`CLEAR_CACHE` →
  `ELECTRON_CACHE_CLEARED`); the module only fetches a photo after that
  reply, so the helper must always answer, also without Electron.
- The background and fade tints come from CSS: `setBackgroundTint()` sets
  Unsplash's colour swatch as `--wb-swatch`, and `css/WallberryTheme.css`
  derives the tints with OKLCH relative colour syntax, with neutral greys
  for browsers without it. Do not convert colours in JavaScript.
- `colorHelpers.js` (`WBColor`) decides via canvas sampling whether an
  image is bright (auto-dim). The image needs `crossOrigin = "Anonymous"`
  for that canvas read to work.
- Functions passed into the template (`setBackgroundTint`, `getFadeHeight`)
  are called from within the `.njk` and touch the DOM directly.

### WB-weather

Pluggable provider/template design:

- `WB-provider.js` – base class `WBProvider`, which fetches in the
  browser, plus the `WBProviderManager` registry. WB-weather has no
  `node_helper.js`.
- `providers/WB-<name>.js` – one subclass per provider; must end with
  `WBProviderManager.register("<name>", Class)`.
- `WB-weather.js` loads only the configured provider's script via
  `getScripts()`, selected by `providerName`.
- Providers fill `WBWeather`/`WBForecast` objects (`WB-dataObjects.js`) and
  finish with `resolveWithSuccess`, `resolveWithCriticalError` (stops
  polling) or `resolveWithTemporaryError` (retries after a delay).
  `updateAvailable()` in `WB-weather.js` decides rescheduling from that.
- Templates: `templates/<name>.njk` with optional `css/<name>.css`, chosen by
  the `template` option. Templates receive only `weather` and `error`, and
  read only the fields defined in `WB-dataObjects.js` – a provider must fill
  those, not add its own.
- A new user-facing string goes into every file in `translations/`, and each
  translation file must be listed in `getTranslations()`.

Provider and template names must be lower case; config values are
lower-cased in `start()` and used to build file paths.

## Conventions

- Tabs for indentation, double quotes, ES classes for providers, the
  `Module.register` object style for modules.
- Commit messages follow Chris Beams' seven rules, in English. Upstream's
  style ("Fixes #36, ...") does not apply; put issue references in the body
  ("Fixes #2").
- Pull requests target `main`. The README's "submit to `dev`" rule is
  upstream's and does not apply to this fork.
- Issue numbers in this fork collide with upstream's. Write `#12` only for
  this fork's issues and `delightedCrow/WallberryTheme#12` for upstream's.
  Older `CHANGELOG.md` entries link upstream issues.

## Plugin Bindings

| Step | Binding |
|------|---------|
| `implement-issue/user-docs` | `README.md`, `WB-clock/README.md`, `WB-weather/README.md` up to "WB-weather Development"; for MagicMirror users installing and configuring the modules; English. Every config option has a row in its module's options table (option, default, type, description); a new provider or template gets a section under "Available Weather Providers" / "Available Display Templates", a template also a screenshot. |
| `review-changes/user-docs` | Same as `implement-issue/user-docs` |
| `pr-review/user-docs` | Same as `implement-issue/user-docs` |
| `implement-issue/technical-docs` | Section "WB-weather Development" in `WB-weather/README.md`, when the provider base classes, the data objects or the template data change |
| `implement-issue/version` | One line in `CHANGELOG.md` under `[Unreleased]`, in the matching Keep a Changelog group (Added, Changed, Fixed, Removed) |
