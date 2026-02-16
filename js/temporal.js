/**
 * 4D Temporal Animation for SparkJS SplatMesh.
 *
 * Two strategies:
 * 1. GPU-side: SparkJS Dyno objectModifier with custom data textures
 * 2. CPU-side fallback: onFrame callback updating PackedSplats positions
 *
 * The CPU fallback is used if the Dyno modifier approach fails (e.g., if
 * the modifier doesn't expose splat indices for texture lookups).
 */

import { toHalf, dyno } from '@sparkjsdev/spark';

const MIN_DURATION = 0.02;

/**
 * Build a GPU-side Dyno objectModifier for 4D temporal animation.
 *
 * IMPORTANT: The returned `modifier` must be passed to the SplatMesh constructor
 * via the `objectModifier` option so it's compiled into the shader before the
 * first render. Setting it after initialization has no effect.
 *
 * After the SplatMesh is created, call `handle.bindMesh(splatMesh)` so that
 * uniform updates trigger SparkJS to re-generate splats each frame.
 *
 * @param {object} textures - from createTemporalTextures()
 * @param {TemporalData} temporalData
 * @returns {{ modifier: GsplatModifier, handle: { setTime(t: number): void, bindMesh(mesh: SplatMesh): void, currentTime: number } }}
 */
export function buildDynoModifier(textures, temporalData) {
    return createDynoModifier(textures, temporalData);
}

/**
 * GPU-side Dyno objectModifier for 4D temporal animation.
 *
 * Uses SparkJS's Dyno shader graph to modify splat positions and opacity
 * entirely on the GPU. Each splat's temporal parameters (time, duration,
 * velocity) are stored in DataTextures and sampled per-splat using the
 * splat index from splitGsplat().
 *
 * Motion model (per splat):
 *   pos(t) = center + velocity * (t - 0.5)
 *   temporal_opacity = exp(-0.5 * ((t - time_i) / duration_i)^2)
 */
function createDynoModifier(textures, temporalData) {
    const {
        dynoBlock, splitGsplat, combineGsplat, Gsplat,
        dynoFloat, dynoSampler2D, dynoConst,
        texelFetch, add, sub, mul, div, exp, max,
        split, combine, vec3,
    } = dyno;

    // Updateable uniform for current playback time
    const uCurrentTime = dynoFloat(0.5);

    // Texture width constant for index → texcoord conversion
    const uTexWidth = dynoConst('int', textures.texWidth);

    // Texture sampler uniforms
    const uTimesTex = dynoSampler2D(textures.timesTex);
    const uDurationsTex = dynoSampler2D(textures.durationsTex);
    const uVelocitiesTex = dynoSampler2D(textures.velocitiesTex);
    const uAccelTex = textures.accelTex ? dynoSampler2D(textures.accelTex) : null;

    // Shader constants
    const ZERO_LOD = dynoConst('int', 0);
    const REF_TIME = dynoConst('float', 0.5);
    const MIN_DUR = dynoConst('float', MIN_DURATION);
    const NEG_HALF = dynoConst('float', -0.5);
    const HALF_CONST = dynoConst('float', 0.5);

    // Build the Dyno modifier graph
    const modifier = dynoBlock(
        { gsplat: Gsplat },
        { gsplat: Gsplat },
        ({ gsplat }) => {
            if (!gsplat) throw new Error('No gsplat input');

            // Extract per-splat components (index is the original PLY order)
            const { index, center, opacity } = splitGsplat(gsplat).outputs;

            // Convert splat index → 2D texture coordinate
            // coord = ivec2(index % texWidth, index / texWidth)
            const row = div(index, uTexWidth);
            const col = sub(index, mul(row, uTexWidth));
            const coord = combine({ vectorType: 'ivec2', x: col, y: row });

            // Fetch temporal parameters from DataTextures
            const splatTime = split(texelFetch(uTimesTex, coord, ZERO_LOD)).outputs.x;
            const rawDuration = split(texelFetch(uDurationsTex, coord, ZERO_LOD)).outputs.x;
            const duration = max(rawDuration, MIN_DUR);
            const velocity = vec3(texelFetch(uVelocitiesTex, coord, ZERO_LOD));

            // Temporal opacity: exp(-0.5 * (dt / duration)^2)
            const dt = sub(uCurrentTime, splatTime);
            const ratio = div(dt, duration);
            const temporalOpacity = exp(mul(NEG_HALF, mul(ratio, ratio)));
            const newOpacity = mul(opacity, temporalOpacity);

            // Position animation: center + velocity * (currentTime - 0.5)
            const dtFromRef = sub(uCurrentTime, REF_TIME);
            const displacement = mul(velocity, dtFromRef);
            let newCenter = add(center, displacement);

            // Add acceleration contribution if available
            if (uAccelTex) {
                const accel = vec3(texelFetch(uAccelTex, coord, ZERO_LOD));
                const halfDtSq = mul(HALF_CONST, mul(dtFromRef, dtFromRef));
                newCenter = add(newCenter, mul(accel, halfDtSq));
            }

            return {
                gsplat: combineGsplat({ gsplat, center: newCenter, opacity: newOpacity }),
            };
        },
    );

    console.log(`Dyno temporal modifier created (texSize=${textures.texWidth}x${textures.texHeight}, ` +
                `accel=${!!uAccelTex})`);

    // Reference to the SplatMesh, set via bindMesh() after construction.
    // SparkJS caches generated splats and only re-runs the modifier when
    // the mesh version changes, so we must bump it on every time update.
    let boundMesh = null;

    return {
        modifier,
        handle: {
            bindMesh(mesh) {
                boundMesh = mesh;
            },
            setTime(t) {
                uCurrentTime.value = t;
                if (boundMesh) {
                    boundMesh.needsUpdate = true;
                }
            },
            get currentTime() {
                return uCurrentTime.value;
            },
        },
    };
}

/**
 * CPU-side fallback: update PackedSplats positions each frame via onFrame.
 *
 * Directly manipulates the packed Uint32Array for center (float16) and
 * opacity (uint8) to avoid THREE.js object overhead and unnecessary
 * re-encoding of unchanged scale/quaternion/color data.
 */
export function createCPUFallback(splatMesh, temporalData) {
    const N = temporalData.splatCount;
    const times = temporalData.times;
    const durations = temporalData.durations;
    const velocities = temporalData.velocities;
    const accelerations = temporalData.accelerations;
    const hasAccel = temporalData.hasAcceleration;

    // Store original positions and opacities (read from PackedSplats after loading)
    let originalPositions = null;
    let originalOpacityBytes = null;
    let currentTime = 0.5;
    let needsUpdate = false;

    // Capture original positions and opacities once loaded
    function captureOriginals() {
        if (originalPositions) return;

        const ps = splatMesh.packedSplats;
        if (!ps || ps.numSplats === 0) return;

        const actualN = Math.min(N, ps.numSplats);
        originalPositions = new Float32Array(actualN * 3);
        originalOpacityBytes = new Uint8Array(actualN);

        // Read positions from forEachSplat (objects are reused, read values immediately)
        splatMesh.forEachSplat((index, center, _scales, _quat, opacity, _color) => {
            if (index < actualN) {
                originalPositions[index * 3] = center.x;
                originalPositions[index * 3 + 1] = center.y;
                originalPositions[index * 3 + 2] = center.z;
                // Store opacity as byte (0-255) for direct packed array writing
                originalOpacityBytes[index] = Math.max(0, Math.min(255, Math.round(opacity * 255)));
            }
        });

        console.log(`Captured ${actualN} original positions for CPU animation`);
    }

    // Update positions and opacity by directly manipulating the packed Uint32Array.
    // PackedSplats format (4 uint32 per splat):
    //   word 0: [R:8][G:8][B:8][opacity:8]  (opacity in bits 24-31)
    //   word 1: [half(cx):16][half(cy):16]
    //   word 2: [half(cz):16][packed_data:16]  (upper 16 bits: quat octahedral)
    //   word 3: [scale_x:8][scale_y:8][scale_z:8][quat_sign:8]
    function updatePositions() {
        if (!originalPositions) return;

        const arr = splatMesh.packedSplats.packedArray;
        if (!arr) return;

        const actualN = Math.min(N, originalPositions.length / 3);

        for (let i = 0; i < actualN; i++) {
            const dt = currentTime - times[i];
            const dur = Math.max(durations[i], MIN_DURATION);
            const ratio = dt / dur;
            const temporalOpacity = Math.exp(-0.5 * ratio * ratio);

            // Animated position: original (at t=0.5) + velocity * dt_from_ref
            const dt_from_ref = currentTime - 0.5;
            let cx = originalPositions[i * 3] + velocities[i * 3] * dt_from_ref;
            let cy = originalPositions[i * 3 + 1] + velocities[i * 3 + 1] * dt_from_ref;
            let cz = originalPositions[i * 3 + 2] + velocities[i * 3 + 2] * dt_from_ref;

            if (hasAccel) {
                const dt2 = dt_from_ref * dt_from_ref;
                cx += 0.5 * accelerations[i * 3] * dt2;
                cy += 0.5 * accelerations[i * 3 + 1] * dt2;
                cz += 0.5 * accelerations[i * 3 + 2] * dt2;
            }

            // Write center as float16 into packed array
            const base = i * 4;
            arr[base + 1] = toHalf(cx) | (toHalf(cy) << 16);
            arr[base + 2] = (arr[base + 2] & 0xFFFF0000) | toHalf(cz);

            // Write opacity byte (bits 24-31 of word 0, preserving RGB in bits 0-23)
            const opByte = Math.max(0, Math.min(255,
                Math.round(originalOpacityBytes[i] * temporalOpacity)));
            arr[base] = (arr[base] & 0x00FFFFFF) | (opByte << 24);
        }

        splatMesh.packedSplats.needsUpdate = true;
    }

    // Register onFrame callback
    splatMesh.onFrame = ({ mesh, time, deltaTime }) => {
        captureOriginals();
        if (needsUpdate) {
            updatePositions();
            needsUpdate = false;
        }
    };

    return {
        setTime(t) {
            if (t !== currentTime) {
                currentTime = t;
                needsUpdate = true;
            }
        },
        get currentTime() {
            return currentTime;
        }
    };
}

/**
 * Temporal playback controller.
 *
 * Manages play/pause, speed, looping, and normalized time mapping.
 * Design mirrors Unity TimeController pattern.
 */
export class TemporalController {
    /**
     * @param {TemporalData} data
     * @param {object} modifier - from createTemporalModifier()
     */
    constructor(data, modifier) {
        this.data = data;
        this.modifier = modifier;
        this.isPlaying = false;
        this.loop = true;
        this.speed = 0.3;
        this.normalizedTime = 0.5; // [0, 1]

        // Use [0, 1] as the playback range (the training time range).
        // data.timeMin/timeMax are extreme outlier splat birth times that
        // extend well beyond the useful range and would waste the slider.
        this.playbackMin = 0.0;
        this.playbackMax = 1.0;
    }

    /** Set normalized time [0, 1] and update modifier. */
    setNormalizedTime(t) {
        this.normalizedTime = Math.max(0, Math.min(1, t));
        const actualTime = this.playbackMin +
            this.normalizedTime * (this.playbackMax - this.playbackMin);
        this.modifier.setTime(actualTime);
    }

    /** Advance time by dt seconds. */
    update(dt) {
        if (!this.isPlaying) return;

        const timeRange = this.playbackMax - this.playbackMin;
        const advance = dt * this.speed / Math.max(timeRange, 0.001);
        this.normalizedTime += advance;

        if (this.normalizedTime > 1.0) {
            if (this.loop) {
                this.normalizedTime -= 1.0;
            } else {
                this.normalizedTime = 1.0;
                this.isPlaying = false;
            }
        } else if (this.normalizedTime < 0.0) {
            if (this.loop) {
                this.normalizedTime += 1.0;
            } else {
                this.normalizedTime = 0.0;
                this.isPlaying = false;
            }
        }

        const actualTime = this.playbackMin +
            this.normalizedTime * (this.playbackMax - this.playbackMin);
        this.modifier.setTime(actualTime);
    }

    play() { this.isPlaying = true; }
    pause() { this.isPlaying = false; }
    togglePlayPause() { this.isPlaying = !this.isPlaying; }
}
