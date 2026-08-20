describe('tour intro', () => {
    let tour;

    function mountToolbar() {
        document.body.innerHTML = `
            <div class="toolbar-right">
                <button id="settings-btn" type="button">Settings</button>
            </div>
        `;
    }

    beforeEach(() => {
        localStorage.clear();
        jest.resetModules();
        delete window.__tourHost;
        document.body.innerHTML = '';
        window.isTestMode = () => false;
        mountToolbar();
        tour = require('../js/tour');
    });

    test('does not auto-open until the folder auto-prompt settles', () => {
        expect(document.getElementById('tour-intro-title')).toBeNull();
    });

    test('opens after the folder auto-prompt settles', () => {
        window.dispatchEvent(
            new CustomEvent('folderPermissionsAutoPromptSettled')
        );

        expect(document.getElementById('tour-intro-title').textContent).toBe(
            'Take a Tour'
        );
        expect(
            document.querySelector('.tour-intro-overlay [data-action="start"]')
                .textContent
        ).toBe('Take a Tour');
    });

    test('does not auto-open in ?test=true sessions', () => {
        window.isTestMode = () => true;
        window.dispatchEvent(
            new CustomEvent('folderPermissionsAutoPromptSettled')
        );
        expect(document.getElementById('tour-intro-title')).toBeNull();
    });

    test('does not auto-open when the tour was skipped', () => {
        tour.skipTour();
        window.dispatchEvent(
            new CustomEvent('folderPermissionsAutoPromptSettled')
        );
        expect(document.getElementById('tour-intro-title')).toBeNull();
        expect(document.getElementById('tour-launch-chip').hidden).toBe(false);
    });

    test('skip stores status, closes the modal, and shows the launch chip', () => {
        tour.openTourIntro();
        document
            .querySelector('[data-action="skip"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(document.getElementById('tour-intro-title')).toBeNull();
        expect(localStorage.getItem('tourSkipped')).toBe('true');
        expect(tour.hasSkippedTour()).toBe(true);
        expect(document.getElementById('tour-launch-chip').hidden).toBe(false);
    });

    test('launch chip opens the intro and dismiss hides it', () => {
        tour.skipTour();
        const chip = document.getElementById('tour-launch-chip');
        chip.querySelector('.toolbar-tour-launch-btn').dispatchEvent(
            new MouseEvent('click', { bubbles: true })
        );
        expect(document.getElementById('tour-intro-title')).not.toBeNull();

        document
            .querySelector('[data-action="skip"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        chip.querySelector('.toolbar-tour-launch-dismiss').dispatchEvent(
            new MouseEvent('click', { bubbles: true })
        );
        expect(localStorage.getItem('tourLaunchButtonDismissed')).toBe('true');
        expect(chip.hidden).toBe(true);
    });

    test('Take a Tour closes the intro and records that the tour started', () => {
        tour.openTourIntro();
        document
            .querySelector('[data-action="start"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(document.getElementById('tour-intro-title')).toBeNull();
        expect(localStorage.getItem('tourStarted')).toBe('true');
        expect(tour.hasStartedTour()).toBe(true);
        expect(document.getElementById('tour-launch-chip').hidden).toBe(true);
    });

    test('Help can open the intro after skip', () => {
        tour.skipTour();
        tour.openTourIntro();
        expect(document.getElementById('tour-intro-title')).not.toBeNull();
    });
});
