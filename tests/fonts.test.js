const {describe, it} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const REPO_ROOT = path.join(__dirname, "..");
const CSS_FILE = path.join(REPO_ROOT, "css", "WallberryTheme.css");
const FONTS_DIR = path.join(REPO_ROOT, "fonts");

/**
 * Returns the font files the stylesheet loads, as absolute paths.
 */
function referencedFontFiles() {
	const css = fs.readFileSync(CSS_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	return [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
		.map((match) => path.resolve(path.dirname(CSS_FILE), match[1]))
		.filter((file) => file.startsWith(FONTS_DIR + path.sep));
}

// Table tags a WOFF2 table directory refers to by index (WOFF2 spec, 5.1).
const WOFF2_KNOWN_TAGS = [
	"cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ",
	"fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp",
	"hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF",
	"GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL",
	"SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc",
	"feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx",
	"opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/**
 * Returns the untransformed table with the given tag from a WOFF2 file, or
 * undefined if the font has no such table.
 */
function woff2Table(file, wantedTag) {
	const data = fs.readFileSync(file);
	assert.equal(data.toString("latin1", 0, 4), "wOF2", `${file} is no WOFF2 file`);
	const numTables = data.readUInt16BE(12);
	const compressedLength = data.readUInt32BE(20);
	let pos = 48;
	const readBase128 = () => {
		let value = 0;
		for (let i = 0; i < 5; i++) {
			const byte = data[pos++];
			value = value * 128 + (byte & 0x7f);
			if ((byte & 0x80) === 0) return value;
		}
		throw new Error("invalid UIntBase128");
	};
	const tables = [];
	for (let i = 0; i < numTables; i++) {
		const flags = data[pos++];
		let tag = WOFF2_KNOWN_TAGS[flags & 0x3f];
		if ((flags & 0x3f) === 63) {
			tag = data.toString("latin1", pos, pos + 4);
			pos += 4;
		}
		const transformVersion = flags >> 6;
		let length = readBase128();
		const nullTransform = tag === "glyf" || tag === "loca" ? transformVersion === 3 : transformVersion === 0;
		if (!nullTransform) length = readBase128();
		tables.push({tag, length, transformed: !nullTransform});
	}
	const stream = zlib.brotliDecompressSync(data.subarray(pos, pos + compressedLength));
	let offset = 0;
	for (const table of tables) {
		if (table.tag === wantedTag) {
			assert.ok(!table.transformed, `${wantedTag} is stored transformed`);
			return stream.subarray(offset, offset + table.length);
		}
		offset += table.length;
	}
	return undefined;
}

/**
 * Returns the weight axis range of a variable WOFF2 font as [min, max], or
 * undefined for a static font.
 */
function weightAxis(file) {
	const fvar = woff2Table(file, "fvar");
	if (!fvar) return undefined;
	const axesOffset = fvar.readUInt16BE(4);
	const axisCount = fvar.readUInt16BE(8);
	const axisSize = fvar.readUInt16BE(10);
	for (let i = 0; i < axisCount; i++) {
		const axis = axesOffset + i * axisSize;
		if (fvar.toString("latin1", axis, axis + 4) === "wght") {
			return [fvar.readInt32BE(axis + 4) / 65536, fvar.readInt32BE(axis + 12) / 65536];
		}
	}
	return undefined;
}

/**
 * Returns each @font-face rule of the stylesheet as its font file and
 * declared weight range [min, max].
 */
function fontFaces() {
	const css = fs.readFileSync(CSS_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => {
		const url = body.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/)[1];
		const weights = body.match(/font-weight:\s*(\d+)(?:\s+(\d+))?/);
		const min = Number(weights[1]);
		return {
			file: path.resolve(path.dirname(CSS_FILE), url),
			weights: [min, Number(weights[2] ?? min)],
		};
	});
}

describe("bundled fonts", () => {
	it("loads at least one font file from fonts/", () => {
		assert.ok(referencedFontFiles().length > 0);
	});

	it("loads only font files that exist", () => {
		for (const file of referencedFontFiles()) {
			assert.ok(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} is missing`);
		}
	});

	it("ships no font file the stylesheet does not load", () => {
		const referenced = new Set(referencedFontFiles());
		const shipped = fs.readdirSync(FONTS_DIR)
			.filter((name) => name !== "OFL.txt" && !name.startsWith("."))
			.map((name) => path.join(FONTS_DIR, name));
		assert.deepEqual(shipped.filter((file) => !referenced.has(file)), []);
	});

	it("declares the weight range each variable font file covers", () => {
		for (const {file, weights} of fontFaces()) {
			const axis = weightAxis(file);
			if (axis) assert.deepEqual(weights, axis, path.relative(REPO_ROOT, file));
		}
	});

	it("covers MagicMirror's bold weight, so browsers draw no synthetic bold", () => {
		const covers = (weight) => fontFaces().some(({weights: [min, max]}) => min <= weight && weight <= max);
		assert.ok(covers(400), "regular (400) is missing");
		assert.ok(covers(700), "bold (700) is missing");
	});
});
