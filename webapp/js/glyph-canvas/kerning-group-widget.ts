export type KerningPairSide = 'first' | 'second';

export type KerningGroupChip = {
    pairSide: KerningPairSide;
    kind: 'glyph' | 'group';
    name: string;
    key: string;
    label: string;
    removable: boolean;
    participates?: boolean;
    compatible?: boolean;
    active?: boolean;
};

export type KerningGroupWidgetSide = {
    pairSide: KerningPairSide;
    title: string;
    glyphName: string | null;
    chips: KerningGroupChip[];
};

export type KerningGroupWidgetOptions = {
    startSide: KerningGroupWidgetSide;
    endSide: KerningGroupWidgetSide;
    center: HTMLElement;
    isRTL?: boolean;
    onSelectChip?: (chip: KerningGroupChip) => void;
    onRemoveChip?: (chip: KerningGroupChip) => void;
    onAdd?: (pairSide: KerningPairSide, glyphName: string | null) => void;
};

export function collectKerningGroupMemberships(
    groups: Record<string, string[]> | undefined,
    glyphName: string | null
): string[] {
    if (!groups || !glyphName) {
        return [];
    }

    const memberships: string[] = [];
    for (const [groupName, members] of Object.entries(groups)) {
        if (!Array.isArray(members) || !members.includes(glyphName)) {
            continue;
        }
        memberships.push(groupName);
    }

    memberships.sort((left, right) => left.localeCompare(right));
    return memberships;
}

export function formatKerningOperandLabel(
    kind: 'glyph' | 'group',
    name: string
): string {
    return kind === 'group' ? `@${name}` : name;
}

export function formatKerningGroupKindLabel(
    pairSide: KerningPairSide,
    isRTL: boolean = false
): 'LKG' | 'RKG' {
    return (pairSide === 'first') === !isRTL ? 'RKG' : 'LKG';
}

export function formatKerningGroupKindTooltip(
    pairSide: KerningPairSide,
    isRTL: boolean = false
): string {
    return formatKerningGroupKindLabel(pairSide, isRTL) === 'LKG'
        ? 'Left kerning group'
        : 'Right kerning group';
}

export function formatTextModeKerningSideTitle(
    pairSide: KerningPairSide,
    isRTL: boolean = false
): string {
    const role = pairSide === 'first' ? 'First' : 'Second';
    return `${role} (${formatKerningGroupKindLabel(pairSide, isRTL)})`;
}

export function buildGlyphKerningGroupChips(
    pairSide: KerningPairSide,
    glyphName: string,
    groupNames: string[],
    includeGlyphName: boolean = true
): KerningGroupChip[] {
    const groupChips = groupNames.map((groupName) => ({
        pairSide,
        kind: 'group' as const,
        name: groupName,
        key: `@${groupName}`,
        label: formatKerningOperandLabel('group', groupName),
        removable: true
    }));
    if (!includeGlyphName) {
        return groupChips;
    }

    return [
        {
            pairSide,
            kind: 'glyph',
            name: glyphName,
            key: glyphName,
            label: formatKerningOperandLabel('glyph', glyphName),
            removable: false
        },
        ...groupChips
    ];
}

function createSide(
    side: KerningGroupWidgetSide,
    options: KerningGroupWidgetOptions
): HTMLElement {
    const sideElement = document.createElement('div');
    sideElement.className = 'glyph-kerning-side';

    const header = document.createElement('span');
    header.className = 'glyph-property-control-label';
    header.dataset.kerningSide = side.pairSide;
    header.textContent = side.title;
    header.title = formatKerningGroupKindTooltip(side.pairSide, options.isRTL);
    sideElement.appendChild(header);

    const pills = document.createElement('div');
    pills.className = 'glyph-kerning-pills';

    for (const chip of side.chips) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'glyph-filter-legend-item glyph-kerning-pill';
        button.dataset.kerningSide = chip.pairSide;
        button.dataset.kerningKey = chip.key;
        button.title = chip.label;

        const label = document.createElement('span');
        label.className = 'glyph-filter-legend-label glyph-kerning-pill-label';
        label.textContent = chip.label;
        button.appendChild(label);

        button.classList.toggle(
            'glyph-kerning-pill-base',
            chip.kind === 'glyph'
        );
        if (chip.participates) {
            button.classList.add('glyph-kerning-pill-participates');
        }
        if (chip.compatible && !chip.active) {
            button.classList.add('selected-glyph-group');
        }
        if (chip.active) {
            button.classList.add('active');
        }

        if (chip.removable) {
            const removeBadge = document.createElement('span');
            removeBadge.className = 'glyph-kerning-pill-remove';
            removeBadge.title = side.glyphName
                ? `Remove kerning group "${chip.name}" from glyph "${side.glyphName}"`
                : `Remove kerning group "${chip.name}"`;
            removeBadge.setAttribute('aria-hidden', 'true');

            const removeIcon = document.createElement('span');
            removeIcon.className =
                'material-symbols-outlined glyph-kerning-pill-remove-icon';
            removeIcon.textContent = 'close';
            removeIcon.setAttribute('aria-hidden', 'true');
            removeBadge.appendChild(removeIcon);
            button.appendChild(removeBadge);
        }

        button.addEventListener('click', (event) => {
            const removeTarget = (event.target as HTMLElement | null)?.closest(
                '.glyph-kerning-pill-remove'
            );
            if (removeTarget) {
                event.preventDefault();
                options.onRemoveChip?.(chip);
                return;
            }

            options.onSelectChip?.(chip);
        });

        pills.appendChild(button);
    }

    if (!side.chips.some((chip) => chip.kind === 'group')) {
        const canAdd = Boolean(side.glyphName);
        const placeholder = document.createElement(canAdd ? 'button' : 'span');
        if (canAdd) {
            (placeholder as HTMLButtonElement).type = 'button';
        }
        placeholder.className =
            'glyph-kerning-pill glyph-kerning-pill-placeholder';
        placeholder.dataset.kerningSide = side.pairSide;
        placeholder.textContent = '+';
        placeholder.title = canAdd
            ? `Add kerning group to glyph "${side.glyphName}"`
            : 'Add kerning group';
        if (canAdd) {
            placeholder.addEventListener('click', () => {
                options.onAdd?.(side.pairSide, side.glyphName);
            });
        }
        pills.appendChild(placeholder);
    }

    sideElement.appendChild(pills);
    return sideElement;
}

export function renderKerningGroupWidget(
    parent: HTMLElement,
    options: KerningGroupWidgetOptions
): HTMLElement {
    const content = document.createElement('div');
    content.className =
        'glyph-property-panel-content glyph-kerning-panel-content';

    const shell = document.createElement('div');
    shell.className = 'glyph-kerning-panel-shell';

    const center = document.createElement('div');
    center.className = 'glyph-kerning-center';
    center.appendChild(options.center);

    shell.appendChild(createSide(options.startSide, options));
    shell.appendChild(center);
    shell.appendChild(createSide(options.endSide, options));

    content.appendChild(shell);
    parent.appendChild(content);
    return content;
}
