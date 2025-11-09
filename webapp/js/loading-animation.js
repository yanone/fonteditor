/**
 * Flickering Grid Loading Animation
 * Creates a grid of characters from multiple IBM Plex Sans font families
 * Characters appear randomly and flicker around the center logo
 * Each character is rendered in its appropriate font family (Regular weight only)
 */

(function () {
    // Animation configuration
    const CONFIG = {
        gridSpacing: 40,        // Space between grid points
        fontSize: 24,           // Base font size
        sizeVariation: 0.5,     // Size variation (30%)
        initialFlickerDelay: 50, // Delay between initial flickers (ms)
        flickerChance: 0.002,   // Chance per frame for a star to flicker again
        starsFadeTime: 1000,    // Time for stars to fade out (ms)
        finalFadeTime: 1500,    // Time for final fade out (ms)
        minDistanceFromCenter: 300, // Minimum distance from center for stars
    };

    // Script-specific character sets for different writing systems
    // Each script uses representative characters from its Unicode range
    const SCRIPTS = {
        latin: {
            fontFamily: 'IBM Plex Sans',
            chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ'
        },
        arabic: {
            fontFamily: 'IBM Plex Sans Arabic',
            chars: 'ابتثجحخدذرزسشصضطظعغفقكلمنهويءآأؤإئةى٠١٢٣٤٥٦٧٨٩'
        },
        devanagari: {
            fontFamily: 'IBM Plex Sans Devanagari',
            chars: 'अआइईउऊएऐओऔकखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह०१२३४५६७८९'
        },
        hebrew: {
            fontFamily: 'IBM Plex Sans Hebrew',
            chars: 'אבגדהוזחטיכלמנסעפצקרשתךםןףץ'
        },
        thai: {
            fontFamily: 'IBM Plex Sans Thai',
            chars: 'กขคงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮะาิีึืุู๐๑๒๓๔๕๖๗๘๙'
        },
        korean: {
            fontFamily: 'IBM Plex Sans KR',
            chars: 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎㅏㅐㅑㅒㅓㅔㅕㅖㅗㅛㅜㅠㅡㅣ가나다라마바사아자차카타파하각난달람밤박삭악작착칵탁팍학'
        },
        japanese: {
            fontFamily: 'IBM Plex Sans JP',
            chars: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン一二三四五六七八九十'
        }
    };

    // Combine all characters from all scripts
    const ALL_CHARACTERS = Object.values(SCRIPTS).map(s => s.chars).join('');

    // Create a lookup table for quick font family retrieval by character
    const CHAR_TO_FONT = {};
    Object.entries(SCRIPTS).forEach(([scriptName, script]) => {
        for (const char of script.chars) {
            CHAR_TO_FONT[char] = script.fontFamily;
        }
    });

    // Cubic bezier easing function
    function cubicBezierEase(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    class Star {
        constructor(x, y) {
            this.x = x;
            this.y = y;

            // Random character from all scripts
            this.char = ALL_CHARACTERS.charAt(Math.floor(Math.random() * ALL_CHARACTERS.length));

            // Get the appropriate font family for this character
            this.fontFamily = CHAR_TO_FONT[this.char] || 'IBM Plex Sans';

            // Size variation
            this.size = CONFIG.fontSize * (1 + (Math.random() - 0.5) * CONFIG.sizeVariation);

            // Initial state
            this.opacity = 0;
            this.targetOpacity = 0;
            this.hasAppeared = false;
            this.appearTime = 0;
            this.disappearTime = null;
            this.hasDisappeared = false;
        }

        appear(delay) {
            this.appearTime = delay;
        }

        disappear(delay) {
            this.disappearTime = delay;
        }

        flicker() {
            // Random flicker: toggle between visible and invisible
            this.targetOpacity = this.targetOpacity > 0 ? 0 : 0.7;
        }

        update(currentTime, isFadingOut, fadeProgress, isFadingFinal) {
            if (isFadingOut || isFadingFinal) {
                // Individual disappearance - only for stars that have appeared and haven't disappeared yet
                if (this.hasAppeared && !this.hasDisappeared && this.disappearTime !== null && currentTime >= this.disappearTime) {
                    this.opacity = 0;
                    this.targetOpacity = 0;
                    this.hasDisappeared = true;
                }
            } else if (currentTime >= this.appearTime && !this.hasAppeared) {
                // Initial appearance
                this.hasAppeared = true;
                this.targetOpacity = 0.7;
                this.opacity = 0.7;
            } else if (this.hasAppeared && !this.hasDisappeared) {
                // Smooth transition to target opacity
                const diff = this.targetOpacity - this.opacity;
                this.opacity += diff * 0.1;
            }
        }

        draw(ctx) {
            if (this.opacity > 0.01) {
                ctx.save();
                ctx.font = `${this.size}px '${this.fontFamily}'`;
                ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity})`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(this.char, this.x, this.y);
                ctx.restore();
            }
        }
    }

    class FlickeringGridAnimation {
        constructor() {
            this.canvas = null;
            this.ctx = null;
            this.stars = [];
            this.animationId = null;
            this.startTime = 0;
            this.stopRequested = false;
            this.stopRequestTime = 0;
            this.isFadingStars = false;
            this.starsFadeStartTime = 0;
            this.isFadingFinal = false;
            this.finalFadeStartTime = 0;
        }

        init() {
            // Create canvas element
            this.canvas = document.createElement('canvas');
            this.canvas.id = 'loading-animation-canvas';
            this.ctx = this.canvas.getContext('2d');

            // Insert canvas into loading overlay
            const overlay = document.getElementById('loading-overlay');
            if (overlay) {
                overlay.insertBefore(this.canvas, overlay.firstChild);
            }

            // Set canvas size
            this.resize();

            // Create grid of stars around center
            this.createStarGrid();

            // Handle window resize
            window.addEventListener('resize', () => this.resize());

            // Start animation
            this.startTime = performance.now();
            this.animate(this.startTime);
        }

        createStarGrid() {
            const centerX = this.canvas.width / 2;
            const centerY = this.canvas.height / 2;

            // Calculate grid bounds
            const cols = Math.ceil(this.canvas.width / CONFIG.gridSpacing);
            const rows = Math.ceil(this.canvas.height / CONFIG.gridSpacing);

            // Create stars on grid, excluding center area
            const gridStars = [];
            for (let row = -rows / 2; row <= rows / 2; row++) {
                for (let col = -cols / 2; col <= cols / 2; col++) {
                    const x = centerX + col * CONFIG.gridSpacing;
                    const y = centerY + row * CONFIG.gridSpacing;

                    // Calculate distance from center
                    const dx = x - centerX;
                    const dy = y - centerY;
                    const distFromCenter = Math.sqrt(dx * dx + dy * dy);

                    // Only add stars outside minimum distance from center
                    if (distFromCenter >= CONFIG.minDistanceFromCenter) {
                        gridStars.push(new Star(x, y));
                    }
                }
            }

            // Shuffle stars array for random appearance order
            for (let i = gridStars.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [gridStars[i], gridStars[j]] = [gridStars[j], gridStars[i]];
            }

            // Assign appearance times
            gridStars.forEach((star, index) => {
                star.appear(index * CONFIG.initialFlickerDelay);
            });

            this.stars = gridStars;
        }

        resize() {
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;
        }

        animate(currentTime) {
            this.animationId = requestAnimationFrame((time) => this.animate(time));

            const elapsedTime = currentTime - this.startTime;

            // Handle fade states
            let fadeProgress = 0;

            if (this.isFadingFinal) {
                // Final fade of everything
                const timeSinceFinalFade = currentTime - this.finalFadeStartTime;
                fadeProgress = Math.min(1, timeSinceFinalFade / CONFIG.finalFadeTime);

                // Apply fade to canvas
                const easedProgress = cubicBezierEase(fadeProgress);
                this.canvas.style.opacity = 1 - easedProgress;

                if (fadeProgress >= 1) {
                    this.stop();
                    return;
                }
                // Keep stars fully faded during final fade
                fadeProgress = 1;
            } else if (this.isFadingStars) {
                // Fading out stars
                const timeSinceStarsFade = currentTime - this.starsFadeStartTime;
                fadeProgress = Math.min(1, timeSinceStarsFade / CONFIG.starsFadeTime);

                // Disintegrate the loading status label
                const statusElement = document.getElementById('loading-status');
                if (statusElement && statusElement.dataset.originalText) {
                    const originalText = statusElement.dataset.originalText;
                    const numCharsToRemove = Math.floor(fadeProgress * originalText.length);

                    // Create array of indices to remove
                    if (!statusElement.dataset.removeIndices) {
                        // Create shuffled array of all character indices
                        const indices = Array.from({ length: originalText.length }, (_, i) => i);
                        for (let i = indices.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [indices[i], indices[j]] = [indices[j], indices[i]];
                        }
                        statusElement.dataset.removeIndices = JSON.stringify(indices);
                    }

                    const removeIndices = JSON.parse(statusElement.dataset.removeIndices);
                    const indicesToRemove = new Set(removeIndices.slice(0, numCharsToRemove));

                    // Build disintegrated text
                    let disintegratedText = '';
                    for (let i = 0; i < originalText.length; i++) {
                        disintegratedText += indicesToRemove.has(i) ? '\u00A0' : originalText[i];
                    }
                    statusElement.textContent = disintegratedText;
                }

                if (fadeProgress >= 1) {
                    // Stars fully faded, start final fade
                    this.isFadingStars = false;
                    this.isFadingFinal = true;
                    this.finalFadeStartTime = currentTime;
                }
            } else if (this.stopRequested && !this.isFadingStars) {
                // Stop requested, begin fading stars
                this.isFadingStars = true;
                this.starsFadeStartTime = currentTime;

                // Store original text of status element
                const statusElement = document.getElementById('loading-status');
                if (statusElement && !statusElement.dataset.originalText) {
                    statusElement.dataset.originalText = statusElement.textContent;
                }

                // Assign random disappear times to all appeared stars
                const appearedStars = this.stars.filter(star => star.hasAppeared);

                // Shuffle appeared stars for random disappearance order
                const shuffled = [...appearedStars];
                for (let i = shuffled.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                }

                // Assign disappear times spread across the fade duration
                const disappearInterval = CONFIG.starsFadeTime / shuffled.length;
                shuffled.forEach((star, index) => {
                    star.disappear(currentTime + index * disappearInterval);
                });
            }

            // Random flickering for stars that have already appeared
            if (!this.isFadingStars && !this.isFadingFinal) {
                this.stars.forEach(star => {
                    if (star.hasAppeared && Math.random() < CONFIG.flickerChance) {
                        star.flicker();
                    }
                });
            }

            // Clear canvas
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            // Update and draw stars
            this.stars.forEach(star => {
                star.update(elapsedTime, this.isFadingStars, fadeProgress, this.isFadingFinal);
                star.draw(this.ctx);
            });
        }

        requestStop(onComplete) {
            this.stopRequested = true;
            this.stopRequestTime = performance.now();

            // Call callback after stars fade out
            if (onComplete) {
                setTimeout(() => {
                    onComplete();
                }, CONFIG.starsFadeTime);
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
            animation = new FlickeringGridAnimation();
            animation.init();
        });
    } else {
        animation = new FlickeringGridAnimation();
        animation.init();
    }

    // Export for potential external control
    window.WarpSpeedAnimation = {
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

    // Clear initial message and show "Bootstrapping..." after 2 seconds
    const initBootstrappingMessage = () => {
        const statusElement = document.getElementById('loading-status');
        if (statusElement) {
            // Clear the initial message immediately
            statusElement.textContent = '';

            // Show "Bootstrapping..." after 2 seconds if no other message has been set
            setTimeout(() => {
                if (statusElement.textContent === '') {
                    statusElement.textContent = 'Bootstrapping...';
                }
            }, 2000);
        }
    };

    // Initialize bootstrapping message when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initBootstrappingMessage);
    } else {
        initBootstrappingMessage();
    }
})();
