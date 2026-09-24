import * as pc from 'playcanvas';
import { PROJECTION } from '../catalog/media-format.js';

/**
 * Geometry for each supported video projection.
 *
 * All meshes are viewed from the inside and carry UVs for a *single* eye's
 * worth of image occupying the full 0..1 range. Splitting that range per eye is
 * the stereo material's job, which keeps one shader working for every shape
 * here.
 *
 * UV convention: textures are uploaded with `flipY = true`, so v = 1 is the top
 * of the video frame and v = 0 the bottom.
 */

const FORWARD_YAW = 0;

/**
 * Equirectangular dome or sphere.
 *
 * Direction for a given (yaw, pitch), with the viewer's right at +X and forward
 * at -Z:
 *
 *   x =  sin(yaw) * cos(pitch)
 *   y =  sin(pitch)
 *   z = -cos(yaw) * cos(pitch)
 *
 * so increasing u sweeps to the viewer's right and increasing v sweeps upward,
 * which is what every equirect encoder assumes.
 *
 * @param {pc.GraphicsDevice} device
 * @param {object} opts
 * @param {number} opts.yawSweep - Horizontal coverage in radians (PI = 180°).
 * @param {number} opts.pitchSweep - Vertical coverage in radians.
 * @param {number} [opts.radius]
 * @param {number} [opts.segmentsU]
 * @param {number} [opts.segmentsV]
 * @returns {pc.Mesh}
 */
export function createEquirectMesh(device, opts) {
    const {
        yawSweep,
        pitchSweep,
        radius = 100,
        segmentsU = 128,
        segmentsV = 64
    } = opts;

    const positions = [];
    const uvs = [];
    const indices = [];

    for (let iv = 0; iv <= segmentsV; iv++) {
        const v = iv / segmentsV;
        const pitch = (v - 0.5) * pitchSweep;
        const cosPitch = Math.cos(pitch);
        const sinPitch = Math.sin(pitch);

        for (let iu = 0; iu <= segmentsU; iu++) {
            const u = iu / segmentsU;
            const yaw = FORWARD_YAW + (u - 0.5) * yawSweep;

            positions.push(
                Math.sin(yaw) * cosPitch * radius,
                sinPitch * radius,
                -Math.cos(yaw) * cosPitch * radius
            );
            uvs.push(u, v);
        }
    }

    const stride = segmentsU + 1;
    for (let iv = 0; iv < segmentsV; iv++) {
        for (let iu = 0; iu < segmentsU; iu++) {
            const a = iv * stride + iu;
            const b = a + 1;
            const c = a + stride;
            const d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }

    return buildMesh(device, positions, uvs, indices);
}

/**
 * Circular fisheye dome (MKX200, RF52, generic 190°/220° lenses).
 *
 * The image is a circle inscribed in the frame: distance from the circle's
 * centre is proportional to the angle away from the lens axis. So a vertex at
 * polar angle theta and azimuth phi samples at
 *
 *   uv = 0.5 + (theta / thetaMax) * 0.5 * (cos(phi), sin(phi))
 *
 * Vertices beyond thetaMax are pinned to the rim, which lets us keep a closed
 * mesh without sampling outside the image circle.
 *
 * @param {pc.GraphicsDevice} device
 * @param {object} opts
 * @param {number} opts.fovDegrees - Total lens field of view, e.g. 200.
 * @param {number} [opts.radius]
 * @param {number} [opts.segmentsU] - Azimuth divisions.
 * @param {number} [opts.segmentsV] - Radial divisions.
 * @returns {pc.Mesh}
 */
export function createFisheyeMesh(device, opts) {
    const {
        fovDegrees = 180,
        radius = 100,
        segmentsU = 128,
        segmentsV = 64
    } = opts;

    const thetaMax = (fovDegrees * Math.PI) / 180 / 2;

    const positions = [];
    const uvs = [];
    const indices = [];

    for (let iv = 0; iv <= segmentsV; iv++) {
        // Radial fraction: 0 at the lens axis, 1 at the rim of the image circle.
        const r = iv / segmentsV;
        const theta = r * thetaMax;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);

        for (let iu = 0; iu <= segmentsU; iu++) {
            const phi = (iu / segmentsU) * Math.PI * 2;
            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);

            // Lens axis points forward (-Z). Offsets are +X right, +Y up.
            positions.push(
                sinTheta * cosPhi * radius,
                sinTheta * sinPhi * radius,
                -cosTheta * radius
            );

            uvs.push(0.5 + r * 0.5 * cosPhi, 0.5 + r * 0.5 * sinPhi);
        }
    }

    const stride = segmentsU + 1;
    for (let iv = 0; iv < segmentsV; iv++) {
        for (let iu = 0; iu < segmentsU; iu++) {
            const a = iv * stride + iu;
            const b = a + 1;
            const c = a + stride;
            const d = c + 1;
            indices.push(a, b, c, b, d, c);
        }
    }

    return buildMesh(device, positions, uvs, indices);
}

/**
 * Cinema screen for flat content: a gently curved section of a cylinder.
 *
 * A dead-flat plane is technically faithful to the source but reads as small
 * and stiff in a headset. A shallow wrap keeps the edges equidistant from the
 * viewer without visibly bending straight lines.
 *
 * @param {pc.GraphicsDevice} device
 * @param {object} opts
 * @param {number} opts.width - Screen width in metres.
 * @param {number} opts.height - Screen height in metres.
 * @param {number} [opts.distance] - Distance from viewer to screen centre.
 * @param {number} [opts.curvature] - 0 = flat, 1 = fully wrapped to `distance`.
 * @param {number} [opts.segments]
 * @returns {pc.Mesh}
 */
export function createScreenMesh(device, opts) {
    const {
        width,
        height,
        distance = 3.2,
        curvature = 0.35,
        segments = 48
    } = opts;

    const positions = [];
    const uvs = [];
    const indices = [];

    // Half-angle subtended by the screen when wrapped onto a cylinder of the
    // given radius. curvature = 0 collapses this to a plane.
    const radius = distance / Math.max(curvature, 1e-4);
    const halfAngle = width / 2 / radius;

    for (let iy = 0; iy <= 1; iy++) {
        const v = iy;
        const y = (v - 0.5) * height;

        for (let ix = 0; ix <= segments; ix++) {
            const u = ix / segments;
            const angle = (u - 0.5) * 2 * halfAngle;

            if (curvature <= 1e-4) {
                positions.push((u - 0.5) * width, y, -distance);
            } else {
                positions.push(
                    Math.sin(angle) * radius,
                    y,
                    -(Math.cos(angle) * radius - (radius - distance))
                );
            }
            uvs.push(u, v);
        }
    }

    const stride = segments + 1;
    for (let ix = 0; ix < segments; ix++) {
        const a = ix;
        const b = ix + 1;
        const c = stride + ix;
        const d = stride + ix + 1;
        indices.push(a, c, b, b, c, d);
    }

    return buildMesh(device, positions, uvs, indices);
}

function buildMesh(device, positions, uvs, indices) {
    const mesh = new pc.Mesh(device);
    mesh.setPositions(positions);
    mesh.setUvs(0, uvs);
    mesh.setIndices(indices);
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    return mesh;
}

/**
 * Pick and build the right mesh for a resolved format.
 *
 * @param {pc.GraphicsDevice} device
 * @param {object} format - Result of `resolveFormat`.
 * @param {object} [opts]
 * @param {number} [opts.aspect] - Source aspect ratio for a single eye, used
 *   only by the flat screen.
 * @param {number} [opts.screenWidth]
 * @param {number} [opts.curvature]
 * @returns {pc.Mesh}
 */
export function createProjectionMesh(device, format, opts = {}) {
    switch (format.projection) {
        case PROJECTION.SPHERE360:
            return createEquirectMesh(device, { yawSweep: Math.PI * 2, pitchSweep: Math.PI });

        case PROJECTION.DOME180:
            return createEquirectMesh(device, { yawSweep: Math.PI, pitchSweep: Math.PI });

        case PROJECTION.FISHEYE:
            return createFisheyeMesh(device, { fovDegrees: format.fisheyeFov || 180 });

        case PROJECTION.FLAT:
        default: {
            const aspect = opts.aspect || 16 / 9;
            const width = opts.screenWidth || 3.7;
            return createScreenMesh(device, {
                width,
                height: width / aspect,
                curvature: opts.curvature ?? 0.35
            });
        }
    }
}
