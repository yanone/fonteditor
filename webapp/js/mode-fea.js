/**
 * Ace Editor Mode for OpenType Feature Files (.fea)
 * Based on Adobe OpenType Feature File Specification
 *
 * This file is loaded as a standalone script and registers the mode directly with Ace.
 */

(function() {
    'use strict';

    // Wait for Ace to be available
    function initMode() {
        if (typeof ace === 'undefined') {
            console.error('[FEA Mode] Ace Editor not found');
            return;
        }

        try {
            // Get Ace's OOP utilities
            var oop = ace.require('ace/lib/oop');
            var TextMode = ace.require('ace/mode/text').Mode;
            var TextHighlightRules = ace.require('ace/mode/text_highlight_rules').TextHighlightRules;

            // Define highlight rules
            var FeaHighlightRules = function() {
                // Core feature file keywords
                var coreKeywords = (
                    'feature|lookup|script|language|languagesystem|substitute|sub|position|pos|by|from|ignore|lookupflag|markClass|anchor|anchorDef|valueRecordDef|table|include|include_dflt|anon|anonymous|useExtension|subtable|enumerate|enum|reversesub|rsub|cursive|mark|contourpoint|device|nameid|parameters|NULL|required'
                );

                // Table-specific keywords
                var tableKeywords = (
                    'HorizAxis\\.BaseScriptList|HorizAxis\\.BaseTagList|VertAxis\\.BaseScriptList|VertAxis\\.BaseTagList|Attach|GlyphClassDef|LigatureCaretByDev|LigatureCaretByIndex|LigatureCaretByPos|FontRevision|Ascender|CaretOffset|Descender|LineGap|CapHeight|CodePageRange|Panose|TypoAscender|TypoDescender|TypoLineGap|UnicodeRange|Vendor|winAscent|winDescent|XHeight|sizemenuname|VertTypoAscender|VertTypoDescender|VertTypoLineGap|VertAdvanceY|VertOriginY|ElidedFallbackName|ElidedFallbackNameID|DesignAxis|AxisValue|flag|location|ElidableAxisValueName|OlderSiblingFontAttribute|excludeDFLT|includeDFLT'
                );

                // Lookupflag values
                var lookupflagValues = (
                    'RightToLeft|IgnoreBaseGlyphs|IgnoreLigatures|IgnoreMarks|MarkAttachmentType|UseMarkFilteringSet'
                );

                // Language/script keywords
                var languageKeywords = (
                    'exclude_dflt|include_dflt|DFLT|dflt'
                );

                this.$rules = {
                    start: [
                        // Comments - starts with #
                        {
                            token: 'comment.fea',
                            regex: '#.*$'
                        },
                        // Strings in double quotes
                        {
                            token: 'string.fea',
                            regex: '"[^"]*"'
                        },
                        // Numbers (including negative numbers)
                        {
                            token: 'constant.numeric.fea',
                            regex: '-?\\d+'
                        },
                        // Glyph classes (@name)
                        {
                            token: 'variable.fea',
                            regex: '@[a-zA-Z0-9_.]+'
                        },
                        // CIDs (\number)
                        {
                            token: 'constant.character.fea',
                            regex: '\\\\\\d+'
                        },
                        // Anchors <anchor ...>
                        {
                            token: 'keyword.control.fea',
                            regex: '<anchor',
                            next: 'anchor'
                        },
                        // Value records <...>
                        {
                            token: 'keyword.control.fea',
                            regex: '<(?=\\s*-?\\d)',
                            next: 'valuerecord'
                        },
                        // Device tables
                        {
                            token: 'keyword.control.fea',
                            regex: '<device',
                            next: 'device'
                        },
                        // Other angle brackets
                        {
                            token: 'keyword.operator.fea',
                            regex: '[<>]'
                        },
                        // Core keywords (bold purple)
                        {
                            token: 'keyword.fea',
                            regex: '\\b(' + coreKeywords + ')\\b'
                        },
                        // Table keywords (bold blue) - need to escape dots in regex
                        {
                            token: 'keyword.other.fea',
                            regex: '\\b(' + tableKeywords.replace(/\\/g, '\\\\') + ')\\b'
                        },
                        // Lookupflag values (bold cyan)
                        {
                            token: 'support.function.fea',
                            regex: '\\b(' + lookupflagValues + ')\\b'
                        },
                        // Language keywords (bold orange)
                        {
                            token: 'keyword.control.fea',
                            regex: '\\b(' + languageKeywords + ')\\b'
                        },
                        // Block delimiters
                        {
                            token: 'keyword.operator.fea',
                            regex: '[{};\\[\\]()=\',-]'
                        }
                    ],
                    anchor: [
                        {
                            token: 'keyword.control.fea',
                            regex: '>',
                            next: 'start'
                        },
                        {
                            token: 'constant.numeric.fea',
                            regex: '-?\\d+'
                        },
                        {
                            token: 'keyword.fea',
                            regex: '\\bcontourpoint\\b'
                        },
                        {
                            token: 'constant.language.fea',
                            regex: '\\bNULL\\b'
                        },
                        {
                            defaultToken: 'text.fea'
                        }
                    ],
                    valuerecord: [
                        {
                            token: 'keyword.operator.fea',
                            regex: '>',
                            next: 'start'
                        },
                        {
                            token: 'constant.numeric.fea',
                            regex: '-?\\d+'
                        },
                        {
                            defaultToken: 'text.fea'
                        }
                    ],
                    device: [
                        {
                            token: 'keyword.control.fea',
                            regex: '>',
                            next: 'start'
                        },
                        {
                            token: 'constant.numeric.fea',
                            regex: '-?\\d+'
                        },
                        {
                            token: 'constant.language.fea',
                            regex: '\\bNULL\\b'
                        },
                        {
                            defaultToken: 'text.fea'
                        }
                    ]
                };

                this.normalizeRules();
            };

            FeaHighlightRules.metaData = {
                fileTypes: ['fea'],
                name: 'FEA'
            };

            oop.inherits(FeaHighlightRules, TextHighlightRules);

            // Define the mode
            var Mode = function() {
                this.HighlightRules = FeaHighlightRules;
            };

            oop.inherits(Mode, TextMode);

            Mode.prototype.$id = 'ace/mode/fea';

            // Register the mode with Ace
            ace.define('ace/mode/fea_highlight_rules', ['require', 'exports', 'module'], function(require, exports, module) {
                exports.FeaHighlightRules = FeaHighlightRules;
            });

            ace.define('ace/mode/fea', ['require', 'exports', 'module'], function(require, exports, module) {
                exports.Mode = Mode;
            });

            console.log('[FEA Mode] Successfully registered with Ace Editor');

        } catch (e) {
            console.error('[FEA Mode] Failed to initialize:', e);
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMode);
    } else {
        // DOM already loaded, init immediately
        initMode();
    }
})();
