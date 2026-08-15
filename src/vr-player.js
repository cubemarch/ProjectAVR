import * as pc from 'https://cdn.jsdelivr.net/npm/playcanvas@2.21.4/build/playcanvas/src/index.js';
import { LAYOUTS } from './media-utils.js';

const VERTEX_SHADER = /* glsl */`
  attribute vec3 aPosition;
  uniform mat4 matrix_model;
  uniform mat4 matrix_viewProjection;
  varying vec3 vDirection;

  void main(void) {
    vDirection = aPosition;
    gl_Position = matrix_viewProjection * matrix_model * vec4(aPosition, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */`
  precision highp float;

  varying vec3 vDirection;
  uniform sampler2D uVideoTexture;
  uniform float uProjection;
  uniform float uStereoLayout;
  uniform float uEyeOrder;
  uniform float uUseXrEye;
  uniform float uPreviewEye;
  uniform uint view_index;

  const float PI = 3.141592653589793;

  void main(void) {
    vec3 direction = normalize(vDirection);
    float longitude = atan(direction.x, -direction.z);
    float latitude = asin(clamp(direction.y, -1.0, 1.0));
    vec2 uv;

    if (uProjection > 0.5) {
      if (abs(longitude) > PI * 0.5) {
        gl_FragColor = vec4(0.004, 0.004, 0.006, 1.0);
        return;
      }
      uv.x = longitude / PI + 0.5;
    } else {
      uv.x = longitude / (2.0 * PI) + 0.5;
    }
    uv.y = 0.5 - latitude / PI;

    float xrEye = mod(float(view_index) + uEyeOrder, 2.0);
    float previewEye = mod(uPreviewEye + uEyeOrder, 2.0);
    float eye = mix(previewEye, xrEye, uUseXrEye);

    if (uStereoLayout > 0.5 && uStereoLayout < 1.5) {
      uv.x = uv.x * 0.5 + eye * 0.5;
    } else if (uStereoLayout >= 1.5) {
      uv.y = uv.y * 0.5 + eye * 0.5;
    }

    gl_FragColor = texture2D(uVideoTexture, uv);
  }
`;

export class ImmersiveVideoRenderer {
  constructor(canvas, video, callbacks = {}) {
    this.canvas = canvas;
    this.video = video;
    this.onStatus = callbacks.onStatus || (() => {});
    this.onError = callbacks.onError || (() => {});
    this.app = null;
    this.camera = null;
    this.rig = null;
    this.sphere = null;
    this.material = null;
    this.texture = null;
    this.mediaActive = false;
    this.resizeObserver = null;
    this.yaw = 0;
    this.pitch = 0;
    this.pointer = null;
    this.textureErrorShown = false;
    this.onVideoEmptied = () => this.clearMedia();
    this.video.addEventListener('emptied', this.onVideoEmptied);
  }

  async initialize() {
    if (this.app) return;

    const mouse = new pc.Mouse(this.canvas);
    const touch = 'ontouchstart' in window ? new pc.TouchDevice(this.canvas) : undefined;
    this.app = new pc.Application(this.canvas, {
      mouse,
      touch,
      graphicsDeviceOptions: {
        alpha: false,
        antialias: true,
        xrCompatible: true,
        deviceTypes: [pc.DEVICETYPE_WEBGL2]
      }
    });
    this.app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.app.scene.ambientLight = new pc.Color(0, 0, 0);

    this.rig = new pc.Entity('Viewer rig');
    this.camera = new pc.Entity('Viewer camera');
    this.camera.addComponent('camera', {
      clearColor: new pc.Color(0.003, 0.003, 0.005),
      nearClip: 0.01,
      farClip: 100,
      fov: 72
    });
    this.rig.addChild(this.camera);
    this.app.root.addChild(this.rig);

    this.material = new pc.ShaderMaterial({
      uniqueName: 'ProjectAVR-EquirectangularVideo',
      attributes: { aPosition: pc.SEMANTIC_POSITION },
      vertexGLSL: VERTEX_SHADER,
      fragmentGLSL: FRAGMENT_SHADER
    });
    this.material.cull = pc.CULLFACE_FRONT;
    this.material.depthWrite = false;

    this.sphere = new pc.Entity('Video sphere');
    this.sphere.addComponent('render', { type: 'sphere' });
    this.sphere.render.material = this.material;
    this.sphere.setLocalScale(40, 40, 40);
    this.app.root.addChild(this.sphere);

    this.app.xr.on('start', () => {
      this.material.setParameter('uUseXrEye', 1);
      this.onStatus({ presenting: true, available: true });
    });
    this.app.xr.on('end', () => {
      this.material.setParameter('uUseXrEye', 0);
      this.onStatus({ presenting: false, available: this.isVrAvailable() });
    });
    this.app.xr.on('error', (error) => this.onError(error?.message || 'The WebXR session failed.'));
    this.app.xr.on(`available:${pc.XRTYPE_VR}`, (available) => {
      this.onStatus({ presenting: this.app.xr.active, available });
    });
    this.app.xr.input.on('add', (source) => {
      source.on('select', () => this.video.paused ? this.video.play().catch(() => {}) : this.video.pause());
      source.on('squeeze', () => this.resetView());
    });

    this.app.on('update', () => {
      if (!this.mediaActive || !this.texture || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      try {
        this.texture.upload();
      } catch (error) {
        if (!this.textureErrorShown) {
          this.textureErrorShown = true;
          this.onError('The media server blocked video-texture access. Enable CORS for immersive playback.');
        }
      }
    });

    this.installLookControls();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.app.start();
    this.resize();
  }

  async setMedia(item) {
    await this.initialize();
    this.clearMedia();
    this.textureErrorShown = false;
    this.texture = new pc.Texture(this.app.graphicsDevice, {
      name: `Video texture: ${item.title}`,
      format: pc.PIXELFORMAT_RGBA8,
      minFilter: pc.FILTER_LINEAR,
      magFilter: pc.FILTER_LINEAR,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE,
      addressV: pc.ADDRESS_CLAMP_TO_EDGE,
      mipmaps: false
    });
    this.texture.setSource(this.video);

    const layout = LAYOUTS[item.layout] || LAYOUTS.mono;
    this.material.setParameter('uVideoTexture', this.texture);
    this.material.setParameter('uProjection', item.projection === '180' ? 1 : 0);
    this.material.setParameter('uStereoLayout', layout.code);
    this.material.setParameter('uEyeOrder', layout.eyeOrder);
    this.material.setParameter('uUseXrEye', this.app.xr.active ? 1 : 0);
    this.material.setParameter('uPreviewEye', 0);
    this.material.update();
    this.mediaActive = true;
    this.sphere.enabled = true;
    this.app.autoRender = true;
    this.app.renderNextFrame = true;
    this.resetView();
    this.onStatus({ presenting: this.app.xr.active, available: this.isVrAvailable() });
  }

  isVrAvailable() {
    return Boolean(this.app?.xr?.supported && this.app.xr.isAvailable(pc.XRTYPE_VR));
  }

  async enterVr() {
    if (!this.app?.xr?.supported) throw new Error('WebXR is not available in this browser.');
    if (!this.app.xr.isAvailable(pc.XRTYPE_VR)) {
      throw new Error('No immersive VR session is available. Open this HTTPS page in a compatible headset browser.');
    }
    if (this.app.xr.active) return;

    // Start both gesture-gated operations before the first await so requestSession remains inside
    // the Enter VR click's transient user activation.
    const playbackResult = this.video.play().then(() => null, (error) => error);
    const sessionStart = new Promise((resolve, reject) => {
      this.app.xr.start(this.camera.camera, pc.XRTYPE_VR, pc.XRSPACE_LOCAL, {
        callback: (error) => error ? reject(error) : resolve()
      });
    });
    await sessionStart;

    const playbackError = await playbackResult;
    if (playbackError) {
      await this.exitVr().catch(() => {});
      throw playbackError;
    }
  }

  resetView() {
    this.yaw = 0;
    this.pitch = 0;
    this.rig?.setLocalEulerAngles(0, 0, 0);
  }

  installLookControls() {
    this.canvas.addEventListener('pointerdown', (event) => {
      this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.pointer || this.pointer.id !== event.pointerId || this.app.xr.active) return;
      const dx = event.clientX - this.pointer.x;
      const dy = event.clientY - this.pointer.y;
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;
      this.yaw -= dx * 0.14;
      this.pitch = Math.max(-85, Math.min(85, this.pitch - dy * 0.14));
      this.rig.setLocalEulerAngles(this.pitch, this.yaw, 0);
    });
    const clearPointer = (event) => {
      if (this.pointer?.id === event.pointerId) this.pointer = null;
    };
    this.canvas.addEventListener('pointerup', clearPointer);
    this.canvas.addEventListener('pointercancel', clearPointer);
    this.canvas.addEventListener('wheel', (event) => {
      if (this.app.xr.active) return;
      event.preventDefault();
      this.camera.camera.fov = Math.max(40, Math.min(100, this.camera.camera.fov + Math.sign(event.deltaY) * 4));
    }, { passive: false });
    this.canvas.addEventListener('keydown', (event) => {
      if (this.app.xr.active) return;
      const directions = {
        ArrowLeft: [0, 5],
        ArrowRight: [0, -5],
        ArrowUp: [5, 0],
        ArrowDown: [-5, 0]
      };
      if (directions[event.key]) {
        event.preventDefault();
        const [pitchDelta, yawDelta] = directions[event.key];
        this.pitch = Math.max(-85, Math.min(85, this.pitch + pitchDelta));
        this.yaw += yawDelta;
        this.rig.setLocalEulerAngles(this.pitch, this.yaw, 0);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        this.camera.camera.fov = Math.max(40, this.camera.camera.fov - 4);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        this.camera.camera.fov = Math.min(100, this.camera.camera.fov + 4);
      }
    });
  }

  resize() {
    if (!this.app || !this.canvas.clientWidth || !this.canvas.clientHeight) return;
    this.app.resizeCanvas(this.canvas.clientWidth, this.canvas.clientHeight);
  }

  clearMedia() {
    this.mediaActive = false;
    this.pointer = null;
    this.material?.deleteParameter('uVideoTexture');
    this.texture?.destroy();
    this.texture = null;
    if (this.sphere) this.sphere.enabled = false;
    if (this.app) this.app.autoRender = false;
  }

  async exitVr() {
    const xr = this.app?.xr;
    if (!xr?.active) return;

    await new Promise((resolve, reject) => {
      xr.end((error) => error ? reject(error) : resolve());
    });
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.video.removeEventListener('emptied', this.onVideoEmptied);
    this.clearMedia();
    this.material?.destroy();
    this.app?.destroy();
    this.app = null;
  }
}
