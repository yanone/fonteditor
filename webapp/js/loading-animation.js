/**
 * Warp Speed Loading Animation
 * Creates a tunnel effect with letters/symbols from IBM Plex Mono Regular flying towards the viewer
 */

(function () {
    // Animation configuration
    const CONFIG = {
        speed: 1.5,           // Speed multiplier (higher = faster) - increased for faster clearing
        particleCount: 5000,   // Number of particles/letters (increased for more spawning)
        fontFamily: 'IBM Plex Mono',
        fontSize: 3,          // Starting font size (smaller) - reduced for smaller end size
        maxScale: .7,        // Maximum scale multiplier (increased from 0.6 for bigger end size)
        minDisplayTime: 0,    // Minimum display time in milliseconds (0 seconds - no minimum)
        fadeTransitionTime: 1500, // Fade-out transition time in milliseconds (1 second)
        slowdownTime: 1000,   // Time to slow down to zero before fade starts (1 second)
        drainTime: 2000,      // Estimated time for particles to clear the screen (milliseconds) - reduced due to faster speed
        laneCount: 12,        // Number of fixed directional lanes
        spawnInterval: 1 / 3,    // Milliseconds between spawns (reduced to 1/3 of 40ms for 3x spawn rate)
    };

    // Characters to use for the star field (letters, numbers, and symbols)
    const CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*()_+-=[]{}|;:,.<>?/~';

    // Cubic bezier easing function for smooth slowdown
    // Using ease-out cubic bezier (0.4, 0.0, 0.2, 1) - similar to CSS transition
    function cubicBezierEase(t) {
        // Simplified cubic bezier for ease-out effect
        // This creates a smooth deceleration curve
        return 1 - Math.pow(1 - t, 3);
    }

    // Pre-calculate 12 fixed directional lanes
    const LANES = [];
    for (let i = 0; i < CONFIG.laneCount; i++) {
        const angle = (i / CONFIG.laneCount) * Math.PI * 2;
        LANES.push({
            angle: angle,
            velocityX: Math.cos(angle),
            velocityY: Math.sin(angle),
        });
    }

    class Particle {
        constructor(canvas, laneIndex = null) {
            this.canvas = canvas;
            this.laneIndex = laneIndex;
            this.active = false;
            this.z = -1;
        }

        spawn(laneIndex) {
            // Assign a lane
            this.laneIndex = laneIndex;
            const lane = LANES[laneIndex];

            // Position in 3D space - start at center
            this.x = 0;
            this.y = 0;
            this.z = this.canvas.width; // Start far away

            // Use fixed lane direction with consistent speed
            const velocitySpread = 1.0; // Fixed speed for consistency
            this.velocityX = lane.velocityX * velocitySpread;
            this.velocityY = lane.velocityY * velocitySpread;

            // Random character
            this.char = CHARACTERS.charAt(Math.floor(Math.random() * CHARACTERS.length));

            // More random size variation (50% to 150% of base size)
            this.sizeVariation = 0.5 + Math.random() * 1.0;

            // Slight rotation for visual variety
            this.rotation = Math.random() * Math.PI * 2;
            this.rotationSpeed = (Math.random() - 0.5) * 0.1; // Add rotation animation

            // Track if this particle is active
            this.active = true;
        }

        reset() {
            this.active = false;
            this.z = -1;
        }

        update(speed, speedMultiplier = 1.0) {
            if (!this.active) return;

            // Apply speed multiplier for slowdown effect
            const effectiveSpeed = speed * speedMultiplier;

            // Move towards viewer
            this.z -= effectiveSpeed * CONFIG.speed;

            // Move in trajectory direction (accelerating as it gets closer)
            const proximityFactor = 1 - (this.z / this.canvas.width);
            this.x += this.velocityX * effectiveSpeed * 0.01 * proximityFactor;
            this.y += this.velocityY * effectiveSpeed * 0.01 * proximityFactor;

            // Rotate over time
            this.rotation += this.rotationSpeed * effectiveSpeed;

            // Reset when particle passes the camera or goes off screen
            const scale = 1000 / Math.max(this.z, 1);
            const x2d = this.x * scale;
            const y2d = this.y * scale;
            const margin = 500; // Allow particles to go well off screen before resetting

            if (this.z <= 0 || Math.abs(x2d) > margin || Math.abs(y2d) > margin) {
                this.reset();
            }
        }

        draw(ctx) {
            if (!this.active) return;

            const width = this.canvas.width;
            const height = this.canvas.height;

            // Perspective projection
            const scale = 1000 / this.z;
            const x2d = this.x * scale + width / 2;
            const y2d = this.y * scale + height / 2;

            // Only draw if on screen (with some margin)
            const margin = 100;
            if (x2d < -margin || x2d > width + margin || y2d < -margin || y2d > height + margin) {
                return;
            }

            // Calculate distance from center for color interpolation
            const centerX = width / 2;
            const centerY = height / 2;
            const dx = x2d - centerX;
            const dy = y2d - centerY;
            const distFromCenter = Math.sqrt(dx * dx + dy * dy);
            const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);
            const normalizedDist = Math.min(distFromCenter / maxDist, 1);

            // Interpolate from black (center) to white (edges)
            const brightness = Math.floor(normalizedDist * 255);

            // Also factor in depth for additional fade
            const depthFade = Math.max(0, Math.min(1, (this.canvas.width - this.z) / this.canvas.width));
            const finalBrightness = Math.floor(brightness * depthFade);

            // Size based on depth (closer = bigger), with max scale limit and random variation
            const size = CONFIG.fontSize * scale * CONFIG.maxScale * this.sizeVariation;

            // Opacity based on depth
            const opacity = Math.max(0.2, depthFade);

            ctx.save();
            ctx.translate(x2d, y2d);
            ctx.rotate(this.rotation);
            ctx.font = `${size}px '${CONFIG.fontFamily}'`;
            ctx.fillStyle = `rgba(${finalBrightness}, ${finalBrightness}, ${finalBrightness}, ${opacity})`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(this.char, 0, 0);
            ctx.restore();
        }
    }

    class WarpSpeedAnimation {
        constructor() {
            this.canvas = null;
            this.ctx = null;
            this.particles = [];
            this.animationId = null;
            this.lastTime = 0;
            this.startTime = 0;
            this.stopRequested = false;
            this.stopRequestTime = 0;
            this.allowRespawn = true;
            this.fadeCallback = null;
            this.lastSpawnTime = 0;
            this.nextLaneIndex = 0;
        }

        init() {
            // Create canvas element
            this.canvas = document.createElement('canvas');
            this.canvas.id = 'loading-animation-canvas';
            this.ctx = this.canvas.getContext('2d');

            // Insert canvas into loading overlay, before the loading content
            const overlay = document.getElementById('loading-overlay');
            if (overlay) {
                overlay.insertBefore(this.canvas, overlay.firstChild);
            }

            // Set canvas size
            this.resize();

            // Create particle pool
            for (let i = 0; i < CONFIG.particleCount; i++) {
                this.particles.push(new Particle(this.canvas));
            }

            // Handle window resize
            window.addEventListener('resize', () => this.resize());

            // Start animation
            this.startTime = performance.now();
            this.lastTime = this.startTime;
            // Set last spawn time in the past to continue regular spawning
            this.lastSpawnTime = this.startTime - CONFIG.spawnInterval;

            // Fill the entire visible area with particles from center to edges (and some beyond)
            // We want particles at all stages of their journey
            const numToSpawn = Math.min(100, this.particles.length);

            for (let i = 0; i < numToSpawn; i++) {
                const particle = this.particles[i];
                const randomLane = Math.floor(Math.random() * CONFIG.laneCount);
                particle.spawn(randomLane);

                // Distribute particles evenly from center (z=canvas.width) to beyond screen (z<0)
                // Earlier particles (lower i) should be further out, even off-screen
                const progress = i / numToSpawn; // 0 to 1

                // Position from slightly off-screen (progress=0) to center (progress=1)
                // z value: negative (off-screen) to canvas.width (far back)
                particle.z = this.canvas.width * (1 - progress) - (progress * 200); // Some go off-screen

                // Calculate the x,y position based on how far the particle has traveled
                const distanceTraveled = this.canvas.width - particle.z;
                const normalizedDistance = distanceTraveled / this.canvas.width;

                // Move particle along its lane based on how far it has traveled
                const proximityFactor = Math.max(0, normalizedDistance);
                const travelFrames = distanceTraveled / CONFIG.speed;
                particle.x += particle.velocityX * travelFrames * 0.01 * proximityFactor;
                particle.y += particle.velocityY * travelFrames * 0.01 * proximityFactor;

                // Some particles may already be off-screen, mark them for respawn
                if (particle.z < -500) {
                    particle.reset();
                }
            }

            this.animate(this.lastTime);
        }

        resize() {
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;
        }

        animate(currentTime) {
            this.animationId = requestAnimationFrame((time) => this.animate(time));

            // Calculate delta time for smooth animation
            const deltaTime = (currentTime - this.lastTime) / 16.67; // Normalize to 60fps
            this.lastTime = currentTime;

            // Check if we should stop respawning particles
            const elapsedTime = currentTime - this.startTime;

            if (this.stopRequested) {
                // Stop spawning immediately when fade is requested
                this.allowRespawn = false;
            } else if (elapsedTime >= CONFIG.minDisplayTime) {
                // Or stop spawning after minimum display time
                this.allowRespawn = false;
            }

            // Calculate speed multiplier for slowdown effect
            let speedMultiplier = 1.0;
            if (this.stopRequested && this.stopRequestTime > 0) {
                const timeSinceStop = currentTime - this.stopRequestTime;
                const halfFadeTime = CONFIG.fadeTransitionTime / 2;

                if (timeSinceStop < CONFIG.slowdownTime) {
                    // Phase 1: Slow down from 1.0 to 0 over slowdownTime with smooth bezier curve
                    const progress = timeSinceStop / CONFIG.slowdownTime; // 0 to 1
                    const easedProgress = cubicBezierEase(progress); // Apply easing
                    speedMultiplier = 1.0 - easedProgress; // Invert so we go from 1 to 0
                } else {
                    // Phase 2 & 3: Stay at 0 during first half of fade and frozen during second half
                    speedMultiplier = 0;
                }
            }

            // Regular spawning at fixed intervals
            if (this.allowRespawn && currentTime - this.lastSpawnTime >= CONFIG.spawnInterval) {
                this.spawnParticle();
                this.lastSpawnTime = currentTime;
            }

            // Clear canvas
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            // Update and draw particles (draw from back to front for proper layering)
            // Sort by z-depth (furthest first)
            this.particles.sort((a, b) => b.z - a.z);

            // Update and draw particles with slowdown
            this.particles.forEach(particle => {
                if (particle.active) {
                    particle.update(deltaTime, speedMultiplier);
                    particle.draw(this.ctx);
                }
            });

            // Stop animation after slowdown + fade completes
            if (this.stopRequested && this.stopRequestTime > 0) {
                const timeSinceStop = currentTime - this.stopRequestTime;
                const totalTime = CONFIG.slowdownTime + CONFIG.fadeTransitionTime;
                if (timeSinceStop >= totalTime) {
                    this.stop();
                }
            }
        }

        spawnParticle() {
            // Find an inactive particle
            const particle = this.particles.find(p => !p.active);
            if (particle) {
                // Random lane selection from the 12 available lanes
                const randomLane = Math.floor(Math.random() * CONFIG.laneCount);
                particle.spawn(randomLane);
            }
        }

        requestStop(onComplete) {
            // Signal that we want to stop
            this.stopRequested = true;
            this.stopRequestTime = performance.now();

            // Delay the fade callback until after slowdown completes
            if (onComplete) {
                setTimeout(() => {
                    onComplete();
                }, CONFIG.slowdownTime);
            }
        }

        stop() {
            if (this.animationId) {
                cancelAnimationFrame(this.animationId);
                this.animationId = null;
            }
            if (this.canvas && this.canvas.parentNode) {
                this.canvas.parentNode.removeChild(this.canvas);
            }
        }
    }

    // Initialize animation when DOM is ready
    let animation = null;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            animation = new WarpSpeedAnimation();
            animation.init();
        });
    } else {
        animation = new WarpSpeedAnimation();
        animation.init();
    }

    // Export for potential external control
    window.WarpSpeedAnimation = {
        setSpeed: (speed) => { CONFIG.speed = speed; },
        setParticleCount: (count) => {
            CONFIG.particleCount = count;
            // Would need to recreate particles
        },
        getConfig: () => CONFIG,
        requestStop: (onComplete) => { if (animation) animation.requestStop(onComplete); },
        instance: () => animation,
    };

    // Utility function to update loading status
    window.updateLoadingStatus = (message, isReady = false) => {
        const statusElement = document.getElementById('loading-status');
        if (statusElement) {
            statusElement.textContent = message;
            if (isReady) {
                statusElement.classList.add('ready');
            } else {
                statusElement.classList.remove('ready');
            }
        }
    };
})();
