import * as pc from 'playcanvas';

/**
 * PlayCanvas bootstrap, camera rig and desktop "magic window" look controls.
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {pc.Application}
 */
export function createEngine(canvas) {
    const app = new pc.Application(canvas, {
        mouse: new pc.Mouse(canvas),
        touch: new pc.TouchDevice(canvas),
        keyboard: new pc.Keyboard(window),
        graphicsDeviceOptions: {
            alpha: false,
            antialias: true,
            depth: true,
            preserveDrawingBuffer: false,
            xrCompatible: true,
            powerPreference: 'high-performance'
        }
    });

    app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);

    window.addEventListener('resize', () => app.resizeCanvas());

    return app;
}

/**
 * Camera rig.
 *
 * The camera sits under a root entity because WebXR owns the camera's local
 * transform for the duration of a session - anything we want to move (recentring
 * the view, offsetting the seated position) has to happen on the parent.
 *
 * Colour management is deliberately switched off. A video player's job is to put
 * the decoded frame on screen unchanged; gamma or tonemap passes would grade
 * footage that was already graded by whoever made it.
 *
 * @param {pc.Application} app
 * @returns {{root: pc.Entity, camera: pc.Entity}}
 */
export function createCameraRig(app) {
    const root = new pc.Entity('cameraRoot');
    app.root.addChild(root);

    const camera = new pc.Entity('camera');
    camera.addComponent('camera', {
        clearColor: new pc.Color(0.02, 0.02, 0.03),
        farClip: 400,
        nearClip: 0.05,
        fov: 70,
        gammaCorrection: pc.GAMMA_NONE,
        toneMapping: pc.TONEMAP_NONE
    });
    root.addChild(camera);

    return { root, camera };
}

/**
 * Drag-to-look for flat screens, so 180/360 titles are explorable without a
 * headset. Disabled automatically while an XR session owns the camera.
 */
export class MagicWindowControls {
    /**
     * @param {pc.Application} app
     * @param {pc.Entity} camera
     */
    constructor(app, camera) {
        this.app = app;
        this.camera = camera;
        this.enabled = false;

        this._yaw = 0;
        this._pitch = 0;
        this._targetYaw = 0;
        this._targetPitch = 0;
        this._dragging = false;
        this._lastX = 0;
        this._lastY = 0;

        this._bind();
    }

    _bind() {
        const canvas = this.app.graphicsDevice.canvas;

        const start = (x, y) => {
            if (!this.enabled) return;
            this._dragging = true;
            this._lastX = x;
            this._lastY = y;
            canvas.style.cursor = 'grabbing';
        };

        const move = (x, y) => {
            if (!this._dragging || !this.enabled) return;
            const dx = x - this._lastX;
            const dy = y - this._lastY;
            this._lastX = x;
            this._lastY = y;

            // Inverted: dragging the image left should turn the view right, the
            // same way every 360 viewer behaves.
            this._targetYaw -= dx * 0.16;
            this._targetPitch = Math.min(Math.max(this._targetPitch - dy * 0.16, -89), 89);
        };

        const end = () => {
            this._dragging = false;
            canvas.style.cursor = this.enabled ? 'grab' : 'default';
        };

        canvas.addEventListener('pointerdown', (e) => start(e.clientX, e.clientY));
        window.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
    }

    setEnabled(value) {
        this.enabled = value;
        const canvas = this.app.graphicsDevice.canvas;
        canvas.style.cursor = value ? 'grab' : 'default';
        if (!value) this._dragging = false;
    }

    reset() {
        this._yaw = this._targetYaw = 0;
        this._pitch = this._targetPitch = 0;
        this.camera.setLocalEulerAngles(0, 0, 0);
    }

    /** @param {number} dt */
    update(dt) {
        if (this.app.xr.active) return;
        if (!this.enabled) return;

        // Critically-damped-ish smoothing keeps drags from feeling twitchy.
        const t = 1 - Math.pow(0.0015, dt);
        this._yaw += (this._targetYaw - this._yaw) * t;
        this._pitch += (this._targetPitch - this._pitch) * t;

        this.camera.setLocalEulerAngles(this._pitch, this._yaw, 0);
    }
}
