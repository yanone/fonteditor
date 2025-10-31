// Sound Preloader - Preloads all sound files for faster playback
(function () {
    // List of all sound files to preload
    const soundFiles = [
        'assets/sounds/error.wav',
        'assets/sounds/done.wav',
        'assets/sounds/attention.wav',
        'assets/sounds/incoming_message.wav',
        'assets/sounds/message_sent.wav'
    ];

    // Store preloaded Audio objects globally
    window.preloadedSounds = {};

    // Get volume from localStorage or default to 40
    // Use nullish coalescing to properly handle 0 value
    const savedVolume = localStorage.getItem('sound_volume');
    let currentVolume = savedVolume !== null ? parseInt(savedVolume) : 40;

    // Preload each sound file
    soundFiles.forEach(soundPath => {
        const audio = new Audio();
        audio.preload = 'auto';
        audio.src = soundPath;

        // Store in global object with key extracted from path
        const key = soundPath.split('/').pop().replace('.wav', '');
        window.preloadedSounds[key] = audio;

        // Load the audio
        audio.load();

        console.log(`Preloaded sound: ${key}`);
    });

    /**
     * Play a preloaded sound
     * @param {string} soundName - Name of the sound (without .wav extension)
     */
    window.playSound = function (soundName) {
        // Don't play if volume is 0
        if (currentVolume === 0) {
            return;
        }

        const sound = window.preloadedSounds[soundName];
        if (sound) {
            // Clone the audio to allow overlapping plays
            const clone = sound.cloneNode();
            clone.volume = currentVolume / 100; // Convert 0-100 to 0-1
            clone.play().catch(e => console.warn(`Could not play sound ${soundName}:`, e));
        } else {
            console.warn(`Sound not found: ${soundName}`);
        }
    };

    /**
     * Update the volume for all sounds
     * @param {number} volume - Volume level (0-100)
     */
    window.setVolume = function (volume) {
        currentVolume = Math.max(0, Math.min(100, volume));
        localStorage.setItem('sound_volume', currentVolume);
    };

    /**
     * Get the current volume
     * @returns {number} Current volume (0-100)
     */
    window.getVolume = function () {
        return currentVolume;
    };

    // Initialize volume slider when DOM is ready
    document.addEventListener('DOMContentLoaded', () => {
        const volumeSlider = document.getElementById('volume-slider');
        const volumeLabel = document.querySelector('.volume-label');

        if (volumeSlider) {
            // Set initial value from localStorage
            volumeSlider.value = currentVolume;

            // Update icon based on volume
            const updateVolumeIcon = (volume) => {
                if (volume === 0) {
                    volumeLabel.textContent = '🔇';
                } else if (volume < 33) {
                    volumeLabel.textContent = '🔈';
                } else if (volume < 67) {
                    volumeLabel.textContent = '🔉';
                } else {
                    volumeLabel.textContent = '🔊';
                }
            };

            updateVolumeIcon(currentVolume);

            // Listen for slider changes
            volumeSlider.addEventListener('input', (e) => {
                const volume = parseInt(e.target.value);
                window.setVolume(volume);
                updateVolumeIcon(volume);
            });
        }
    });

    console.log('Sound preloader initialized');
})();
