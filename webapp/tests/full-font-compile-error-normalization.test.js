const {
    extractFeatureIssuesFromCompilationError
} = require('../js/feature-error-parser');

describe('full compile error normalization', () => {
    test('extracts human-readable feature message from worker error string', () => {
        const error = new Error(
            'Compilation failed: FeatureParsing([FeatureError { message: "\'feaure\' Not valid in a feature block", span: 1648..1654, is_error: true }])'
        );

        const issues = extractFeatureIssuesFromCompilationError(error);
        const humanReadableMessage =
            issues.length > 0
                ? `${issues[0].category}: ${issues[0].message}`
                : error.message;

        expect(humanReadableMessage).toBe(
            "FeatureParsing: 'feaure' Not valid in a feature block"
        );
    });
});
