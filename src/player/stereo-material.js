import * as pc from 'playcanvas';
import { STEREO } from '../catalog/media-format.js';

/**
 * Video material with per-eye frame unpacking.
 *
 * The hard part of stereo playback on the web is that WebXR renders both eyes
 * through a single PlayCanvas camera, so we cannot simply swap layers or
 * materials between eyes - by the time a draw call is issued, "which eye" is
 * not something JavaScript can observe.
 *
 * The engine does however set the built-in `view_position` uniform once per
 * view, from `XrView.positionData` (the per-eye world position). So the shader
 * can identify its own eye by asking which of the two eye positions it is
 * standing at. That is exact rather than heuristic: no reliance on frustum
 * asymmetry, IPD sign or multiview extensions, and it degrades cleanly to the
 * left eye when there is only one view.
 */

const VERTEX_SHADER = /* glsl */ `
    attribute vec3 aPosition;
    attribute vec2 aUv0;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    varying vec2 vUv0;

    void main(void) {
        vUv0 = aUv0;
        gl_Position = matrix_viewProjection * matrix_model * vec4(aPosition, 1.0);
    }
`;

const FRAGMENT_SHADER = /* glsl */ `
    precision highp float;

    varying vec2 vUv0;

    uniform sampler2D uVideo;

    // Set by the engine, once per rendered view.
    uniform vec3 view_position;

    // Per-eye world positions, refreshed each frame from XrViews.
    uniform vec3 uEyeLeft;
    uniform vec3 uEyeRight;

    // 0 = mono, 1 = side-by-side, 2 = top-bottom.
    uniform float uStereoMode;

    // -1 = detect from view_position, 0 = force left, 1 = force right.
    uniform float uForceEye;

    // Extra crop applied before the stereo split: (offsetU, offsetV, scaleU, scaleV).
    uniform vec4 uCrop;

    uniform float uBrightness;
    uniform float uFade;

    float resolveEye() {
        if (uForceEye >= 0.0) {
            return uForceEye;
        }

        // Whichever eye position we are closest to is the eye being drawn.
        float dl = distance(view_position, uEyeLeft);
        float dr = distance(view_position, uEyeRight);
        return dl <= dr ? 0.0 : 1.0;
    }

    void main(void) {
        vec2 uv = vUv0 * uCrop.zw + uCrop.xy;

        float eye = resolveEye();

        if (uStereoMode > 1.5) {
            // Top-bottom: left eye occupies the TOP half of the frame, which is
            // the upper half of v because the texture is uploaded flipped.
            uv.y = uv.y * 0.5 + (1.0 - eye) * 0.5;
        } else if (uStereoMode > 0.5) {
            // Side-by-side: left eye is the left half.
            uv.x = uv.x * 0.5 + eye * 0.5;
        }

        vec3 rgb = texture2D(uVideo, uv).rgb * uBrightness * uFade;
        gl_FragColor = vec4(rgb, 1.0);
    }
`;

const STEREO_MODE_VALUE = {
    [STEREO.MONO]: 0,
    [STEREO.SBS]: 1,
    [STEREO.TB]: 2
};

/**
 * Wraps a ShaderMaterial and keeps its per-eye uniforms in sync with the
 * active XR session.
 */
export class StereoVideoMaterial {
    /**
     * @param {pc.Application} app
     * @param {pc.Texture} videoTexture
     */
    constructor(app, videoTexture) {
        this.app = app;

        this.material = new pc.ShaderMaterial({
            uniqueName: 'AvrStereoVideo',
            attributes: {
                aPosition: pc.SEMANTIC_POSITION,
                aUv0: pc.SEMANTIC_TEXCOORD0
            },
            vertexGLSL: VERTEX_SHADER,
            fragmentGLSL: FRAGMENT_SHADER
        });

        // Seen from inside a sphere or dome every ray hits exactly one surface,
        // so disabling culling costs nothing and removes a whole class of
        // winding-order bugs.
        this.material.cull = pc.CULLFACE_NONE;
        this.material.depthWrite = true;

        this._eyeLeft = new Float32Array(3);
        this._eyeRight = new Float32Array(3);
        this._crop = new Float32Array([0, 0, 1, 1]);

        this.setTexture(videoTexture);
        this.setStereoMode(STEREO.MONO);
        this.setBrightness(1);
        this.setFade(1);
        this._setForcedEye(0);

        this.material.update();
    }

    /** @param {pc.Texture} texture */
    setTexture(texture) {
        this.material.setParameter('uVideo', texture);
    }

    /** @param {string} stereo - One of STEREO.*. */
    setStereoMode(stereo) {
        this._stereo = stereo;
        this.material.setParameter('uStereoMode', STEREO_MODE_VALUE[stereo] ?? 0);
    }

    /**
     * Crop applied before the stereo split, as (offsetU, offsetV, scaleU, scaleV).
     * Useful for letterbox removal on flat content.
     */
    setCrop(offsetU, offsetV, scaleU, scaleV) {
        this._crop[0] = offsetU;
        this._crop[1] = offsetV;
        this._crop[2] = scaleU;
        this._crop[3] = scaleV;
        this.material.setParameter('uCrop', this._crop);
    }

    setBrightness(value) {
        this.material.setParameter('uBrightness', value);
    }

    /** Global multiplier used for fade-to-black transitions. */
    setFade(value) {
        this.material.setParameter('uFade', value);
    }

    _setForcedEye(eye) {
        this.material.setParameter('uForceEye', eye);
    }

    /**
     * Refresh per-eye uniforms. Call once per frame.
     *
     * Outside XR - and inside a session that only reports a single view - there
     * is no second eye to disambiguate, so we pin the shader to the left eye
     * and skip the distance test entirely.
     */
    update() {
        const xr = this.app.xr;
        const views = xr?.active ? xr.views?.list : null;

        if (!views || views.length < 2) {
            this._setForcedEye(0);
            return;
        }

        let left = null;
        let right = null;

        for (const view of views) {
            if (view.eye === pc.XREYE_LEFT) left = view;
            else if (view.eye === pc.XREYE_RIGHT) right = view;
        }

        // Some runtimes report views without an `eye` label; positional order is
        // the documented fallback (view 0 is the left eye).
        if (!left || !right) {
            left = views[0];
            right = views[1];
        }

        if (!readEyePosition(left, this._eyeLeft) || !readEyePosition(right, this._eyeRight)) {
            this._setForcedEye(0);
            return;
        }

        this._setForcedEye(-1);
        this.material.setParameter('uEyeLeft', this._eyeLeft);
        this.material.setParameter('uEyeRight', this._eyeRight);
    }

    destroy() {
        this.material.destroy();
    }
}

/**
 * Read an XR view's world position into `out`.
 *
 * `XrView.positionData` is the exact Float32Array the renderer passes to the
 * `view_position` uniform, so matching against it is guaranteed consistent.
 * It is a runtime getter but is absent from the published type definitions, so
 * we fall back to the translation column of `viewInvOffMat` - the matrix that
 * `positionData` is itself derived from - if a future engine build drops it.
 *
 * @param {object} view - XrView.
 * @param {Float32Array} out
 * @returns {boolean} False if neither source is available.
 */
function readEyePosition(view, out) {
    const data = view.positionData;
    if (data && data.length >= 3) {
        out[0] = data[0];
        out[1] = data[1];
        out[2] = data[2];
        return true;
    }

    const mat = view.viewInvOffMat;
    if (mat?.data) {
        out[0] = mat.data[12];
        out[1] = mat.data[13];
        out[2] = mat.data[14];
        return true;
    }

    return false;
}
