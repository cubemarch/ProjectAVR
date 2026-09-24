import * as pc from 'playcanvas';
import { PROJECTION, isImmersive } from '../catalog/media-format.js';
import { createProjectionMesh } from './projections.js';
import { StereoVideoMaterial } from './stereo-material.js';

/**
 * The 3D playback surface: builds the right geometry for a title, drives the
 * stereo material, and owns the small amount of scene dressing that flat
 * content sits inside.
 */
export class ImmersivePlayer {
    /**
     * @param {pc.Application} app
     * @param {import('./video-source.js').VideoSource} videoSource
     * @param {pc.Entity} cameraRoot
     * @param {pc.Entity} camera
     */
    constructor(app, videoSource, cameraRoot, camera) {
        this.app = app;
        this.video = videoSource;
        this.cameraRoot = cameraRoot;
        this.camera = camera;

        this.format = null;
        this.active = false;

        this.stereoMaterial = new StereoVideoMaterial(app, videoSource.texture);

        // Holds the video geometry. Rotating this entity is how we recentre.
        this.mediaRoot = new pc.Entity('mediaRoot');
        app.root.addChild(this.mediaRoot);

        this.mediaEntity = null;
        this.environment = this._createEnvironment();

        this._fade = 0;
        this._fadeTarget = 0;
    }

    /**
     * Dressing for flat content: a dark floor with a soft falloff so the screen
     * has somewhere to live instead of floating in a void. Immersive
     * projections hide it, since they surround the viewer anyway.
     */
    _createEnvironment() {
        const root = new pc.Entity('environment');
        this.app.root.addChild(root);

        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 512;
        const ctx = canvas.getContext('2d');

        const gradient = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
        gradient.addColorStop(0, '#1a1a20');
        gradient.addColorStop(1, '#000000');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 512, 512);

        ctx.strokeStyle = 'rgba(120, 120, 140, 0.16)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 512; i += 32) {
            ctx.beginPath();
            ctx.moveTo(i, 0);
            ctx.lineTo(i, 512);
            ctx.moveTo(0, i);
            ctx.lineTo(512, i);
            ctx.stroke();
        }

        const texture = new pc.Texture(this.app.graphicsDevice, {
            name: 'floor-grid',
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE
        });
        texture.setSource(canvas);

        const material = new pc.StandardMaterial();
        material.useLighting = false;
        material.emissiveMap = texture;
        material.emissive = new pc.Color(1, 1, 1);
        material.update();

        const floor = new pc.Entity('floor');
        floor.addComponent('render', { type: 'plane', material });
        floor.setLocalScale(24, 1, 24);
        floor.setLocalPosition(0, -1.5, 0);
        root.addChild(floor);

        return root;
    }

    /**
     * Swap in a new title.
     *
     * Rebuilds geometry because projection and aspect ratio are baked into the
     * mesh - cheap enough at a few thousand vertices, and it keeps the shader
     * free of projection branching.
     *
     * @param {object} item - Catalog entry.
     * @param {object} format - Result of `resolveFormat`.
     */
    setItem(item, format) {
        this.format = format;

        if (this.mediaEntity) {
            this.mediaEntity.destroy();
            this.mediaEntity = null;
        }

        const flat = format.projection === PROJECTION.FLAT;
        const mesh = createProjectionMesh(this.app.graphicsDevice, format, {
            aspect: this.video.aspectForFormat(format)
        });

        const meshInstance = new pc.MeshInstance(mesh, this.stereoMaterial.material);
        meshInstance.cull = false;

        const entity = new pc.Entity('media');
        entity.addComponent('render', { meshInstances: [meshInstance], castShadows: false });
        this.mediaRoot.addChild(entity);
        this.mediaEntity = entity;

        this.stereoMaterial.setStereoMode(format.stereo);
        this.environment.enabled = flat;

        this.mediaRoot.setLocalEulerAngles(0, 0, 0);
        this.mediaRoot.setLocalPosition(0, flat ? 1.6 : 0, 0);
    }

    /**
     * Rotate the media so its forward direction matches where the viewer is
     * currently looking. Every headset video player needs this - people do not
     * sit down facing the same way the tracking origin does.
     */
    recenter() {
        const forward = this.camera.forward;
        const yaw = Math.atan2(-forward.x, -forward.z) * pc.math.RAD_TO_DEG;
        this.mediaRoot.setLocalEulerAngles(0, yaw, 0);

        if (this.format?.projection === PROJECTION.FLAT) {
            // A cinema screen also has to move, not just turn, or it ends up
            // behind the viewer's shoulder.
            const pos = this.camera.getPosition();
            this.mediaRoot.setLocalPosition(pos.x, pos.y, pos.z);
        }
    }

    /** @param {boolean} value */
    setActive(value) {
        this.active = value;
        this._fadeTarget = value ? 1 : 0;
        this.mediaRoot.enabled = value;
        this.environment.enabled = value && this.format?.projection === PROJECTION.FLAT;
    }

    /** @param {number} dt */
    update(dt) {
        // Fade in/out rather than popping, which is jarring in a headset.
        const speed = 4;
        this._fade += (this._fadeTarget - this._fade) * Math.min(1, dt * speed);
        this.stereoMaterial.setFade(this._fade);

        this.stereoMaterial.update();
    }

    /** True if this title needs the 3D path at all. */
    static requiresRenderer(format) {
        return isImmersive(format);
    }
}
