describe('welcome screen', () => {
    let welcome;

    beforeEach(() => {
        localStorage.clear();
        jest.resetModules();
        document.body.innerHTML = '';
        window.isTestMode = () => false;
        welcome = require('../js/welcome-screen');
    });

    test('is not dismissed until the current version is stored', () => {
        expect(welcome.hasDismissedCurrentWelcome()).toBe(false);
        localStorage.setItem('welcomeDismissedVersion', '0');
        expect(welcome.hasDismissedCurrentWelcome()).toBe(false);
    });

    test('persists the current version on dismiss', () => {
        welcome.dismissCurrentWelcome();
        expect(localStorage.getItem('welcomeDismissedVersion')).toBe(
            String(welcome.WELCOME_VERSION)
        );
        expect(welcome.hasDismissedCurrentWelcome()).toBe(true);
    });

    test('opens after overlay hide when the version is new', () => {
        const overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.className = 'loading-overlay hidden';
        overlay.style.opacity = '0';
        document.body.appendChild(overlay);

        welcome.notifyLoadingOverlayHiding();

        expect(document.querySelector('.info-popup-overlay')).not.toBeNull();
        expect(
            document.getElementById('welcome-screen-title').textContent
        ).toBe('Welcome');
    });

    test('does not open when the current version was dismissed', () => {
        welcome.dismissCurrentWelcome();
        welcome.notifyLoadingOverlayHiding();
        expect(document.querySelector('.info-popup-overlay')).toBeNull();
    });

    test('does not open in ?test=true sessions', () => {
        window.isTestMode = () => true;
        welcome.notifyLoadingOverlayHiding();
        expect(document.querySelector('.info-popup-overlay')).toBeNull();
    });

    test('still opens when navigator.webdriver / isTest is set', () => {
        window.isTest = () => true;
        const overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.className = 'loading-overlay hidden';
        overlay.style.opacity = '0';
        document.body.appendChild(overlay);

        welcome.notifyLoadingOverlayHiding();

        expect(document.querySelector('.info-popup-overlay')).not.toBeNull();
    });

    test('dismissing the modal stores the current version', () => {
        const overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.className = 'loading-overlay hidden';
        overlay.style.opacity = '0';
        document.body.appendChild(overlay);

        welcome.notifyLoadingOverlayHiding();
        document
            .querySelector('[data-action="dismiss"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(document.querySelector('.info-popup-overlay')).toBeNull();
        expect(welcome.hasDismissedCurrentWelcome()).toBe(true);
    });
});
