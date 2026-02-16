import * as THREE from 'three';

/**
 * Parsed temporal data from .4d.bin sidecar file.
 */
export class TemporalData {
    constructor() {
        this.splatCount = 0;
        this.flags = 0;
        this.timeMin = 0;
        this.timeMax = 1;
        this.hasAcceleration = false;
        this.hasAngularVelocity = false;

        /** @type {Float32Array} [N] canonical times */
        this.times = null;
        /** @type {Float32Array} [N] activated durations */
        this.durations = null;
        /** @type {Float32Array} [N*3] velocity xyz */
        this.velocities = null;
        /** @type {Float32Array|null} [N*3] acceleration xyz */
        this.accelerations = null;
        /** @type {Float32Array|null} [N*3] angular velocity xyz */
        this.angularVelocities = null;
    }
}

/**
 * Load and parse temporal sidecar binary.
 *
 * Format:
 *   Header (16 bytes): N(u32), flags(u32), time_min(f32), time_max(f32)
 *   Data: times[N], durations[N], velocities[N*3], [accel[N*3]], [angvel[N*3]]
 *
 * @param {string} url
 * @param {function} onProgress - callback(received, total)
 * @returns {Promise<TemporalData>}
 */
export async function loadTemporalData(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load temporal data: ${response.status} ${response.statusText}`);
    }

    const totalBytes = parseInt(response.headers.get('content-length') || '0');
    const reader = response.body.getReader();

    const chunks = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress) onProgress(received, totalBytes);
    }

    // Concatenate chunks into single ArrayBuffer
    const buffer = new ArrayBuffer(received);
    const uint8 = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of chunks) {
        uint8.set(chunk, offset);
        offset += chunk.length;
    }

    return parseTemporalBinary(buffer);
}

/**
 * Parse the temporal binary buffer.
 * @param {ArrayBuffer} buffer
 * @returns {TemporalData}
 */
function parseTemporalBinary(buffer) {
    const data = new TemporalData();
    const view = new DataView(buffer);

    // Header (16 bytes)
    data.splatCount = view.getUint32(0, true);
    data.flags = view.getUint32(4, true);
    data.timeMin = view.getFloat32(8, true);
    data.timeMax = view.getFloat32(12, true);
    data.hasAcceleration = !!(data.flags & 1);
    data.hasAngularVelocity = !!(data.flags & 2);

    const N = data.splatCount;
    let ptr = 16;

    // Zero-copy Float32Array views
    data.times = new Float32Array(buffer, ptr, N);
    ptr += N * 4;

    data.durations = new Float32Array(buffer, ptr, N);
    ptr += N * 4;

    data.velocities = new Float32Array(buffer, ptr, N * 3);
    ptr += N * 3 * 4;

    if (data.hasAcceleration) {
        data.accelerations = new Float32Array(buffer, ptr, N * 3);
        ptr += N * 3 * 4;
    }

    if (data.hasAngularVelocity) {
        data.angularVelocities = new Float32Array(buffer, ptr, N * 3);
        ptr += N * 3 * 4;
    }

    console.log(`Temporal data loaded: ${N.toLocaleString()} splats, ` +
                `t=[${data.timeMin.toFixed(3)}, ${data.timeMax.toFixed(3)}], ` +
                `accel=${data.hasAcceleration}, angvel=${data.hasAngularVelocity}`);

    return data;
}

/**
 * Create Three.js DataTextures from temporal data for GPU upload.
 *
 * Packs data into 2D float textures addressable by splat index.
 * Texture coordinate: x = index % width, y = floor(index / width)
 *
 * @param {TemporalData} data
 * @returns {object} { timesTex, durationsTex, velocitiesTex, accelTex?, angvelTex?, texWidth, texHeight }
 */
export function createTemporalTextures(data) {
    const N = data.splatCount;
    const texWidth = Math.ceil(Math.sqrt(N));
    const texHeight = Math.ceil(N / texWidth);
    const texSize = texWidth * texHeight;

    // Create a single-channel (R32F) DataTexture
    function makeR32Texture(srcArray) {
        const padded = new Float32Array(texSize);
        padded.set(srcArray.subarray(0, Math.min(srcArray.length, padded.length)));
        const tex = new THREE.DataTexture(
            padded, texWidth, texHeight, THREE.RedFormat, THREE.FloatType
        );
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.needsUpdate = true;
        return tex;
    }

    // Create a 4-channel (RGBA32F) DataTexture from 3-channel interleaved data.
    // RGB format is not valid for float textures in WebGL2, so pad to RGBA.
    function makeRGBA32Texture(srcArray3) {
        const padded = new Float32Array(texSize * 4);
        const count = Math.min(N, srcArray3.length / 3);
        for (let i = 0; i < count; i++) {
            padded[i * 4] = srcArray3[i * 3];
            padded[i * 4 + 1] = srcArray3[i * 3 + 1];
            padded[i * 4 + 2] = srcArray3[i * 3 + 2];
            // w = 0 (padding)
        }
        const tex = new THREE.DataTexture(
            padded, texWidth, texHeight, THREE.RGBAFormat, THREE.FloatType
        );
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.needsUpdate = true;
        return tex;
    }

    const result = {
        texWidth,
        texHeight,
        timesTex: makeR32Texture(data.times),
        durationsTex: makeR32Texture(data.durations),
        velocitiesTex: makeRGBA32Texture(data.velocities),
    };

    if (data.hasAcceleration && data.accelerations) {
        result.accelTex = makeRGBA32Texture(data.accelerations);
    }

    if (data.hasAngularVelocity && data.angularVelocities) {
        result.angvelTex = makeRGBA32Texture(data.angularVelocities);
    }

    return result;
}
