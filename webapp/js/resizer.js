class ResizableViews {
    constructor() {
        this.isResizing = false;
        this.currentDivider = null;
        this.startX = 0;
        this.startY = 0;
        this.startWidths = {};
        this.startHeights = {};

        this.init();
    }

    init() {
        // Add event listeners for all dividers
        const verticalDividers = document.querySelectorAll('.vertical-divider');
        const horizontalDivider = document.querySelector('.horizontal-divider');

        verticalDividers.forEach(divider => {
            divider.addEventListener('mousedown', (e) => this.startResize(e, 'vertical'));
        });

        if (horizontalDivider) {
            horizontalDivider.addEventListener('mousedown', (e) => this.startResize(e, 'horizontal'));
        }

        // Global mouse events
        document.addEventListener('mousemove', (e) => this.resize(e));
        document.addEventListener('mouseup', () => this.stopResize());

        // Prevent text selection during resize
        document.addEventListener('selectstart', (e) => {
            if (this.isResizing) {
                e.preventDefault();
            }
        });
    }

    startResize(e, direction) {
        e.preventDefault();
        this.isResizing = true;
        this.currentDivider = e.target;
        this.direction = direction;
        this.startX = e.clientX;
        this.startY = e.clientY;

        // Add active class for visual feedback
        this.currentDivider.classList.add('active');

        // Store initial dimensions
        if (direction === 'vertical') {
            this.storeVerticalDimensions();
        } else {
            this.storeHorizontalDimensions();
        }

        // Change cursor for the entire document
        document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
    }

    storeVerticalDimensions() {
        const container = this.currentDivider.parentElement;
        const views = container.querySelectorAll('.view');

        views.forEach((view, index) => {
            this.startWidths[index] = view.offsetWidth;
        });
    }

    storeHorizontalDimensions() {
        const topRow = document.querySelector('.top-row');
        const bottomRow = document.querySelector('.bottom-row');

        this.startHeights = {
            top: topRow.offsetHeight,
            bottom: bottomRow.offsetHeight
        };
    }

    resize(e) {
        if (!this.isResizing) return;

        e.preventDefault();

        if (this.direction === 'vertical') {
            this.resizeVertical(e);
        } else {
            this.resizeHorizontal(e);
        }
    }

    resizeVertical(e) {
        const deltaX = e.clientX - this.startX;
        const container = this.currentDivider.parentElement;
        const views = container.querySelectorAll('.view');

        if (views.length !== 2) return;

        const leftView = views[0];
        const rightView = views[1];

        const containerWidth = container.offsetWidth;
        const dividerWidth = 4; // Fixed divider width
        const availableWidth = containerWidth - dividerWidth;

        const leftStartWidth = this.startWidths[0];
        const rightStartWidth = this.startWidths[1];

        const newLeftWidth = leftStartWidth + deltaX;
        const newRightWidth = rightStartWidth - deltaX;

        // Enforce minimum widths
        const minWidth = 100;
        if (newLeftWidth >= minWidth && newRightWidth >= minWidth) {
            // Calculate flex-grow values based on the ratio of each view
            const totalWidth = newLeftWidth + newRightWidth;
            const leftFlex = newLeftWidth / totalWidth;
            const rightFlex = newRightWidth / totalWidth;

            leftView.style.flex = `${leftFlex}`;
            rightView.style.flex = `${rightFlex}`;
        }
    }

    resizeHorizontal(e) {
        const deltaY = e.clientY - this.startY;
        const topRow = document.querySelector('.top-row');
        const bottomRow = document.querySelector('.bottom-row');

        const containerHeight = document.querySelector('.container').offsetHeight;
        const dividerHeight = 4; // Fixed divider height
        const availableHeight = containerHeight - dividerHeight;

        const topStartHeight = this.startHeights.top;
        const bottomStartHeight = this.startHeights.bottom;

        const newTopHeight = topStartHeight + deltaY;
        const newBottomHeight = bottomStartHeight - deltaY;

        // Enforce minimum heights
        const minHeight = 100;
        if (newTopHeight >= minHeight && newBottomHeight >= minHeight) {
            // Calculate flex-grow values based on the ratio of each row
            const totalHeight = newTopHeight + newBottomHeight;
            const topFlex = newTopHeight / totalHeight;
            const bottomFlex = newBottomHeight / totalHeight;

            topRow.style.flex = `${topFlex}`;
            bottomRow.style.flex = `${bottomFlex}`;
        }
    }

    stopResize() {
        if (!this.isResizing) return;

        this.isResizing = false;

        if (this.currentDivider) {
            this.currentDivider.classList.remove('active');
            this.currentDivider = null;
        }

        // Reset cursor and selection
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
    }
}

// Initialize the resizable views when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ResizableViews();
});

// Handle window resize to maintain proportions
window.addEventListener('resize', () => {
    // Optional: Add logic to maintain view proportions on window resize
    // This is a good place to recalculate flex values if needed
});