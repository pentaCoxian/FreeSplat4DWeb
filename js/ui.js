/**
 * 2D HUD overlay for desktop mode.
 * Manages loading screen, scene carousel, time slider, FPS counter, and splat count.
 */
export class UI {
    constructor() {
        this.overlay = document.getElementById('loading-overlay');
        this.progressFill = document.getElementById('progress-fill');
        this.loadingStatus = document.getElementById('loading-status');
        this.hud = document.getElementById('hud');
        this.playBtn = document.getElementById('play-btn');
        this.timeSlider = document.getElementById('time-slider');
        this.timeDisplay = document.getElementById('time-display');
        this.fpsDisplay = document.getElementById('fps-display');
        this.splatCountEl = document.getElementById('splat-count');
        this.speedSlider = document.getElementById('speed-slider');
        this.speedLabel = document.getElementById('speed-label');

        // Carousel elements
        this.prevBtn = document.getElementById('prev-scene');
        this.nextBtn = document.getElementById('next-scene');
        this.sceneLabel = document.getElementById('scene-label');

        /** @type {function|null} callback(normalizedTime: number) */
        this.onTimeChange = null;
        /** @type {function|null} callback() */
        this.onPlayPause = null;
        /** @type {function|null} callback(speed: number) */
        this.onSpeedChange = null;
        /** @type {function|null} callback(index: number) */
        this.onSceneChange = null;

        this._scenes = [];
        this._currentSceneIndex = 0;
        this._switching = false;

        // FPS tracking
        this._frameTimes = [];
        this._lastFrameTime = performance.now();

        this._setupListeners();
    }

    _setupListeners() {
        this.timeSlider.addEventListener('input', () => {
            const t = parseInt(this.timeSlider.value) / 1000;
            if (this.onTimeChange) this.onTimeChange(t);
        });

        this.playBtn.addEventListener('click', () => {
            if (this.onPlayPause) this.onPlayPause();
        });

        this.speedSlider.addEventListener('input', () => {
            const speed = parseInt(this.speedSlider.value) / 100;
            this.speedLabel.textContent = `${speed.toFixed(1)}x`;
            if (this.onSpeedChange) this.onSpeedChange(speed);
        });

        this.prevBtn.addEventListener('click', () => {
            if (this._switching || this._scenes.length === 0) return;
            this._currentSceneIndex = (this._currentSceneIndex - 1 + this._scenes.length) % this._scenes.length;
            this._updateCarousel();
            if (this.onSceneChange) this.onSceneChange(this._currentSceneIndex);
        });

        this.nextBtn.addEventListener('click', () => {
            if (this._switching || this._scenes.length === 0) return;
            this._currentSceneIndex = (this._currentSceneIndex + 1) % this._scenes.length;
            this._updateCarousel();
            if (this.onSceneChange) this.onSceneChange(this._currentSceneIndex);
        });
    }

    setScenes(scenes) {
        this._scenes = scenes;
        this._currentSceneIndex = 0;
        this._updateCarousel();
    }

    setSceneSwitching(isSwitching) {
        this._switching = isSwitching;
        this.prevBtn.disabled = isSwitching;
        this.nextBtn.disabled = isSwitching;
        if (isSwitching) {
            this.sceneLabel.textContent = 'Loading...';
        } else {
            this._updateCarousel();
        }
    }

    _updateCarousel() {
        if (this._scenes.length === 0) return;
        const scene = this._scenes[this._currentSceneIndex];
        this.sceneLabel.textContent = `${scene.name} (${this._currentSceneIndex + 1}/${this._scenes.length})`;
    }

    showLoading(message) {
        this.overlay.classList.remove('hidden');
        this.loadingStatus.textContent = message;
    }

    setProgress(fraction) {
        this.progressFill.style.width = `${Math.round(fraction * 100)}%`;
    }

    hideLoading() {
        this.overlay.classList.add('hidden');
        this.hud.classList.remove('hidden');
    }

    setSplatCount(n) {
        this.splatCountEl.textContent = `${n.toLocaleString()} splats`;
    }

    /**
     * Update time display from temporal controller state.
     * @param {number} normalizedTime [0, 1]
     * @param {boolean} isPlaying
     */
    updateTime(normalizedTime, isPlaying) {
        this.timeSlider.value = Math.round(normalizedTime * 1000);
        this.timeDisplay.textContent = `t=${normalizedTime.toFixed(3)}`;
        this.playBtn.innerHTML = isPlaying
            ? '<svg width="12" height="14" viewBox="0 0 12 14"><rect x="1" y="0" width="3" height="14" fill="currentColor"/><rect x="8" y="0" width="3" height="14" fill="currentColor"/></svg>'
            : '<svg width="12" height="14" viewBox="0 0 12 14"><path d="M2 0l10 7-10 7z" fill="currentColor"/></svg>';
    }

    /** Sync speed slider from external changes (e.g. VR controller). */
    updateSpeed(speed) {
        this.speedSlider.value = Math.round(speed * 100);
        this.speedLabel.textContent = `${speed.toFixed(1)}x`;
    }

    /** Call each frame to track FPS. */
    updateFPS() {
        const now = performance.now();
        const dt = now - this._lastFrameTime;
        this._lastFrameTime = now;

        this._frameTimes.push(dt);
        if (this._frameTimes.length > 60) this._frameTimes.shift();

        // Update display every 30 frames
        if (this._frameTimes.length % 30 === 0) {
            const avg = this._frameTimes.reduce((a, b) => a + b) / this._frameTimes.length;
            this.fpsDisplay.textContent = `${Math.round(1000 / avg)} FPS`;
        }
    }
}
