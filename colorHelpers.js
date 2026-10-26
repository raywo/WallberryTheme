/* WBColor decides whether a photo is too bright for the white text of
 * the modules in the top and bottom bar. It reads a downscaled copy of
 * the photo, so the check stays cheap on a Raspberry Pi.
 */
var WBColor = {
	SAMPLE_SIZE: 64, // px on the long side of the downscaled copy
	BRIGHT_PERCENTILE: 0.9, // a bright patch counts once it covers a tenth of a bar
	MIN_TEXT_CONTRAST: 75, // APCA Lc, the minimum for body text
	TEXT_COLOR: [255, 255, 255],

	// The fades of css/WallberryTheme.css as they lie over the photo, by
	// position t from 0 (top edge of the fade) to 1 (bottom edge). They use
	// the neutral greys of the CSS; the tints derived from the swatch have
	// the same lightness, and a hue barely changes the contrast. A gradient
	// interpolates premultiplied, so a fade towards a transparent colour
	// keeps the colour of its opaque end. Keep in step with the CSS.
	FADES: {
		top: {color: [15, 15, 15], alpha: (t) => 0.7 * (1 - t)},
		bottom: {color: [0, 0, 0], alpha: (t) => t}
	},

	// img: the loaded photo; bars: see barsNeedDimming()
	needsDimming: function(img, bars) {
		const imageWidth = img.naturalWidth || img.width;
		const imageHeight = img.naturalHeight || img.height;
		const scale = Math.min(1, this.SAMPLE_SIZE / Math.max(imageWidth, imageHeight));
		const width = Math.max(1, Math.round(imageWidth * scale));
		const height = Math.max(1, Math.round(imageHeight * scale));

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		ctx.drawImage(img, 0, 0, width, height);

		const data = ctx.getImageData(0, 0, width, height).data;
		return this.barsNeedDimming(data, width, height, bars);
	},

	// data: RGBA pixels of an image, row by row, as ImageData holds them
	// bars: the areas behind the bars, each {start, end, fade}: start and
	//   end are rows as fractions of the image height, fade is the key of
	//   the fade over the area in FADES, or null without one
	// The check measures the photo as it looks under the fade, because that
	// is what the viewer sees behind the text.
	barsNeedDimming: function(data, width, height, bars) {
		return bars.some((bar) => {
			const background = this.brightColor(data, width, height, bar);
			return background !== null &&
				Math.abs(this.contrastAPCA(this.TEXT_COLOR, background)) < this.MIN_TEXT_CONTRAST;
		});
	},

	// The colour at BRIGHT_PERCENTILE of an area's luminance, under its
	// fade, or null for an area without rows. A percentile rather than the
	// mean, so that a bright patch behind the text counts.
	brightColor: function(data, width, height, bar) {
		// the fade spans the whole area, also where it reaches past the image
		const areaTop = bar.start * height;
		const areaBottom = bar.end * height;
		const top = Math.max(0, areaTop);
		const bottom = Math.min(height, areaBottom);
		const fade = bar.fade ? this.FADES[bar.fade] : null;
		const colors = [];

		for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
			const t = Math.min(1, Math.max(0, (y + 0.5 - areaTop) / (areaBottom - areaTop)));
			const alpha = fade ? fade.alpha(t) : 0;
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4;
				const color = [0, 1, 2].map((c) => {
					return data[i + c] * (1 - alpha) + (fade ? fade.color[c] * alpha : 0);
				});
				colors.push({color: color, luminance: this.luminance(...color)});
			}
		}

		if (colors.length === 0) {
			return null;
		}
		colors.sort((a, b) => a.luminance - b.luminance);
		return colors[Math.min(colors.length - 1, Math.floor(this.BRIGHT_PERCENTILE * colors.length))].color;
	},

	/*
	 * contrastAPCA and luminance are adapted from chroma.js
	 * (src/utils/contrastAPCA.js), changed to take colours as [r, g, b]
	 * arrays without alpha:
	 *
	 * chroma.js - JavaScript library for color conversions
	 *
	 * Copyright (c) 2011-2025, Gregor Aisch
	 * All rights reserved.
	 *
	 * Redistribution and use in source and binary forms, with or without
	 * modification, are permitted provided that the following conditions are met:
	 *
	 * 1. Redistributions of source code must retain the above copyright notice, this
	 *    list of conditions and the following disclaimer.
	 *
	 * 2. Redistributions in binary form must reproduce the above copyright notice,
	 *    this list of conditions and the following disclaimer in the documentation
	 *    and/or other materials provided with the distribution.
	 *
	 * 3. The name Gregor Aisch may not be used to endorse or promote products
	 *    derived from this software without specific prior written permission.
	 *
	 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
	 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
	 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
	 * DISCLAIMED. IN NO EVENT SHALL GREGOR AISCH OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
	 * INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
	 * BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
	 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
	 * OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
	 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
	 * EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
	 *
	 * The APCA contrast prediction algorithm is based of the formulas published
	 * in the APCA-1.0.98G specification by Myndex. The specification is available at:
	 * https://raw.githubusercontent.com/Myndex/apca-w3/master/images/APCAw3_0.1.17_APCA0.0.98G.svg
	 *
	 * You can read more about the APCA Readability Criterion at
	 * https://readtech.org/ARC/
	 */

	// APCA lightness contrast Lc of text on bg, both [r, g, b] from 0 to
	// 255: positive for dark text on a light background, negative for
	// light text on a dark one
	contrastAPCA: function(text, bg) {
		const W_offset = 0.027;
		const P_in = 0.0005;
		const P_out = 0.1;
		const R_scale = 1.14;
		const B_threshold = 0.022;
		const B_exp = 1.414;

		const l_text = this.luminance(...text);
		const l_bg = this.luminance(...bg);

		// soft clamp black levels
		const Y_text =
			l_text >= B_threshold
				? l_text
				: l_text + Math.pow(B_threshold - l_text, B_exp);
		const Y_bg =
			l_bg >= B_threshold ? l_bg : l_bg + Math.pow(B_threshold - l_bg, B_exp);

		// normal polarity (dark text on light background)
		const S_norm = Math.pow(Y_bg, 0.56) - Math.pow(Y_text, 0.57);
		// reverse polarity (light text on dark background)
		const S_rev = Math.pow(Y_bg, 0.65) - Math.pow(Y_text, 0.62);
		// clamp noise then scale
		const C =
			Math.abs(Y_bg - Y_text) < P_in
				? 0
				: Y_text < Y_bg
					? S_norm * R_scale
					: S_rev * R_scale;
		// clamp minimum contrast then offset
		const S_apc = Math.abs(C) < P_out ? 0 : C > 0 ? C - W_offset : C + W_offset;
		// scale to 100
		return S_apc * 100;
	},

	luminance: function(r, g, b) {
		return (
			0.2126729 * Math.pow(r / 255, 2.4) +
			0.7151522 * Math.pow(g / 255, 2.4) +
			0.072175 * Math.pow(b / 255, 2.4)
		);
	}
};
