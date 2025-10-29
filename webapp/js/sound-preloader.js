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
        const sound = window.preloadedSounds[soundName];
        if (sound) {
            // Clone the audio to allow overlapping plays
            const clone = sound.cloneNode();
            clone.play().catch(e => console.warn(`Could not play sound ${soundName}:`, e));
        } else {
            console.warn(`Sound not found: ${soundName}`);
        }
    };

    console.log('Sound preloader initialized');
})();
