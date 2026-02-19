import * as THREE from 'three';
import { SparkRenderer, SplatMesh, VRButton } from '@sparkjsdev/spark';
import { loadTemporalData, createTemporalTextures } from './loader.js';
import { buildDynoModifier, createCPUFallback, TemporalController } from './temporal.js';
import { VRControls, FPVControls } from './controls.js';
import { UI } from './ui.js';

// Base URL for Cloudflare R2 bucket (no trailing slash)
const R2_BASE_URL = 'https://r2.pentacoxian.dev/public';

let renderer, scene, camera, cameraRig, controls, sparkRenderer;
let splatMesh, temporalCtrl, vrControls, ui;
let clock;

// Scene list discovered from data folders
let scenes = [];

async function discoverScenes() {
    // 1. Try R2 manifest first
    try {
        const resp = await fetch(`${R2_BASE_URL}/scenes.json`);
        if (resp.ok) {
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const manifest = await resp.json();
                // Resolve relative paths in the manifest against the R2 base URL
                return manifest.map(entry => {
                    const splatUrl = entry.url || entry.ply;
                    const resolvedSplat = splatUrl.startsWith('http') ? splatUrl : `${R2_BASE_URL}/${splatUrl}`;
                    return {
                        name: entry.name,
                        ply: resolvedSplat,
                        temporal: entry.temporal
                            ? (entry.temporal.startsWith('http') ? entry.temporal : `${R2_BASE_URL}/${entry.temporal}`)
                            : resolvedSplat.replace(/\.(spz|ply)$/, '.4d.bin'),
                    };
                });
            }
        }
    } catch (_) { /* no R2 manifest, fall through */ }

    // 2. Try local manifest
    try {
        const resp = await fetch('scenes.json');
        if (resp.ok) {
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                return await resp.json();
            }
        }
    } catch (_) { /* no local manifest, probe R2 instead */ }

    // 3. Probe R2 data folders: data, data2, data3, ... until first miss
    const found = [];
    const isSpz = async (url) => {
        try {
            const resp = await fetch(url, { headers: { Range: 'bytes=0-1' } });
            if (!resp.ok && resp.status !== 206) return false;
            const buf = await resp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            // SPZ files are gzip-compressed: magic bytes 0x1f 0x8b
            return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
        } catch (_) { return false; }
    };

    for (let i = 1; ; i++) {
        const folder = i === 1 ? 'data' : `data${i}`;
        if (!await isSpz(`${R2_BASE_URL}/${folder}/scene.spz`)) break;
        found.push({
            name: folder,
            ply: `${R2_BASE_URL}/${folder}/scene.spz`,
            temporal: `${R2_BASE_URL}/${folder}/scene.4d.bin`,
        });
    }

    return found;
}

async function init() {
    ui = new UI();
    clock = new THREE.Clock();

    // Three.js setup
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000);
    document.body.appendChild(renderer.domElement);

    // Enable XR and show VR button (gracefully skip if unsupported)
    try {
        renderer.xr.enabled = true;
        const vrButton = VRButton.createButton(renderer);
        if (vrButton) {
            document.getElementById('vr-container').appendChild(vrButton);
        }
    } catch (e) {
        console.warn('WebXR not available:', e.message);
    }

    scene = new THREE.Scene();

    // Camera lives in scene for desktop orbit controls
    camera = new THREE.PerspectiveCamera(
        70,
        window.innerWidth / window.innerHeight,
        0.01,
        1000
    );
    camera.position.set(0, 1.6, 3);
    scene.add(camera);

    // Camera rig for VR locomotion (camera is re-parented here during VR)
    cameraRig = new THREE.Group();
    cameraRig.position.set(0, 0, 3);
    scene.add(cameraRig);

    // FPV controls for desktop + mobile (WASD, mouse look, gamepad, virtual joysticks)
    controls = new FPVControls(camera, renderer.domElement);

    // Re-parent camera between scene (desktop) and rig (VR)
    if (renderer.xr.enabled) {
        renderer.xr.addEventListener('sessionstart', () => {
            camera.position.set(0, 1.6, 0);
            cameraRig.add(camera);
            controls.enabled = false;
        });
        renderer.xr.addEventListener('sessionend', () => {
            scene.add(camera);
            camera.position.set(0, 1.6, 3);
            controls.enabled = true;
        });
    }

    // SparkJS renderer
    sparkRenderer = new SparkRenderer({ renderer });
    scene.add(sparkRenderer);

    // Discover available scenes
    scenes = await discoverScenes();

    // URL params can override scene selection
    const params = new URLSearchParams(window.location.search);
    const splatParam = params.get('url') || params.get('ply');
    if (splatParam) {
        scenes = [{ name: 'custom', ply: splatParam, temporal: params.get('temporal') || splatParam.replace(/\.(spz|ply)$/, '.4d.bin') }];
    }

    if (scenes.length === 0) {
        scenes = [{ name: 'data', ply: `${R2_BASE_URL}/data/scene.spz`, temporal: `${R2_BASE_URL}/data/scene.4d.bin` }];
    }

    // Set up carousel
    ui.setScenes(scenes);
    ui.onSceneChange = async (index) => {
        await switchScene(scenes[index]);
    };

    // Load first scene
    try {
        await loadScene(scenes[0].ply, scenes[0].temporal);
    } catch (e) {
        console.error('Failed to load scene:', e);
        ui.hideLoading();
    }

    // Resize handler
    window.addEventListener('resize', onResize);

    // Start render loop
    renderer.setAnimationLoop(render);
}

async function switchScene(sceneEntry) {
    ui.setSceneSwitching(true);
    ui.showLoading('Switching scene...');

    // Remove current splat mesh
    if (splatMesh) {
        sparkRenderer.remove(splatMesh);
        splatMesh.dispose();
        splatMesh = null;
    }
    temporalCtrl = null;

    try {
        await loadScene(sceneEntry.ply, sceneEntry.temporal);
    } catch (e) {
        console.error('Failed to switch scene:', e);
        ui.showLoading(`Error: ${e.message}`);
    }

    ui.setSceneSwitching(false);
}

async function loadScene(plyFile, temporalFile) {
    // Step 1: Load temporal data first (needed to build Dyno modifier before SplatMesh)
    let temporalData = null;
    let textures = null;
    let dynoResult = null;  // { modifier, handle }

    ui.showLoading('Loading temporal data...');
    try {
        temporalData = await loadTemporalData(temporalFile, (received, total) => {
            if (total > 0) {
                const pct = Math.round(received / total * 100);
                ui.showLoading(`Loading temporal data... ${pct}%`);
            }
        });
    } catch (e) {
        console.warn('No temporal data found, running in static mode:', e.message);
    }

    // Step 2: Build Dyno modifier (must happen BEFORE SplatMesh creation
    // so the modifier is compiled into the shader from the start)
    if (temporalData) {
        ui.showLoading('Setting up 4D animation...');
        textures = createTemporalTextures(temporalData);
        try {
            dynoResult = buildDynoModifier(textures, temporalData);
        } catch (e) {
            console.warn('Dyno modifier creation failed, will use CPU fallback:', e.message);
        }
    }

    // Step 3: Create SplatMesh with objectModifier passed in constructor
    ui.showLoading('Loading Gaussian splats...');
    const splatOpts = { url: plyFile };
    if (dynoResult) {
        splatOpts.objectModifier = dynoResult.modifier;
    }
    splatMesh = new SplatMesh(splatOpts);
    sparkRenderer.add(splatMesh);

    try {
        await splatMesh.initialized;
    } catch (e) {
        console.warn('SplatMesh initialization error:', e.message);
    }

    const splatCount = splatMesh.packedSplats?.numSplats ?? 0;
    ui.setSplatCount(splatCount);

    // Validate splat counts match between SPZ and temporal data
    if (temporalData && splatCount > 0 && temporalData.splatCount !== splatCount) {
        console.warn(`Splat count mismatch! SPZ: ${splatCount}, temporal: ${temporalData.splatCount}`);
    }

    // Step 4: Bind the Dyno handle to the mesh so uniform updates invalidate
    // SparkJS's generation cache (triggers re-run of modifier each frame)
    if (dynoResult) {
        dynoResult.handle.bindMesh(splatMesh);
    }

    // Step 5: Set up temporal controller
    if (temporalData) {
        let timeHandle = dynoResult ? dynoResult.handle : null;

        // CPU fallback if Dyno modifier failed
        if (!timeHandle) {
            try {
                timeHandle = createCPUFallback(splatMesh, temporalData);
            } catch (e) {
                console.warn('CPU fallback also failed:', e.message);
            }
        }

        if (timeHandle) {
            temporalCtrl = new TemporalController(temporalData, timeHandle);
            temporalCtrl.setNormalizedTime(0.5);

            ui.onTimeChange = (t) => {
                temporalCtrl.setNormalizedTime(t);
                temporalCtrl.pause();
            };
            ui.onPlayPause = () => temporalCtrl.togglePlayPause();
            ui.onSpeedChange = (speed) => { temporalCtrl.speed = speed; };
        }
    }

    // VR controls (uses cameraRig for locomotion)
    vrControls = new VRControls(renderer, camera, temporalCtrl, cameraRig);

    ui.hideLoading();
}

function render(timestamp, frame) {
    const dt = clock.getDelta();

    // Update FPV controls (disabled during VR)
    if (!renderer.xr?.isPresenting) {
        controls.update(dt);
    }

    // Update VR controls
    if (vrControls) {
        vrControls.update(timestamp, frame);
    }

    // Update temporal animation
    if (temporalCtrl) {
        temporalCtrl.update(dt);
        ui.updateTime(temporalCtrl.normalizedTime, temporalCtrl.isPlaying);
    }

    // FPS tracking
    ui.updateFPS();

    // Render
    renderer.render(scene, camera);
}

function onResize() {
    if (renderer.xr?.isPresenting) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

init().catch(err => {
    console.error('Failed to initialize viewer:', err);
    document.getElementById('loading-status').textContent = `Error: ${err.message}`;
});
