export const tutorialId = 'draw-new-outlines';
export const tutorialTitle = 'Drawing New Outlines';
export const tutorialOutputDirName = `tutorial-${tutorialId}`;

export const scenes = [
    {
        id: '01-intro',
        cueTitle: 'Drawing New Outlines',
        cueSubtitle: 'Start by studying the existing n',
        narration:
            'Here is a simple way to draw new outlines in Counterpunch. I will start from an existing n on the left, and redraw a new copy beside it so the original shape stays visible while I work.',
        keyOverlay: [],
        minimumHoldMs: 4400,
        silenceAfterMs: 900
    },
    {
        id: '02-draw-lines',
        cueTitle: '1. Draw the Skeleton',
        cueSubtitle: 'Command-click the main on-curve points',
        narration:
            'First, hold Command and click the main on-curve points. On this first pass, I am only building the structure with straight segments, and then I close the contour by clicking back on the first point.',
        keyOverlay: ['⌘'],
        minimumHoldMs: 6200,
        silenceAfterMs: 1200
    },
    {
        id: '03-convert-curves',
        cueTitle: '2. Convert the Needed Segments',
        cueSubtitle: 'Option-click line segments to add handles',
        narration:
            'Now I hold Option and click the line segments that should become curves. Counterpunch inserts the off-curve handles for me, so the straight skeleton quickly turns into a contour that is ready for shaping.',
        keyOverlay: ['⌥'],
        minimumHoldMs: 5600,
        silenceAfterMs: 1000
    },
    {
        id: '04-smooth-points',
        cueTitle: '3. Smooth the Key Nodes',
        cueSubtitle: 'Double-click on-curve points that need continuity',
        narration:
            'Next, I double-click the key on-curve points to make them smooth. That aligns the handles around those nodes and gives the curve a much cleaner starting shape before any fine adjustment.',
        keyOverlay: [],
        minimumHoldMs: 4800,
        silenceAfterMs: 900
    },
    {
        id: '05-adjust-handles',
        cueTitle: '4. Refine the Handles',
        cueSubtitle: 'Drag the off-curves until the redraw matches',
        narration:
            'Finally, I drag the off-curve points until the new contour matches the reference. The moves are small, but they matter. Once the handles are balanced, the duplicate n settles into the same rhythm as the original.',
        keyOverlay: [],
        minimumHoldMs: 7200,
        silenceAfterMs: 1400
    },
    {
        id: '06-wrap',
        cueTitle: 'Core Loop',
        cueSubtitle: 'On-curves, line-to-curve, smooth, refine',
        narration:
            'That is the basic loop for drawing new outlines here: place the on-curves, convert the segments that need curvature, smooth the important nodes, and then refine the handles until the shape locks in.',
        keyOverlay: [],
        minimumHoldMs: 4600,
        silenceAfterMs: 1000
    }
];

export function buildTtsPrompt(scene) {
    return [
        '# AUDIO PROFILE: Counterpunch Tutorial Narrator',
        '## Calm and precise product tutorial voiceover',
        '',
        '## THE SCENE: A concise desktop tutorial for a font editor.',
        'The narrator is clear, measured, and practical.',
        '',
        "### DIRECTOR'S NOTES",
        'Style: Friendly and technical, with no hype.',
        'Pacing: Moderately brisk, clear articulation, short natural pauses between clauses.',
        'Accent: Neutral international English.',
        '',
        '#### TRANSCRIPT',
        scene.narration
    ].join('\n');
}
