/**
 * Stereo presentation surface for a live pair.
 *
 * Raw WebGL2 rather than the PlayCanvas engine the VOD player uses, for one
 * specific reason: the VOD path receives *one* texture with both eyes packed
 * into it, and has to work out inside the fragment shader which eye it is
 * currently drawing (see `src/player/stereo-material.js` - it compares
 * `view_position` against the two eye positions, which is ingenious and also
 * a workaround).
 *
 * A live pair arrives as two independent textures, and WebXR already calls us
 * once per view. So the eye is not something to be inferred at all - it is the
 * loop variable. Binding `textures[i]` for view `i` is the entire stereo
 * implementation, it is exact by construction, and it costs nothing.
 *
 * The 2D monitor modes are here too, and they are not decoration: anaglyph and
 * difference are how you check that a stereo rig is actually aligned before
 * putting it in front of someone's eyes.
 */

export const LAYOUT = {
    /** Both eyes side by side, as a director's monitor. */
    SBS: 'sbs',
    /** Red/cyan, for judging depth without a headset. */
    ANAGLYPH: 'anaglyph',
    LEFT: 'left',
    RIGHT: 'right',
    /** |left - right|. Vertical misalignment shows up as horizontal banding. */
    DIFFERENCE: 'difference'
};

export const PROJECTION = {
    FLAT: 'flat',
    DOME180: 'dome180',
    SPHERE360: 'sphere360',
    FISHEYE: 'fisheye'
};

/* --------------------------------------------------------------- geometry -- */

/**
 * Build a projection mesh with UVs baked in.
 *
 * Same approach as the VOD renderer: the projection *is* the geometry, so the
 * fragment shader stays a texture fetch and never has to branch per pixel on
 * what kind of video it is looking at.
 *
 * Texture rows arrive top-first from `VideoFrame`, so v increases downward
 * throughout - there is no flip anywhere in this file.
 *
 * @param {string} projection
 * @param {number} fovDeg - Horizontal sweep for dome/fisheye.
 * @param {number} aspect - Width/height of a single eye, for the flat screen.
 * @returns {{positions: Float32Array, uvs: Float32Array, indices: Uint16Array}}
 */
export function buildProjectionMesh(projection, fovDeg = 180, aspect = 16 / 9) {
    if (projection === PROJECTION.FLAT) return buildScreen(aspect);
    if (projection === PROJECTION.FISHEYE) return buildFisheyeDome(fovDeg);

    const sweep = projection === PROJECTION.SPHERE360 ? 360 : fovDeg;
    return buildEquirectDome(sweep);
}

/** A gently curved cinema screen, 4 m wide at 6 m out. */
function buildScreen(aspect) {
    const COLUMNS = 32;
    const ROWS = 2;
    const width = 4.2;
    const height = width / Math.max(aspect, 0.1);
    const curve = 0.35;

    const positions = [];
    const uvs = [];
    const indices = [];

    for (let row = 0; row <= ROWS; row += 1) {
        const v = row / ROWS;
        const y = (0.5 - v) * height;

        for (let col = 0; col <= COLUMNS; col += 1) {
            const u = col / COLUMNS;
            const x = (u - 0.5) * width;

            // Bow the screen away from the viewer at the edges.
            const z = -6 + curve * Math.pow((u - 0.5) * 2, 2);

            positions.push(x, y, z);
            uvs.push(u, v);
        }
    }

    for (let row = 0; row < ROWS; row += 1) {
        for (let col = 0; col < COLUMNS; col += 1) {
            const a = row * (COLUMNS + 1) + col;
            const b = a + COLUMNS + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }

    return pack(positions, uvs, indices);
}

/**
 * Equirectangular dome or sphere.
 *
 * Wound so the visible side faces inward - the viewer is inside it.
 */
function buildEquirectDome(sweepDeg) {
    const SEGMENTS = 64;
    const RINGS = 32;
    const RADIUS = 50;

    const sweep = (sweepDeg * Math.PI) / 180;
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let ring = 0; ring <= RINGS; ring += 1) {
        // v = 0 is the top of the image and the top of the dome.
        const v = ring / RINGS;
        const phi = v * Math.PI;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);

        for (let seg = 0; seg <= SEGMENTS; seg += 1) {
            const u = seg / SEGMENTS;

            // Centre the sweep on -Z, which is where the viewer looks by
            // default, so a 180 dome fills the view rather than starting at
            // the edge of it.
            const theta = (u - 0.5) * sweep - Math.PI / 2;

            positions.push(RADIUS * sinPhi * Math.cos(theta), RADIUS * cosPhi, RADIUS * sinPhi * Math.sin(theta));
            uvs.push(u, v);
        }
    }

    for (let ring = 0; ring < RINGS; ring += 1) {
        for (let seg = 0; seg < SEGMENTS; seg += 1) {
            const a = ring * (SEGMENTS + 1) + seg;
            const b = a + SEGMENTS + 1;
            // Reversed winding: we render the inside of the surface.
            indices.push(a, a + 1, b, a + 1, b + 1, b);
        }
    }

    return pack(positions, uvs, indices);
}

/**
 * Circular-fisheye dome.
 *
 * A fisheye frame is a disc, not a rectangle: the angle from the lens axis
 * maps to radius from the centre of the image. Baking that into the UVs is
 * what turns an MKX200-style capture into something with straight horizons.
 */
function buildFisheyeDome(fovDeg) {
    const SEGMENTS = 64;
    const RINGS = 32;
    const RADIUS = 50;

    const halfFov = ((fovDeg * Math.PI) / 180) / 2;
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let ring = 0; ring <= RINGS; ring += 1) {
        // Angle away from the lens axis (-Z).
        const alpha = (ring / RINGS) * halfFov;
        const sinA = Math.sin(alpha);
        const cosA = Math.cos(alpha);

        // Equidistant projection: image radius is proportional to that angle.
        const imageRadius = (ring / RINGS) * 0.5;

        for (let seg = 0; seg <= SEGMENTS; seg += 1) {
            const beta = (seg / SEGMENTS) * Math.PI * 2;

            positions.push(RADIUS * sinA * Math.cos(beta), RADIUS * sinA * Math.sin(beta), -RADIUS * cosA);
            uvs.push(0.5 + imageRadius * Math.cos(beta), 0.5 - imageRadius * Math.sin(beta));
        }
    }

    for (let ring = 0; ring < RINGS; ring += 1) {
        for (let seg = 0; seg < SEGMENTS; seg += 1) {
            const a = ring * (SEGMENTS + 1) + seg;
            const b = a + SEGMENTS + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }

    return pack(positions, uvs, indices);
}

function pack(positions, uvs, indices) {
    return {
        positions: new Float32Array(positions),
        uvs: new Float32Array(uvs),
        indices: new Uint16Array(indices)
    };
}

/* ---------------------------------------------------------------- shaders -- */

const SCREEN_VS = /* glsl */ `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
    // v runs downward to match the texture's row order.
    vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const SCREEN_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uLeft;
uniform sampler2D uRight;

// 0 sbs, 1 anaglyph, 2 left, 3 right, 4 difference
uniform int uLayout;

// 1.0 when one stream carries both eyes packed side by side.
uniform float uPacked;

// Set when only one eye is being received; both samplers point at it.
uniform float uMono;

vec3 sampleEye(float eye, vec2 uv) {
    if (uPacked > 0.5) {
        // Both eyes live in one frame: left in the left half.
        vec2 packedUv = vec2(uv.x * 0.5 + eye * 0.5, uv.y);
        return texture(uLeft, packedUv).rgb;
    }
    return eye < 0.5 ? texture(uLeft, uv).rgb : texture(uRight, uv).rgb;
}

void main() {
    vec3 color;

    if (uLayout == 0) {
        // Side by side: two full frames in one viewport.
        float eye = vUv.x < 0.5 ? 0.0 : 1.0;
        vec2 uv = vec2(fract(vUv.x * 2.0), vUv.y);
        color = sampleEye(uMono > 0.5 ? 0.0 : eye, uv);
    } else if (uLayout == 1) {
        vec3 l = sampleEye(0.0, vUv);
        vec3 r = sampleEye(uMono > 0.5 ? 0.0 : 1.0, vUv);
        // Dubois-ish weighting beats naive channel splitting for retinal
        // rivalry, but plain red/cyan is what people expect to calibrate with.
        color = vec3(l.r, r.g, r.b);
    } else if (uLayout == 2) {
        color = sampleEye(0.0, vUv);
    } else if (uLayout == 3) {
        color = sampleEye(uMono > 0.5 ? 0.0 : 1.0, vUv);
    } else {
        vec3 l = sampleEye(0.0, vUv);
        vec3 r = sampleEye(uMono > 0.5 ? 0.0 : 1.0, vUv);
        // Amplified so small vertical misalignment is actually visible.
        color = clamp(abs(l - r) * 4.0, 0.0, 1.0);
    }

    fragColor = vec4(color, 1.0);
}
`;

const SCENE_VS = /* glsl */ `#version 300 es
in vec3 aPosition;
in vec2 aUv;

uniform mat4 uViewProjection;

out vec2 vUv;

void main() {
    vUv = aUv;
    gl_Position = uViewProjection * vec4(aPosition, 1.0);
}
`;

const SCENE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTexture;

// Which eye this view is. No inference needed - WebXR hands us one view at a
// time and we bind that eye's texture before drawing it.
uniform float uEye;

uniform float uPacked;

void main() {
    vec2 uv = vUv;

    if (uPacked > 0.5) {
        uv.x = uv.x * 0.5 + uEye * 0.5;
    }

    fragColor = vec4(texture(uTexture, uv).rgb, 1.0);
}
`;

/* --------------------------------------------------------------- matrices -- */

/** Column-major 4x4 multiply, `out = a * b`. */
function multiply(out, a, b) {
    for (let col = 0; col < 4; col += 1) {
        for (let row = 0; row < 4; row += 1) {
            out[col * 4 + row] =
                a[row] * b[col * 4] +
                a[4 + row] * b[col * 4 + 1] +
                a[8 + row] * b[col * 4 + 2] +
                a[12 + row] * b[col * 4 + 3];
        }
    }
    return out;
}

/* ------------------------------------------------------------------- view -- */

export class StereoView {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
        this.canvas = canvas;

        const gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: true,
            // Required before the context can be handed to an XRWebGLLayer.
            xrCompatible: true,
            powerPreference: 'high-performance'
        });

        if (!gl) throw new Error('WebGL2 is required for the live monitor and is unavailable here.');

        this.gl = gl;

        this.layout = LAYOUT.SBS;
        this.projection = PROJECTION.FLAT;
        this.fovDeg = 180;
        this.aspect = 16 / 9;
        this.packed = false;
        this.mono = false;
        this.swapEyes = false;

        this.frameWidth = 0;
        this.frameHeight = 0;
        this.framesPresented = 0;

        /** @type {XRSession|null} */
        this.xrSession = null;
        this._xrRefSpace = null;
        this._onXrEnd = null;

        this._screenProgram = this._program(SCREEN_VS, SCREEN_FS);
        this._sceneProgram = this._program(SCENE_VS, SCENE_FS);

        this._textures = [this._texture(), this._texture()];
        this._buildScreenGeometry();
        this._buildSceneGeometry();

        this._mvp = new Float32Array(16);
        this._view = new Float32Array(16);

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.disable(gl.CULL_FACE);
        gl.clearColor(0, 0, 0, 1);
    }

    /* ------------------------------------------------------------ setup -- */

    _program(vsSource, fsSource) {
        const gl = this.gl;

        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);

            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(shader);
                gl.deleteShader(shader);
                throw new Error(`shader compile failed: ${log}`);
            }
            return shader;
        };

        const program = gl.createProgram();
        const vs = compile(gl.VERTEX_SHADER, vsSource);
        const fs = compile(gl.FRAGMENT_SHADER, fsSource);

        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
        }

        // Cache uniform locations once; looking them up per frame is a
        // surprisingly large share of a simple renderer's CPU time.
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i += 1) {
            const name = gl.getActiveUniform(program, i).name;
            uniforms[name] = gl.getUniformLocation(program, name);
        }

        return { program, uniforms };
    }

    _texture() {
        const gl = this.gl;
        const texture = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // One black pixel, so a draw before the first frame is black rather
        // than undefined.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

        return texture;
    }

    _buildScreenGeometry() {
        const gl = this.gl;

        this._screenVao = gl.createVertexArray();
        gl.bindVertexArray(this._screenVao);

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

        const location = gl.getAttribLocation(this._screenProgram.program, 'aPosition');
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);
    }

    _buildSceneGeometry() {
        const gl = this.gl;
        const mesh = buildProjectionMesh(this.projection, this.fovDeg, this.aspect);

        this._sceneVao ??= gl.createVertexArray();
        gl.bindVertexArray(this._sceneVao);

        this._positionBuffer ??= gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

        const positionLoc = gl.getAttribLocation(this._sceneProgram.program, 'aPosition');
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 3, gl.FLOAT, false, 0, 0);

        this._uvBuffer ??= gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this._uvBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);

        const uvLoc = gl.getAttribLocation(this._sceneProgram.program, 'aUv');
        gl.enableVertexAttribArray(uvLoc);
        gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);

        this._indexBuffer ??= gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

        this._indexCount = mesh.indices.length;
        gl.bindVertexArray(null);
    }

    /* ------------------------------------------------------------ config -- */

    /**
     * @param {string} projection
     * @param {number} [fovDeg]
     */
    setProjection(projection, fovDeg = this.fovDeg) {
        if (projection === this.projection && fovDeg === this.fovDeg) return;

        this.projection = projection;
        this.fovDeg = fovDeg;
        this._buildSceneGeometry();
    }

    /** @param {string} layout - {@link LAYOUT} */
    setLayout(layout) {
        this.layout = layout;
    }

    /**
     * Swap which decoded stream is treated as the left eye.
     *
     * Needed in practice: which physical camera ends up on the left depends on
     * how the phone is rotated, and getting it backwards inverts the depth of
     * the whole scene - everything that should be near appears far. It is
     * immediately obvious in a headset and almost invisible on a flat monitor,
     * which is exactly why the anaglyph mode is worth having.
     *
     * @param {boolean} swap
     */
    setSwapEyes(swap) {
        this.swapEyes = Boolean(swap);
    }

    /* ----------------------------------------------------------- present -- */

    /**
     * Upload a decoded pair and release it.
     *
     * Takes ownership: both frames are closed before this returns. Holding a
     * `VideoFrame` past the upload is what stalls a WebCodecs decoder.
     *
     * @param {{left: VideoFrame|null, right: VideoFrame|null, packed: VideoFrame|null}} pair
     */
    present(pair) {
        const gl = this.gl;

        const primary = pair.packed ?? pair.left ?? pair.right;
        if (!primary) return;

        this.packed = Boolean(pair.packed);
        this.mono = !pair.packed && !(pair.left && pair.right);

        this.frameWidth = primary.displayWidth ?? primary.codedWidth;
        this.frameHeight = primary.displayHeight ?? primary.codedHeight;
        this.framesPresented += 1;

        const slots = this.swapEyes && pair.left && pair.right ? [pair.right, pair.left] : [pair.left, pair.right];
        const sources = pair.packed ? [pair.packed, null] : slots;

        for (let i = 0; i < 2; i += 1) {
            const frame = sources[i];
            if (!frame) continue;

            gl.bindTexture(gl.TEXTURE_2D, this._textures[i]);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        }

        // Mono: point both samplers at the one texture we actually filled, so
        // no shader path has to special-case it.
        if (this.mono && !pair.left && pair.right) {
            gl.bindTexture(gl.TEXTURE_2D, this._textures[0]);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pair.right);
        }

        // Flat playback needs the screen's shape to follow the source.
        if (this.projection === PROJECTION.FLAT && this.frameHeight > 0) {
            const aspect = this.packed ? this.frameWidth / 2 / this.frameHeight : this.frameWidth / this.frameHeight;

            if (Math.abs(aspect - this.aspect) > 0.01) {
                this.aspect = aspect;
                this._buildSceneGeometry();
            }
        }

        pair.left?.close();
        pair.right?.close();
        pair.packed?.close();
    }

    /* ------------------------------------------------------- 2D renderer -- */

    /** Draw the monitor view. No-op while an XR session owns the context. */
    render() {
        if (this.xrSession) return;

        const gl = this.gl;
        const { clientWidth, clientHeight } = this.canvas;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        const width = Math.max(1, Math.floor(clientWidth * dpr));
        const height = Math.max(1, Math.floor(clientHeight * dpr));

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.disable(gl.DEPTH_TEST);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const { program, uniforms } = this._screenProgram;
        gl.useProgram(program);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._textures[0]);
        gl.uniform1i(uniforms.uLeft, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._textures[this.mono ? 0 : 1]);
        gl.uniform1i(uniforms.uRight, 1);

        gl.uniform1i(uniforms.uLayout, ['sbs', 'anaglyph', 'left', 'right', 'difference'].indexOf(this.layout));
        gl.uniform1f(uniforms.uPacked, this.packed ? 1 : 0);
        gl.uniform1f(uniforms.uMono, this.mono ? 1 : 0);

        gl.bindVertexArray(this._screenVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
    }

    /* ------------------------------------------------------ XR presenter -- */

    static async xrSupported() {
        if (!navigator.xr?.isSessionSupported) return false;
        return navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    }

    /**
     * Enter immersive playback.
     *
     * @param {() => void} [onEnd]
     */
    async enterVR(onEnd = null) {
        if (this.xrSession) return;

        const session = await navigator.xr.requestSession('immersive-vr', {
            optionalFeatures: ['local-floor']
        });

        const gl = this.gl;
        await gl.makeXRCompatible();

        session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

        // `local-floor` gives a sensible standing origin; `local` is the
        // universally available fallback and is fine for video, which is
        // rendered around the head rather than in the room.
        this._xrRefSpace = await session
            .requestReferenceSpace('local-floor')
            .catch(() => session.requestReferenceSpace('local'));

        this.xrSession = session;
        this._onXrEnd = onEnd;

        session.addEventListener('end', () => {
            this.xrSession = null;
            this._xrRefSpace = null;
            this._onXrEnd?.();
        });

        session.requestAnimationFrame((time, frame) => this._xrFrame(time, frame));
    }

    exitVR() {
        this.xrSession?.end().catch(() => {});
    }

    /**
     * @param {number} time
     * @param {XRFrame} frame
     */
    _xrFrame(time, frame) {
        const session = this.xrSession;
        if (!session) return;

        session.requestAnimationFrame((t, f) => this._xrFrame(t, f));

        this.onXrTick?.();

        const pose = frame.getViewerPose(this._xrRefSpace);
        if (!pose) return;

        const gl = this.gl;
        const layer = session.renderState.baseLayer;

        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
        gl.enable(gl.DEPTH_TEST);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const { program, uniforms } = this._sceneProgram;
        gl.useProgram(program);
        gl.bindVertexArray(this._sceneVao);

        // For an immersive projection the imagery is effectively at infinity,
        // so head *translation* must not move it - otherwise leaning forward
        // slides the whole world and the horizon shears. Rotation still
        // applies. A flat screen is a real object and keeps its translation.
        const stripTranslation = this.projection !== PROJECTION.FLAT;

        for (let i = 0; i < pose.views.length; i += 1) {
            const view = pose.views[i];
            const viewport = layer.getViewport(view);
            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);

            this._view.set(view.transform.inverse.matrix);
            if (stripTranslation) {
                this._view[12] = 0;
                this._view[13] = 0;
                this._view[14] = 0;
            }

            multiply(this._mvp, view.projectionMatrix, this._view);
            gl.uniformMatrix4fv(uniforms.uViewProjection, false, this._mvp);

            // The eye is the loop index. That is the whole trick, and it is why
            // separate per-eye streams are easier to render correctly than a
            // packed frame, not harder.
            const eye = view.eye === 'right' ? 1 : 0;
            const slot = this.mono ? 0 : eye;

            gl.uniform1f(uniforms.uEye, eye);
            gl.uniform1f(uniforms.uPacked, this.packed ? 1 : 0);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this._textures[this.packed ? 0 : slot]);
            gl.uniform1i(uniforms.uTexture, 0);

            gl.drawElements(gl.TRIANGLES, this._indexCount, gl.UNSIGNED_SHORT, 0);
        }

        gl.bindVertexArray(null);
    }

    destroy() {
        this.exitVR();

        const gl = this.gl;
        for (const texture of this._textures) gl.deleteTexture(texture);
        gl.deleteProgram(this._screenProgram.program);
        gl.deleteProgram(this._sceneProgram.program);
    }
}
