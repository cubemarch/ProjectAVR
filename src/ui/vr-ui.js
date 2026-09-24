import * as pc from 'playcanvas';
import { formatDuration } from '../catalog/catalog.js';
import { PROJECTION, STEREO } from '../catalog/media-format.js';

/**
 * In-headset transport UI.
 *
 * The panel is a single canvas-textured quad rather than a tree of 3D widgets.
 * That keeps hit-testing honest: the buttons are drawn in canvas pixel space
 * and hit-tested in that same space, so what you see is literally what you
 * click, and restyling the panel never desynchronises from its hit regions.
 *
 * Emits: 'exitVr', 'recenter', 'formatChange' (format), 'back'
 */

const PANEL_W = 1024;
const PANEL_H = 260;
const PANEL_WORLD_W = 1.15;
const PANEL_WORLD_H = (PANEL_H / PANEL_W) * 1.15;

export class VrUI extends pc.EventHandler {
    /**
     * @param {pc.Application} app
     * @param {import('../player/video-source.js').VideoSource} video
     * @param {pc.Entity} camera
     */
    constructor(app, video, camera) {
        super();

        this.app = app;
        this.video = video;
        this.camera = camera;

        this.item = null;
        this.format = null;
        this.visible = false;
        this._idleTime = 0;
        this._hovered = null;

        this._buildPanel();
        this._buildPointers();
        this._bindInput();

        this._ray = new pc.Ray();
        this._invPanel = new pc.Mat4();
        this._localOrigin = new pc.Vec3();
        this._localDir = new pc.Vec3();
    }

    /* ------------------------------------------------------------- panel -- */

    _buildPanel() {
        const canvas = document.createElement('canvas');
        canvas.width = PANEL_W;
        canvas.height = PANEL_H;
        this._canvas = canvas;
        this._ctx = canvas.getContext('2d');

        this._texture = new pc.Texture(this.app.graphicsDevice, {
            name: 'vr-panel',
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE,
            mipmaps: false,
            flipY: true
        });
        this._texture.setSource(canvas);

        const material = new pc.StandardMaterial();
        material.useLighting = false;
        material.emissiveMap = this._texture;
        material.emissive = new pc.Color(1, 1, 1);
        material.opacityMap = this._texture;
        material.opacityMapChannel = 'a';
        material.blendType = pc.BLEND_NORMAL;
        material.depthTest = false;
        material.depthWrite = false;
        material.cull = pc.CULLFACE_NONE;
        material.update();
        this._panelMaterial = material;

        const panel = new pc.Entity('vrPanel');
        panel.addComponent('render', { type: 'plane', material, castShadows: false });
        // A `plane` primitive lies in XZ; stand it up and size it to the canvas.
        panel.setLocalEulerAngles(90, 0, 0);
        panel.setLocalScale(PANEL_WORLD_W, 1, PANEL_WORLD_H);

        this._panelPivot = new pc.Entity('vrPanelPivot');
        this._panelPivot.addChild(panel);
        this._panelPivot.enabled = false;
        this.app.root.addChild(this._panelPivot);

        this._panel = panel;

        // Buttons are laid out once; `hit` rects are in canvas pixels.
        this._buttons = this._layoutButtons();
        this._drawPanel();
    }

    _layoutButtons() {
        const y = 150;
        const r = 34;
        const mk = (id, cx, label, opts = {}) => ({
            id,
            cx,
            cy: opts.cy ?? y,
            r: opts.r ?? r,
            label,
            wide: opts.wide || 0,
            ...opts
        });

        return [
            mk('back', 62, '←'),
            mk('back10', 250, '-10'),
            mk('playpause', 340, 'play', { r: 42 }),
            mk('forward10', 430, '+10'),
            mk('recenter', 560, 'recentre', { wide: 150 }),
            mk('projection', 730, 'proj', { wide: 150 }),
            mk('stereo', 880, 'stereo', { wide: 130 }),
            mk('exit', 975, '✕', { r: 30, cy: 46 })
        ];
    }

    _drawPanel() {
        const ctx = this._ctx;
        const w = PANEL_W;
        const h = PANEL_H;

        ctx.clearRect(0, 0, w, h);

        // Rounded translucent slab.
        roundRect(ctx, 8, 8, w - 16, h - 16, 26);
        ctx.fillStyle = 'rgba(14, 14, 20, 0.88)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Title and format tag.
        ctx.fillStyle = '#f4f4f6';
        ctx.font = '600 30px Inter, Helvetica, Arial, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(truncate(ctx, this.item?.title || '', 560), 40, 46);

        if (this.format) {
            ctx.fillStyle = '#00d8e0';
            ctx.font = '600 20px Inter, Helvetica, Arial, sans-serif';
            ctx.fillText(this._formatLabel(), 40, 82);
        }

        this._drawScrubber(ctx);

        for (const btn of this._buttons) {
            this._drawButton(ctx, btn);
        }

        this._texture.upload();
    }

    _drawScrubber(ctx) {
        const x = 40;
        const y = 108;
        const w = PANEL_W - 80;
        const h = 8;
        const progress = this.video.progress;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.24)';
        roundRect(ctx, x, y, w, h, h / 2);
        ctx.fill();

        ctx.fillStyle = '#7c5cff';
        roundRect(ctx, x, y, Math.max(w * progress, h), h, h / 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x + w * progress, y + h / 2, 11, 0, Math.PI * 2);
        ctx.fillStyle = '#9b7dff';
        ctx.fill();

        ctx.fillStyle = '#a2a2b0';
        ctx.font = '500 20px Inter, Helvetica, Arial, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(
            `${formatDuration(this.video.currentTime)} / ${formatDuration(this.video.duration)}`,
            PANEL_W - 40,
            82
        );
        ctx.textAlign = 'left';
    }

    _drawButton(ctx, btn) {
        const hovered = this._hovered === btn.id;
        const label = this._buttonLabel(btn);

        ctx.save();

        if (btn.wide) {
            const x = btn.cx - btn.wide / 2;
            roundRect(ctx, x, btn.cy - 26, btn.wide, 52, 26);
            ctx.fillStyle = hovered ? 'rgba(124, 92, 255, 0.55)' : 'rgba(255, 255, 255, 0.10)';
            ctx.fill();
            ctx.strokeStyle = hovered ? '#9b7dff' : 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 2;
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.arc(btn.cx, btn.cy, btn.r, 0, Math.PI * 2);
            ctx.fillStyle =
                btn.id === 'playpause'
                    ? hovered
                        ? '#ffffff'
                        : '#f4f4f6'
                    : hovered
                      ? 'rgba(124, 92, 255, 0.55)'
                      : 'rgba(255, 255, 255, 0.10)';
            ctx.fill();
            ctx.strokeStyle = hovered ? '#9b7dff' : 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        ctx.fillStyle = btn.id === 'playpause' ? '#0b0b0f' : '#f4f4f6';
        ctx.font = `600 ${btn.wide ? 20 : 22}px Inter, Helvetica, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (btn.id === 'playpause') {
            drawTransportGlyph(ctx, btn.cx, btn.cy, this.video.paused);
        } else {
            ctx.fillText(label, btn.cx, btn.cy + 1);
        }

        ctx.restore();
    }

    _buttonLabel(btn) {
        switch (btn.id) {
            case 'recenter':
                return 'RECENTRE';
            case 'projection':
                return this._projectionShort();
            case 'stereo':
                return this.format?.stereo === STEREO.SBS ? 'SBS 3D' : this.format?.stereo === STEREO.TB ? 'OU 3D' : 'MONO';
            default:
                return btn.label;
        }
    }

    _projectionShort() {
        switch (this.format?.projection) {
            case PROJECTION.DOME180:
                return '180°';
            case PROJECTION.SPHERE360:
                return '360°';
            case PROJECTION.FISHEYE:
                return `FISH ${this.format.fisheyeFov}°`;
            default:
                return 'FLAT';
        }
    }

    _formatLabel() {
        return `${this._projectionShort()} · ${
            this.format.stereo === STEREO.MONO ? 'Monoscopic' : this.format.stereo === STEREO.SBS ? 'Side-by-side 3D' : 'Over-under 3D'
        }`;
    }

    /* ---------------------------------------------------------- pointers -- */

    _buildPointers() {
        const laserMaterial = new pc.StandardMaterial();
        laserMaterial.useLighting = false;
        laserMaterial.emissive = new pc.Color(0.49, 0.36, 1);
        laserMaterial.blendType = pc.BLEND_NORMAL;
        laserMaterial.opacity = 0.75;
        laserMaterial.depthWrite = false;
        laserMaterial.update();

        const dotMaterial = new pc.StandardMaterial();
        dotMaterial.useLighting = false;
        dotMaterial.emissive = new pc.Color(0.61, 0.49, 1);
        dotMaterial.depthTest = false;
        dotMaterial.depthWrite = false;
        dotMaterial.update();

        this._laserMaterial = laserMaterial;
        this._dotMaterial = dotMaterial;
        this._pointers = new Map();
    }

    _createPointer() {
        const root = new pc.Entity('pointer');

        const laser = new pc.Entity('laser');
        laser.addComponent('render', { type: 'box', material: this._laserMaterial, castShadows: false });
        laser.setLocalScale(0.004, 0.004, 1);
        laser.setLocalPosition(0, 0, -0.5);
        root.addChild(laser);

        const dot = new pc.Entity('dot');
        dot.addComponent('render', { type: 'sphere', material: this._dotMaterial, castShadows: false });
        dot.setLocalScale(0.014, 0.014, 0.014);
        root.addChild(dot);

        this.app.root.addChild(root);
        return { root, laser, dot };
    }

    _bindInput() {
        const xr = this.app.xr;

        xr.input.on('add', (inputSource) => {
            this._pointers.set(inputSource, this._createPointer());

            inputSource.on('select', () => this._onSelect(inputSource));
            inputSource.on('remove', () => {
                const p = this._pointers.get(inputSource);
                if (p) p.root.destroy();
                this._pointers.delete(inputSource);
            });
        });

        xr.on('end', () => {
            for (const p of this._pointers.values()) p.root.destroy();
            this._pointers.clear();
            this.setVisible(false);
        });

        // Summon the panel wherever the viewer is looking when a session starts.
        xr.on('start', () => {
            this.setVisible(true);
            this._placePanel();
        });
    }

    _onSelect(inputSource) {
        if (!this.visible) {
            this.setVisible(true);
            this._placePanel();
            return;
        }

        const hit = this._hitTest(inputSource.getOrigin(), inputSource.getDirection());
        if (!hit) {
            // A press into empty space dismisses the panel, so it never gets in
            // the way of the content.
            this.setVisible(false);
            return;
        }

        this._activate(hit);
    }

    /**
     * Intersect a world-space ray with the panel quad.
     *
     * Done in the panel's local space so the maths stays a plane intersection
     * regardless of how the panel is oriented in the world.
     *
     * @returns {{id: string, u: number, v: number}|null}
     */
    _hitTest(origin, direction) {
        if (!this.visible) return null;

        this._invPanel.copy(this._panel.getWorldTransform()).invert();
        this._invPanel.transformPoint(origin, this._localOrigin);
        this._invPanel.transformVector(direction, this._localDir);

        // The plane primitive's surface is local Y = 0, with X and Z spanning it.
        if (Math.abs(this._localDir.y) < 1e-6) return null;

        const t = -this._localOrigin.y / this._localDir.y;
        if (t < 0) return null;

        const x = this._localOrigin.x + this._localDir.x * t;
        const z = this._localOrigin.z + this._localDir.z * t;

        // Local plane spans -0.5..0.5 on both axes.
        if (Math.abs(x) > 0.5 || Math.abs(z) > 0.5) return null;

        const u = x + 0.5;
        const v = z + 0.5;

        const px = u * PANEL_W;
        const py = v * PANEL_H;

        for (const btn of this._buttons) {
            if (btn.wide) {
                if (Math.abs(px - btn.cx) <= btn.wide / 2 && Math.abs(py - btn.cy) <= 26) {
                    return { id: btn.id, u, v };
                }
            } else if (Math.hypot(px - btn.cx, py - btn.cy) <= btn.r) {
                return { id: btn.id, u, v };
            }
        }

        // Scrubber band.
        if (py >= 92 && py <= 130 && px >= 40 && px <= PANEL_W - 40) {
            return { id: 'seek', u: (px - 40) / (PANEL_W - 80), v };
        }

        return { id: 'panel', u, v };
    }

    _activate(hit) {
        this._idleTime = 0;

        switch (hit.id) {
            case 'playpause':
                this.video.togglePlay();
                break;
            case 'back10':
                this.video.seekBy(-10);
                break;
            case 'forward10':
                this.video.seekBy(10);
                break;
            case 'seek':
                this.video.seekTo(hit.u * this.video.duration);
                break;
            case 'recenter':
                this.fire('recenter');
                this._placePanel();
                break;
            case 'projection':
                this._cycle('projection');
                break;
            case 'stereo':
                this._cycle('stereo');
                break;
            case 'back':
                this.fire('back');
                break;
            case 'exit':
                this.fire('exitVr');
                break;
        }

        this._drawPanel();
    }

    _cycle(which) {
        if (which === 'projection') {
            const order = [PROJECTION.FLAT, PROJECTION.DOME180, PROJECTION.SPHERE360, PROJECTION.FISHEYE];
            const next = order[(order.indexOf(this.format.projection) + 1) % order.length];
            this.format = { ...this.format, projection: next, fisheyeFov: this.format.fisheyeFov || 190 };
        } else {
            const order = [STEREO.MONO, STEREO.SBS, STEREO.TB];
            const next = order[(order.indexOf(this.format.stereo) + 1) % order.length];
            this.format = { ...this.format, stereo: next };
        }

        this.fire('formatChange', this.format);
    }

    /* ----------------------------------------------------------- runtime -- */

    /** Park the panel in front of the viewer, level and facing them. */
    _placePanel() {
        const camPos = this.camera.getPosition();
        const forward = this.camera.forward;

        // Flatten to the horizontal plane so the panel never tips with the head.
        const flat = new pc.Vec3(forward.x, 0, forward.z);
        if (flat.length() < 1e-4) flat.set(0, 0, -1);
        flat.normalize();

        const distance = 1.35;
        this._panelPivot.setPosition(
            camPos.x + flat.x * distance,
            camPos.y - 0.35,
            camPos.z + flat.z * distance
        );

        const yaw = Math.atan2(-flat.x, -flat.z) * pc.math.RAD_TO_DEG;
        this._panelPivot.setEulerAngles(-18, yaw + 180, 0);
    }

    setVisible(value) {
        this.visible = value;
        this._panelPivot.enabled = value;
        this._idleTime = 0;
        if (value) this._drawPanel();
    }

    /**
     * @param {object} item
     * @param {object} format
     */
    setItem(item, format) {
        this.item = item;
        this.format = format;
        this._drawPanel();
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.app.xr.active) return;

        let hovering = null;

        for (const [inputSource, pointer] of this._pointers) {
            const origin = inputSource.getOrigin();
            const direction = inputSource.getDirection();

            pointer.root.setPosition(origin);
            pointer.root.lookAt(origin.x + direction.x, origin.y + direction.y, origin.z + direction.z);

            const hit = this._hitTest(origin, direction);
            const length = hit ? this._panelPivot.getPosition().distance(origin) : 1.2;

            pointer.laser.setLocalScale(0.004, 0.004, length);
            pointer.laser.setLocalPosition(0, 0, -length / 2);
            pointer.dot.enabled = !!hit;
            if (hit) {
                pointer.dot.setPosition(
                    origin.x + direction.x * length,
                    origin.y + direction.y * length,
                    origin.z + direction.z * length
                );
            }

            if (hit && hit.id !== 'panel') hovering = hit.id;
        }

        if (hovering !== this._hovered) {
            this._hovered = hovering;
            this._drawPanel();
        } else if (!this.video.paused && this.visible) {
            // Cheap refresh so the scrubber advances without redrawing at 90 Hz.
            this._idleTime += dt;
            if (this._idleTime > 0.5) {
                this._idleTime = 0;
                this._drawPanel();
            }
        }
    }
}

/* ---------------------------------------------------------------- canvas -- */

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawTransportGlyph(ctx, cx, cy, paused) {
    ctx.fillStyle = '#0b0b0f';

    if (paused) {
        ctx.beginPath();
        ctx.moveTo(cx - 10, cy - 15);
        ctx.lineTo(cx + 16, cy);
        ctx.lineTo(cx - 10, cy + 15);
        ctx.closePath();
        ctx.fill();
    } else {
        ctx.fillRect(cx - 13, cy - 15, 9, 30);
        ctx.fillRect(cx + 4, cy - 15, 9, 30);
    }
}

function truncate(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;

    let str = text;
    while (str.length > 1 && ctx.measureText(`${str}…`).width > maxWidth) {
        str = str.slice(0, -1);
    }
    return `${str}…`;
}
