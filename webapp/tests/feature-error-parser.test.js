const {
    extractFeatureIssuesFromCompilationError,
    extractPrimaryFeatureIssue
} = require('../js/feature-error-parser');

describe('feature-error-parser', () => {
    test('parses Rust debug-style FeatureParsing string', () => {
        const error =
            'Compilation failed: FeatureParsing([FeatureError { message: "\'feture\' Not valid in a feature block", span: 1606..1612, is_error: true }])';

        const issues = extractFeatureIssuesFromCompilationError(error);

        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0]).toEqual(
            expect.objectContaining({
                category: 'FeatureParsing',
                message: "'feture' Not valid in a feature block",
                start: 1606,
                end: 1612,
                isError: true
            })
        );
    });

    test('parses structured FeatureParsing payload', () => {
        const payload = {
            FeatureParsing: [
                {
                    message: "'feture' Not valid in a feature block",
                    span: { start: 1606, end: 1612 },
                    is_error: true
                }
            ]
        };

        const issues = extractFeatureIssuesFromCompilationError(payload);

        expect(issues).toContainEqual(
            expect.objectContaining({
                category: 'FeatureParsing',
                message: "'feture' Not valid in a feature block",
                start: 1606,
                end: 1612,
                isError: true
            })
        );
    });

    test('prefers real errors over warnings for primary issue', () => {
        const payload = {
            FeatureParsing: [
                {
                    message: 'This is only a warning',
                    span: { start: 100, end: 110 },
                    is_error: false
                },
                {
                    message: 'Actual compilation error',
                    span: { start: 300, end: 310 },
                    is_error: true
                }
            ]
        };

        const issue = extractPrimaryFeatureIssue(payload);

        expect(issue).toEqual(
            expect.objectContaining({
                message: 'Actual compilation error',
                start: 300,
                end: 310,
                isError: true
            })
        );
    });
});
