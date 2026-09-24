/**
 * A QR encoder, byte mode, ISO/IEC 18004.
 *
 * Written out rather than installed, for one reason: the only thing this
 * encodes is a destination link, and a destination link is a bearer credential.
 * A runtime dependency in that position is a package that can read a live
 * broadcast key on every release it ships, and the portal bundle is served to
 * the browser where the credential is minted. The alternative is about four
 * hundred lines of pure, deterministic, well-specified transformation with no
 * I/O, no configuration and no reason to ever change - which is the shape of
 * code that is cheaper to own than to audit.
 *
 * The correctness argument is not "it looks right on my screen". `test/qr.test.js`
 * compares whole matrices against fixtures generated from an independent
 * implementation, so a mask chosen one step early or an interleave off by a
 * block fails a test rather than producing a code that only some phones read.
 *
 * Byte mode only. Numeric and alphanumeric modes exist and would pack a link
 * slightly tighter, but a URL with a base64url key in it is not alphanumeric
 * under the standard's definition (which excludes lowercase), so the modes
 * would never be selected and the segmentation logic to choose between them
 * would be dead code.
 */

/* ------------------------------------------------------------------ tables -- */

/**
 * Error-correction codewords per block, indexed [level][version].
 *
 * Index 0 of each row is a hole: versions are 1-40 and the arithmetic reads
 * better when the version number is the index. Together with
 * {@link EC_BLOCKS} and the raw module count this replaces the more commonly
 * transcribed table of (blocks, data codewords, ec codewords) triples - the
 * third column of that table is derivable, and a derived value cannot be
 * mistranscribed.
 */
const EC_CODEWORDS = {
    L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
};

/** Error-correction blocks, indexed [level][version]. */
const EC_BLOCKS = {
    L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
};

/** The two bits the format information carries for each level. Not 0-3 in order. */
const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * Penalty weights from the standard.
 *
 * These decide which of the eight masks is used. They are not tuning knobs:
 * they encode what a camera finds hard - long same-colour runs, solid blocks,
 * anything resembling a finder pattern in the data, and an image too far from
 * half dark.
 */
const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

/** The eight data masks, by pattern number. `x` is the column, `y` the row. */
const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

/* ----------------------------------------------------------------- GF(256) -- */

/**
 * Multiply in GF(256) with the QR field polynomial, x^8 + x^4 + x^3 + x^2 + 1.
 *
 * Russian-peasant rather than a pair of log/antilog tables. It is a few times
 * slower and there is nothing here that cares: the whole encode is a few
 * thousand multiplications, once, when a button is pressed. What it buys is
 * that there are no tables to get wrong and no zero special case to forget.
 */
function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

/** The monic generator polynomial of the given degree, high term implied. */
function rsDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;

    // Multiply by (x - r^i) for each i, where r is the generator element 0x02.
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = gfMul(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = gfMul(root, 0x02);
    }
    return result;
}

/** The Reed-Solomon remainder: the error-correction codewords for one block. */
function rsRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);

    for (const b of data) {
        const factor = b ^ result[0];
        result.copyWithin(0, 1);
        result[result.length - 1] = 0;
        for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
    }
    return result;
}

/* ------------------------------------------------------------- capacities -- */

/**
 * Modules a version has available for data, before error correction.
 *
 * Closed form rather than a table, because the geometry is the table: the
 * square, less the three finders and their separators and format areas, less
 * the alignment patterns, less the timing they overlap, less the version
 * blocks from version 7.
 */
function rawDataModules(version) {
    let result = (16 * version + 128) * version + 64;

    if (version >= 2) {
        const numAlign = Math.floor(version / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (version >= 7) result -= 36;
    }
    return result;
}

/** Data codewords a version holds at a level, once error correction is subtracted. */
function dataCodewords(version, ec) {
    return Math.floor(rawDataModules(version) / 8) - EC_CODEWORDS[ec][version] * EC_BLOCKS[ec][version];
}

/**
 * The character-count indicator is eight bits up to version 9 and sixteen from
 * version 10, which is why version selection cannot be a single division: the
 * header grows partway up the range.
 */
function countBits(version) {
    return version < 10 ? 8 : 16;
}

/* --------------------------------------------------------------- encoding -- */

/** The smallest version that holds `byteLength` bytes at this level. */
function chooseVersion(byteLength, ec) {
    for (let version = 1; version <= 40; version++) {
        if (dataCodewords(version, ec) * 8 >= 4 + countBits(version) + byteLength * 8) return version;
    }
    throw new Error(`${byteLength} bytes does not fit in a QR code at error-correction level ${ec}`);
}

/** Mode indicator, length, payload, terminator and padding, as whole codewords. */
function encodeData(bytes, version, ec) {
    const bits = [];
    const push = (value, width) => {
        for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };

    push(0b0100, 4);
    push(bytes.length, countBits(version));
    for (const b of bytes) push(b, 8);

    const capacity = dataCodewords(version, ec) * 8;

    // Terminator, then to a byte boundary. Both are "as many zeros as there is
    // room for", which is why a full code needs no terminator at all.
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);

    // The standard's pad bytes. Alternating rather than a constant so that a
    // mostly-empty code still has enough transitions to mask well.
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

    const codewords = new Uint8Array(bits.length / 8);
    bits.forEach((bit, i) => {
        codewords[i >>> 3] |= bit << (7 - (i & 7));
    });
    return codewords;
}

/**
 * Split into blocks, add error correction, and interleave.
 *
 * The interleave is the part worth explaining. Codewords are not laid down
 * block by block; they are taken one from each block in turn, so that a thumb
 * over one corner of the printed code damages a little of every block rather
 * than destroying one outright. Blocks come in two lengths in most versions,
 * and the short ones are padded with a phantom byte during the round-robin that
 * is skipped rather than emitted - that skip is the single easiest thing to get
 * wrong here, and the fixture tests exist largely to catch it.
 */
function interleave(data, version, ec) {
    const numBlocks = EC_BLOCKS[ec][version];
    const eccLen = EC_CODEWORDS[ec][version];
    const rawCodewords = Math.floor(rawDataModules(version) / 8);
    const numShort = numBlocks - (rawCodewords % numBlocks);
    const shortLen = Math.floor(rawCodewords / numBlocks);

    const divisor = rsDivisor(eccLen);
    const blocks = [];

    for (let i = 0, offset = 0; i < numBlocks; i++) {
        const len = shortLen - eccLen + (i < numShort ? 0 : 1);
        const dat = Array.from(data.slice(offset, offset + len));
        offset += len;
        blocks.push({ data: dat, ecc: Array.from(rsRemainder(dat, divisor)) });
    }

    const result = [];
    for (let i = 0; i < shortLen - eccLen + 1; i++) {
        blocks.forEach((block) => {
            // Short blocks simply have nothing to contribute on the last
            // pass; `numShort` is what decides which those are.
            if (i < block.data.length) result.push(block.data[i]);
        });
    }
    for (let i = 0; i < eccLen; i++) for (const block of blocks) result.push(block.ecc[i]);

    return result;
}

/* ----------------------------------------------------------------- matrix -- */

/** Where the alignment patterns sit, as coordinates on both axes. */
function alignmentPositions(version) {
    if (version === 1) return [];

    const numAlign = Math.floor(version / 7) + 2;
    const size = version * 4 + 17;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;

    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
}

class Matrix {
    constructor(version) {
        this.version = version;
        this.size = version * 4 + 17;
        this.modules = Array.from({ length: this.size }, () => new Uint8Array(this.size));
        // Function modules are the ones the mask must not touch and the data
        // must not land on. Tracked alongside rather than inferred from
        // position, because the alignment patterns make "is this a function
        // module" a geometry problem it is not worth re-solving per module.
        this.fixed = Array.from({ length: this.size }, () => new Uint8Array(this.size));
    }

    setFunction(x, y, dark) {
        this.modules[y][x] = dark ? 1 : 0;
        this.fixed[y][x] = 1;
    }

    drawFinder(x, y) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const xx = x + dx;
                const yy = y + dy;
                if (xx < 0 || xx >= this.size || yy < 0 || yy >= this.size) continue;

                // Concentric squares by Chebyshev distance, which draws the
                // 7x7 finder and its white separator in one expression.
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                this.setFunction(xx, yy, dist !== 2 && dist !== 4);
            }
        }
    }

    drawAlignment(x, y) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }

    /** Format information: level and mask, BCH(15, 5), masked, written twice. */
    drawFormat(ec, mask) {
        const data = (EC_FORMAT_BITS[ec] << 3) | mask;

        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);

        // The final XOR keeps an all-zero format from looking like blank media.
        const bits = ((data << 10) | rem) ^ 0x5412;
        const bit = (i) => ((bits >>> i) & 1) === 1;

        for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
        this.setFunction(8, 7, bit(6));
        this.setFunction(8, 8, bit(7));
        this.setFunction(7, 8, bit(8));
        for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));

        for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));

        // The dark module. Always set, carries nothing, and is the reason a
        // blank QR code is not a valid one.
        this.setFunction(8, this.size - 8, true);
    }

    /** Version information, BCH(18, 6), from version 7 up. */
    drawVersion() {
        if (this.version < 7) return;

        let rem = this.version;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const bits = (this.version << 12) | rem;

        for (let i = 0; i < 18; i++) {
            const dark = ((bits >>> i) & 1) === 1;
            const a = this.size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            this.setFunction(a, b, dark);
            this.setFunction(b, a, dark);
        }
    }

    drawFunctionPatterns(ec) {
        for (let i = 0; i < this.size; i++) {
            this.setFunction(6, i, i % 2 === 0);
            this.setFunction(i, 6, i % 2 === 0);
        }

        this.drawFinder(3, 3);
        this.drawFinder(this.size - 4, 3);
        this.drawFinder(3, this.size - 4);

        const pos = alignmentPositions(this.version);
        for (let i = 0; i < pos.length; i++) {
            for (let j = 0; j < pos.length; j++) {
                // The three corners already hold finder patterns.
                const corner =
                    (i === 0 && j === 0) ||
                    (i === 0 && j === pos.length - 1) ||
                    (i === pos.length - 1 && j === 0);
                if (!corner) this.drawAlignment(pos[i], pos[j]);
            }
        }

        // A placeholder mask, overwritten once the real one has been chosen.
        this.drawFormat(ec, 0);
        this.drawVersion();
    }

    /**
     * Lay the codewords down in the standard's boustrophedon: two-module
     * columns from the right edge leftwards, alternating up and down, skipping
     * function modules and stepping over the vertical timing pattern.
     */
    drawCodewords(data) {
        let i = 0;

        for (let right = this.size - 1; right >= 1; right -= 2) {
            // Column 6 is the vertical timing pattern. Skipping it keeps the
            // two-wide columns aligned on the other side of it.
            if (right === 6) right = 5;

            for (let vert = 0; vert < this.size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? this.size - 1 - vert : vert;

                    if (!this.fixed[y][x] && i < data.length * 8) {
                        this.modules[y][x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
                        i++;
                    }
                }
            }
        }
    }

    applyMask(mask) {
        const fn = MASKS[mask];
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                if (!this.fixed[y][x] && fn(x, y)) this.modules[y][x] ^= 1;
            }
        }
    }

    /**
     * How hard this masked image is to read, by the standard's four rules.
     *
     * Lower is better and the absolute number means nothing; it exists only to
     * be compared across the eight masks.
     */
    penalty() {
        let result = 0;
        const { size, modules } = this;

        for (const transposed of [false, true]) {
            for (let a = 0; a < size; a++) {
                let runColour = 0;
                let runLength = 0;
                const history = [0, 0, 0, 0, 0, 0, 0];

                for (let b = 0; b < size; b++) {
                    const cell = transposed ? modules[b][a] : modules[a][b];

                    if (cell === runColour) {
                        runLength++;
                        if (runLength === 5) result += PENALTY_RUN;
                        else if (runLength > 5) result++;
                    } else {
                        addRun(runLength, history, size);
                        if (!runColour) result += finderLikeCount(history) * PENALTY_FINDER;
                        runColour = cell;
                        runLength = 1;
                    }
                }
                result += terminateRun(runColour, runLength, history, size) * PENALTY_FINDER;
            }
        }

        for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
                const c = modules[y][x];
                if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
                    result += PENALTY_BLOCK;
                }
            }
        }

        let dark = 0;
        for (const row of modules) for (const c of row) dark += c;

        // Every five percent away from half dark costs, because a code that is
        // mostly one colour gives a camera's thresholding nothing to work with.
        const total = size * size;
        result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY_BALANCE;

        return result;
    }
}

/**
 * The 1:1:3:1:1 finder proportion appearing inside the data, which is the one
 * false positive that can make a scanner give up entirely rather than degrade.
 */
function finderLikeCount(history) {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;

    return (
        (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
        (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
    );
}

function addRun(runLength, history, size) {
    // The very first run is preceded by the quiet zone, which counts as light.
    if (history[0] === 0) runLength += size;
    history.pop();
    history.unshift(runLength);
}

function terminateRun(runColour, runLength, history, size) {
    if (runColour) {
        addRun(runLength, history, size);
        runLength = 0;
    }
    addRun(runLength + size, history, size);
    return finderLikeCount(history);
}

/* ------------------------------------------------------------------ public -- */

/**
 * Encode text as a QR matrix.
 *
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} [ec] error-correction level
 * @returns {{size: number, version: number, mask: number, modules: Uint8Array[]}}
 *          one row per `Uint8Array`, one module per element, 1 for dark
 */
export function qrMatrix(text, ec = 'M') {
    if (!EC_CODEWORDS[ec]) throw new Error(`unknown error-correction level ${ec}`);

    const bytes = new TextEncoder().encode(text);
    const version = chooseVersion(bytes.length, ec);
    const codewords = interleave(encodeData(bytes, version, ec), version, ec);

    // All eight masks are built and scored. There is no shortcut: the penalty
    // depends on the whole masked image, and picking one by inspection is how
    // a code ends up readable on the machine it was developed on.
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const m = new Matrix(version);
        m.drawFunctionPatterns(ec);
        m.drawCodewords(codewords);
        m.applyMask(mask);
        m.drawFormat(ec, mask);

        const score = m.penalty();
        if (!best || score < best.score) best = { score, mask, matrix: m };
    }

    return { size: best.matrix.size, version, mask: best.mask, modules: best.matrix.modules };
}

/**
 * Encode text as an SVG string.
 *
 * One `<path>` of one-unit squares rather than a rectangle per module: a
 * version 11 code is over three thousand modules, and three thousand DOM nodes
 * inside a panel that re-renders on every countdown tick is a visible stutter.
 *
 * The quiet zone is four modules and is not optional. It is the most commonly
 * dropped part of the format - it looks like padding - and a code without it
 * reads reliably on a phone held still and intermittently on one held by a
 * person.
 *
 * @param {string} text
 * @param {{ec?: 'L'|'M'|'Q'|'H', quietZone?: number, title?: string}} [opts]
 * @returns {string}
 */
export function qrSvg(text, { ec = 'M', quietZone = 4, title = '' } = {}) {
    const { size, modules } = qrMatrix(text, ec);
    const dim = size + quietZone * 2;

    let path = '';
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (modules[y][x]) path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
        }
    }

    // `shape-rendering: crispEdges` stops the renderer antialiasing module
    // boundaries into grey, which is exactly the contrast a scanner needs.
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
        `shape-rendering="crispEdges" role="img"${title ? ` aria-label="${escapeXml(title)}"` : ' aria-hidden="true"'}>` +
        `<rect width="${dim}" height="${dim}" fill="#fff"/>` +
        `<path d="${path}" fill="#000"/>` +
        `</svg>`
    );
}

function escapeXml(value) {
    return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
