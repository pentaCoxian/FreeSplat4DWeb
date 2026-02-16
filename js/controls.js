import * as THREE from 'three';

const SNAP_ANGLE = Math.PI / 6; // 30 degrees
const MOVE_SPEED = 0.03;
const THUMBSTICK_DEADZONE = 0.15;
const SCRUB_SPEED = 0.008;
const SPEED_ADJUST = 0.03;

/**
 * VR controller handling for WebXR sessions.
 *
 * Controls:
 *   Right trigger      — play/pause toggle
 *   Right thumbstick Y — smooth locomotion forward/back
 *   Right thumbstick X — snap turn (30-degree increments)
 *   Left grip held + thumbstick X — time scrub
 *   Left grip held + thumbstick Y — playback speed
 */
export class VRControls {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Camera} camera
     * @param {TemporalController|null} temporalCtrl
     * @param {THREE.Group} rig - camera rig group for locomotion
     */
    constructor(renderer, camera, temporalCtrl, rig) {
        this.renderer = renderer;
        this.camera = camera;
        this.temporalCtrl = temporalCtrl;
        this.rig = rig;

        // Snap turn state (prevent repeated triggers)
        this._snapCooldown = false;
        this._prevTriggerRight = false;
    }

    /**
     * Update controls each frame.
     * @param {number} timestamp
     * @param {XRFrame|null} frame
     */
    update(timestamp, frame) {
        if (!frame) return;

        const session = this.renderer.xr.getSession();
        if (!session) return;

        for (const source of session.inputSources) {
            if (!source.gamepad) continue;

            const axes = source.gamepad.axes;
            const buttons = source.gamepad.buttons;

            if (source.handedness === 'right') {
                this._handleRight(axes, buttons);
            } else if (source.handedness === 'left') {
                this._handleLeft(axes, buttons);
            }
        }
    }

    /**
     * Right controller: locomotion + play/pause.
     */
    _handleRight(axes, buttons) {
        // Trigger: play/pause toggle (on press, not hold)
        const triggerPressed = buttons[0]?.pressed ?? false;
        if (triggerPressed && !this._prevTriggerRight) {
            if (this.temporalCtrl) {
                this.temporalCtrl.togglePlayPause();
            }
        }
        this._prevTriggerRight = triggerPressed;

        // Thumbstick Y: smooth locomotion forward/back
        const moveY = axes[3] ?? 0;
        if (Math.abs(moveY) > THUMBSTICK_DEADZONE) {
            const direction = new THREE.Vector3(0, 0, -moveY * MOVE_SPEED);
            direction.applyQuaternion(this.camera.quaternion);
            direction.y = 0; // Prevent vertical movement
            this.rig.position.add(direction);
        }

        // Thumbstick X: snap turn
        const moveX = axes[2] ?? 0;
        if (Math.abs(moveX) > 0.6 && !this._snapCooldown) {
            const angle = moveX > 0 ? -SNAP_ANGLE : SNAP_ANGLE;
            this.rig.rotateY(angle);
            this._snapCooldown = true;
            setTimeout(() => { this._snapCooldown = false; }, 300);
        }
    }

    /**
     * Left controller: time scrub + speed (with grip held).
     */
    _handleLeft(axes, buttons) {
        const gripPressed = buttons[1]?.pressed ?? false;
        if (!gripPressed || !this.temporalCtrl) return;

        // Grip held + thumbstick X: time scrub
        const scrubX = axes[2] ?? 0;
        if (Math.abs(scrubX) > THUMBSTICK_DEADZONE) {
            const newTime = this.temporalCtrl.normalizedTime + scrubX * SCRUB_SPEED;
            this.temporalCtrl.setNormalizedTime(newTime);
            this.temporalCtrl.pause();
        }

        // Grip held + thumbstick Y: playback speed
        const speedY = axes[3] ?? 0;
        if (Math.abs(speedY) > THUMBSTICK_DEADZONE) {
            this.temporalCtrl.speed = Math.max(0.1, Math.min(5.0,
                this.temporalCtrl.speed + speedY * SPEED_ADJUST));
        }
    }
}

const FPV_DEADZONE = 0.15;
const JOYSTICK_RADIUS = 50;
const JOYSTICK_COLOR = 'rgba(255,255,255,0.25)';
const JOYSTICK_THUMB_COLOR = 'rgba(255,255,255,0.5)';

/**
 * First-person view controls for desktop + mobile.
 *
 * Input sources (all feed into the same movement/look system):
 *   Desktop:  WASD/QE + pointer-lock mouse look + gamepad
 *   Mobile:   Virtual dual joysticks (left=move, right=look)
 */
export class FPVControls {
    constructor(camera, domElement, options = {}) {
        this.camera = camera;
        this.domElement = domElement;
        this.enabled = true;
        this.moveSpeed = options.moveSpeed ?? 3.0;
        this.lookSpeed = options.lookSpeed ?? 0.002;

        camera.rotation.order = 'YXZ';

        // Keyboard state
        this._keys = new Set();

        // Mouse look accumulators (applied in update)
        this._yaw = camera.rotation.y;
        this._pitch = camera.rotation.x;

        // Touch joystick state
        this._hasTouch = 'ontouchstart' in window;
        this._moveTouch = null; // { id, startX, startY, currentX, currentY }
        this._lookTouch = null;
        this._joystickCanvas = null;
        this._joystickCtx = null;

        // Bound handlers for cleanup
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onKeyUp = this._handleKeyUp.bind(this);
        this._onClick = this._handleClick.bind(this);
        this._onMouseMove = this._handleMouseMove.bind(this);

        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
        domElement.addEventListener('click', this._onClick);
        document.addEventListener('mousemove', this._onMouseMove);

        if (this._hasTouch) {
            this._setupTouchJoysticks();
        }
    }

    _handleKeyDown(e) {
        this._keys.add(e.code);
    }

    _handleKeyUp(e) {
        this._keys.delete(e.code);
    }

    _handleClick() {
        if (!this.enabled || this._hasTouch) return;
        this.domElement.requestPointerLock();
    }

    _handleMouseMove(e) {
        if (!this.enabled) return;
        if (document.pointerLockElement !== this.domElement) return;
        this._yaw -= e.movementX * this.lookSpeed;
        this._pitch -= e.movementY * this.lookSpeed;
        this._pitch = Math.max(-Math.PI * 85 / 180, Math.min(Math.PI * 85 / 180, this._pitch));
    }

    // --- Touch virtual joysticks ---

    _setupTouchJoysticks() {
        const canvas = document.createElement('canvas');
        canvas.id = 'joystick-overlay';
        canvas.style.cssText = 'position:fixed;inset:0;z-index:40;touch-action:none;';
        document.body.appendChild(canvas);
        this._joystickCanvas = canvas;
        this._joystickCtx = canvas.getContext('2d');

        const resize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        resize();
        window.addEventListener('resize', resize);
        this._onJoystickResize = resize;

        canvas.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
        canvas.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
        canvas.addEventListener('touchend', (e) => this._onTouchEnd(e));
        canvas.addEventListener('touchcancel', (e) => this._onTouchEnd(e));
    }

    _onTouchStart(e) {
        e.preventDefault();
        const midX = window.innerWidth / 2;
        for (const touch of e.changedTouches) {
            // Ignore touches in the bottom HUD area
            if (touch.clientY > window.innerHeight - 120) continue;

            if (touch.clientX < midX && !this._moveTouch) {
                this._moveTouch = { id: touch.identifier, startX: touch.clientX, startY: touch.clientY, currentX: touch.clientX, currentY: touch.clientY };
            } else if (touch.clientX >= midX && !this._lookTouch) {
                this._lookTouch = { id: touch.identifier, startX: touch.clientX, startY: touch.clientY, currentX: touch.clientX, currentY: touch.clientY };
            }
        }
    }

    _onTouchMove(e) {
        e.preventDefault();
        for (const touch of e.changedTouches) {
            if (this._moveTouch && touch.identifier === this._moveTouch.id) {
                this._moveTouch.currentX = touch.clientX;
                this._moveTouch.currentY = touch.clientY;
            }
            if (this._lookTouch && touch.identifier === this._lookTouch.id) {
                this._lookTouch.currentX = touch.clientX;
                this._lookTouch.currentY = touch.clientY;
            }
        }
    }

    _onTouchEnd(e) {
        for (const touch of e.changedTouches) {
            if (this._moveTouch && touch.identifier === this._moveTouch.id) {
                this._moveTouch = null;
            }
            if (this._lookTouch && touch.identifier === this._lookTouch.id) {
                this._lookTouch = null;
            }
        }
    }

    _getJoystickAxes(touchState) {
        if (!touchState) return { x: 0, y: 0 };
        let dx = (touchState.currentX - touchState.startX) / JOYSTICK_RADIUS;
        let dy = (touchState.currentY - touchState.startY) / JOYSTICK_RADIUS;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1) { dx /= len; dy /= len; }
        return { x: dx, y: dy };
    }

    _drawJoysticks() {
        const ctx = this._joystickCtx;
        const canvas = this._joystickCanvas;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const drawStick = (touch) => {
            if (!touch) return;
            const axes = this._getJoystickAxes(touch);
            // Outer ring
            ctx.beginPath();
            ctx.arc(touch.startX, touch.startY, JOYSTICK_RADIUS, 0, Math.PI * 2);
            ctx.strokeStyle = JOYSTICK_COLOR;
            ctx.lineWidth = 2;
            ctx.stroke();
            // Thumb
            const tx = touch.startX + axes.x * JOYSTICK_RADIUS;
            const ty = touch.startY + axes.y * JOYSTICK_RADIUS;
            ctx.beginPath();
            ctx.arc(tx, ty, 20, 0, Math.PI * 2);
            ctx.fillStyle = JOYSTICK_THUMB_COLOR;
            ctx.fill();
        };

        drawStick(this._moveTouch);
        drawStick(this._lookTouch);
    }

    // --- Gamepad ---

    _pollGamepad() {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const gp of gamepads) {
            if (!gp) continue;
            return gp;
        }
        return null;
    }

    // --- Main update ---

    update(dt) {
        if (!this.enabled) return;

        let moveX = 0, moveY = 0, moveZ = 0;
        let lookX = 0, lookY = 0;
        const sprint = this._keys.has('ShiftLeft') || this._keys.has('ShiftRight');

        // Keyboard movement
        if (this._keys.has('KeyW') || this._keys.has('ArrowUp')) moveZ -= 1;
        if (this._keys.has('KeyS') || this._keys.has('ArrowDown')) moveZ += 1;
        if (this._keys.has('KeyA') || this._keys.has('ArrowLeft')) moveX -= 1;
        if (this._keys.has('KeyD') || this._keys.has('ArrowRight')) moveX += 1;
        if (this._keys.has('KeyE')) moveY += 1;
        if (this._keys.has('KeyQ')) moveY -= 1;

        // Gamepad
        const gp = this._pollGamepad();
        if (gp) {
            const lx = Math.abs(gp.axes[0]) > FPV_DEADZONE ? gp.axes[0] : 0;
            const ly = Math.abs(gp.axes[1]) > FPV_DEADZONE ? gp.axes[1] : 0;
            const rx = Math.abs(gp.axes[2]) > FPV_DEADZONE ? gp.axes[2] : 0;
            const ry = Math.abs(gp.axes[3]) > FPV_DEADZONE ? gp.axes[3] : 0;
            moveX += lx;
            moveZ += ly;
            lookX += rx * 2.0;
            lookY += ry * 2.0;
            // Triggers: up/down
            const lt = gp.buttons[6]?.value ?? 0;
            const rt = gp.buttons[7]?.value ?? 0;
            moveY += rt - lt;
        }

        // Touch joysticks
        if (this._hasTouch) {
            const moveAxes = this._getJoystickAxes(this._moveTouch);
            const lookAxes = this._getJoystickAxes(this._lookTouch);
            moveX += moveAxes.x;
            moveZ += moveAxes.y;
            lookX += lookAxes.x * 0.5;
            lookY += lookAxes.y * 0.5;
            this._drawJoysticks();
        }

        // Apply look (gamepad/touch contribute to yaw/pitch)
        this._yaw -= lookX * this.lookSpeed * 30;
        this._pitch -= lookY * this.lookSpeed * 30;
        this._pitch = Math.max(-Math.PI * 85 / 180, Math.min(Math.PI * 85 / 180, this._pitch));

        this.camera.rotation.y = this._yaw;
        this.camera.rotation.x = this._pitch;

        // Apply movement in camera-local space (yaw only, no pitch)
        const speed = this.moveSpeed * dt * (sprint ? 2 : 1);
        const forward = new THREE.Vector3(0, 0, -1);
        forward.applyAxisAngle(new THREE.Vector3(0, 1, 0), this._yaw);
        const right = new THREE.Vector3(1, 0, 0);
        right.applyAxisAngle(new THREE.Vector3(0, 1, 0), this._yaw);

        this.camera.position.addScaledVector(forward, -moveZ * speed);
        this.camera.position.addScaledVector(right, moveX * speed);
        this.camera.position.y += moveY * speed;
    }

    dispose() {
        document.removeEventListener('keydown', this._onKeyDown);
        document.removeEventListener('keyup', this._onKeyUp);
        this.domElement.removeEventListener('click', this._onClick);
        document.removeEventListener('mousemove', this._onMouseMove);
        if (this._joystickCanvas) {
            this._joystickCanvas.remove();
            window.removeEventListener('resize', this._onJoystickResize);
        }
    }
}
