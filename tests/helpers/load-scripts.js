const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * Loads browser scripts of the modules into one shared context, the way
 * MagicMirror² loads them into the page. The scripts define globals
 * instead of exporting anything, so the context stubs the globals
 * MagicMirror² provides and gives access to what the scripts define.
 *
 * @param {string[]} files - script paths relative to the repository root, in load order
 * @param {Object} [globals] - additional or replacing globals, e.g. a `moment` stub
 * @returns {{get: function(string): *, modules: Object, log: Object}}
 *   `get(name)` returns a global the scripts defined, also a class;
 *   `modules` holds the definitions passed to `Module.register`, by name;
 *   `log` holds the messages passed to `Log`, by level.
 */
function loadScripts(files, globals = {}) {
	const log = {info: [], warn: [], error: [], log: []};
	const modules = {};
	const record = (level) => (...args) => log[level].push(args.join(" "));

	const context = vm.createContext({
		console,
		config: {language: "en", units: "metric", timeFormat: 24},
		Log: {info: record("info"), warn: record("warn"), error: record("error"), log: record("log")},
		Module: {
			register: (name, definition) => {
				modules[name] = definition;
			}
		},
		...globals
	});

	for (const file of files) {
		const code = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
		vm.runInContext(code, context, {filename: file});
	}

	return {
		// Top-level classes and `let`/`const` are not properties of the
		// context object, so look every name up by evaluating it.
		get: (name) => vm.runInContext(name, context),
		modules,
		log
	};
}

module.exports = {loadScripts};
