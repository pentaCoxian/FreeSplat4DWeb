# FreeSplat4D WebXR Viewer

A WebXR-based viewer for FreeSplat4D 4D Gaussian Splatting checkpoints. Renders animated Gaussian splats in the browser with full VR headset support using [SparkJS](https://github.com/nicedude/spark) on Three.js.

## Quick Start

### 1. Export a Checkpoint

Convert a FreeSplat4D training checkpoint into viewer-compatible files:

```bash
# Activate the project venv
source .venv/bin/activate

# Export with defaults (500K splats, SH degree 0)
python scripts/export_webxr.py results/ckpts/ckpt_9999.pt webxr/public/data/

# Export with custom settings
python scripts/export_webxr.py results/ckpts/ckpt_9999.pt webxr/public/data/ \
  --max_splats 300000 \
  --sh_bands 1 \
  --opacity_threshold 0.02
```

This produces two files in the output directory:
- `scene.spz` — SPZ compressed Gaussian splat file (positions at t=0.5, ~10x smaller than PLY)
- `scene.4d.bin` — Temporal sidecar (per-splat times, durations, velocities)

#### Export Options

| Flag | Default | Description |
|------|---------|-------------|
| `--max_splats` | 500000 | Keep top-N splats by opacity |
| `--sh_bands` | 0 | SH degree to export (0=DC only, 1-3 for view-dependent color) |
| `--opacity_threshold` | 0.01 | Cull splats below this opacity |
| `--temporal_threshold` | 0.001 | Cull splats with duration below this |

### 2. Install Dependencies

```bash
cd webxr
npm install
```

### 3. Run the Viewer

**Development (with hot reload):**

```bash
npm run dev
```

**Production build:**

```bash
npm run build
npm run preview
```

**Python server (for VR headsets on local network):**

```bash
# HTTP on port 8080
npm run serve

# Or with custom options
python serve.py --port 3000
python serve.py --https  # Requires cert.pem + key.pem in webxr/
```

Open `http://localhost:8080` in a browser (or the local IP for VR headsets).

### 4. Load Custom Data

Pass file paths via URL parameters:

```
https://192.168.100.58:8080/?url=data/scene.spz&temporal=data/scene.4d.bin
```

Or symlink an external data directory:

```bash
python serve.py --data /path/to/exported/files/
```

## Architecture

```
webxr/
├── index.html          # Entry point with loading overlay and HUD
├── js/
│   ├── main.js         # Three.js + SparkJS setup, loading pipeline
│   ├── temporal.js     # 4D animation (GPU Dyno modifier + CPU fallback)
│   ├── loader.js       # Temporal .4d.bin parser and GPU texture upload
│   ├── controls.js     # VR controller input (locomotion, time scrub)
│   └── ui.js           # 2D HUD (time slider, FPS, splat count)
├── css/style.css       # Dark theme styling
├── serve.py            # Python HTTP server with WebXR CORS headers
├── vite.config.js      # Vite bundler config
└── public/             # Static assets served by Vite
    └── data/           # Exported scene files (gitignored)
        ├── scene.spz
        └── scene.4d.bin
```

## How It Works

### Rendering Pipeline

1. **Export** converts the `.pt` checkpoint to SPZ compressed splat file + temporal sidecar, applying a COLMAP-to-OpenGL coordinate transform (180 deg rotation around X)
2. **SparkJS** loads the SPZ and renders Gaussian splats with GPU-accelerated sorting
3. **Dyno objectModifier** runs a custom shader graph per-splat each frame:
   - Samples temporal parameters (time, duration, velocity) from DataTextures
   - Computes animated position: `pos(t) = center + velocity * (t - 0.5)`
   - Computes temporal opacity: `exp(-0.5 * ((t - time_i) / duration_i)^2)`
4. A **CPU fallback** path exists for compatibility, directly modifying the packed splat array

### Temporal Data Format (`.4d.bin`)

Binary file with 16-byte header + contiguous float32 arrays:

| Offset | Type | Description |
|--------|------|-------------|
| 0 | uint32 | Splat count (N) |
| 4 | uint32 | Flags (bit 0: has acceleration, bit 1: has angular velocity) |
| 8 | float32 | Time range min |
| 12 | float32 | Time range max |
| 16 | float32[N] | Per-splat canonical times |
| 16+4N | float32[N] | Per-splat durations |
| 16+8N | float32[N*3] | Per-splat velocities (xyz interleaved) |
| (optional) | float32[N*3] | Accelerations (if flag bit 0) |
| (optional) | float32[N*3] | Angular velocities (if flag bit 1) |

## Controls

### Desktop
- **Left-click drag** — Orbit camera
- **Scroll** — Zoom
- **Time slider** — Scrub through time
- **Play button** — Toggle playback

### VR
- **Right thumbstick Y** — Move forward/backward
- **Right thumbstick X** — Snap turn (30 deg increments)
- **Right trigger** — Play/pause
- **Left grip + thumbstick X** — Scrub time
- **Left grip + thumbstick Y** — Adjust playback speed

## Dependencies

- [Three.js](https://threejs.org/) ^0.170.0 — 3D rendering
- [@sparkjsdev/spark](https://www.npmjs.com/package/@sparkjsdev/spark) ^0.1.10 — Gaussian splat renderer with Dyno shader graph
- [Vite](https://vitejs.dev/) ^6.0.0 — Build tool
