# Language Packs

## Purpose

Language Packs make language- and style-specific font engineering extensible.
They let Counterpunch, foundries, and teams such as Google Fonts provide their
own character data, glyph construction knowledge, OpenType generation, and
glyph filters as Python plugins.

This proposal deliberately avoids a single monolithic replacement for
Glyphs.app's `GlyphData.xml`. Unicode provides the universal baseline; packs
add focused knowledge, alternatives, and explicit overrides.

For a plain-language summary of the whole system, see [TLDR](#tldr) at the
bottom of this document.

## How This Replaces GlyphData.xml

`GlyphData.xml` centralizes many repeated per-glyph facts in one database. A
Language Pack replaces that repetition with a small number of general rules,
versioned lookup artifacts, and explicit exceptions. For example, Unicode can
derive the name and decomposition of `U+00E1` as `aacute` built from `a` and
`acute`; a generic mark rule can propose `top` and `_top` anchors; and a
fractions generator can derive its OpenType feature code from the glyphs that
actually exist in the font. A pack writes an override only when a script,
style, or foundry policy differs from that baseline, such as the preferred
shape of `Ŋ` or a connected-script joining rule.

The potential authoring reduction is substantial, though the exact result must
be measured with real packs. As an illustrative Latin example, 250 encoded
accented glyphs that follow Unicode decomposition could be covered by generic
naming and composition rules plus perhaps 10 to 25 explicit exceptions,
instead of 250 hand-maintained glyph records: roughly 90% fewer
glyph-specific definitions. The same principle lets one fractions generator
produce a handful of ordered feature-code entries from the font's glyph set,
instead of maintaining many separate feature snippets. The goal is not to hide
knowledge in automation, but to make the common cases inspectable and inferred
while keeping exceptions local, visible, and owned by the relevant pack.

## The Simple Model

A Python distribution can expose one or more plugins. A **Language Pack** is a
named, versioned collection of those plugins.

The application owns:

- plugin discovery, activation, and version recording in the font
- conflict resolution and clear diagnostics
- change batching, scheduling, and compilation
- durable font data, history, and user ownership

Language Pack authors own linguistic and stylistic knowledge:

- character sets and language coverage
- glyph identity and naming rules
- construction and anchor recipes
- generated OpenType feature code
- glyph filters

This division keeps plugins expressive without making each pack a fork of the
editor's core behavior.

## What A Pack Can Provide

One package may provide any combination of the following plugin roles:

| Role                 | Responsibility                                                                          |
| -------------------- | --------------------------------------------------------------------------------------- |
| Character database   | Characters, Unicode sequences, unencoded glyph concepts, aliases, and language coverage |
| Glyph-name resolver  | Unicode-to-name and name-to-glyph-identity lookup                                       |
| Composition provider | Candidate component recipes, starting with Unicode decomposition and adding overrides   |
| Anchor provider      | Initial anchor recipes and placement expressions                                        |
| Feature generator    | Regenerable OpenType feature-code blocks                                                |
| Glyph filter         | A code-driven filter for glyph views, grouping, or analysis                             |

Hyperglot and `gflanguages` are natural sources for character-database
providers. A provider contributes query results; it does not copy an entire
external database into each font.

## Plugin Manager And Catalogue

Counterpunch includes a Plugin Manager for finding, installing, and activating
Language Packs. Users search by the same two terms used throughout this
document:

- **Plugin role:** for example, `Feature generator`, `Composition provider`,
  or `Glyph filter`.
- **Capability key:** for example, `feature:fractions`,
  `composition:latin:default`, or `anchors:arabic:defaults`.

A search for “fractions feature” therefore finds packs containing a **Feature
generator** that provides `feature:fractions`. Results can also be narrowed by
script, language coverage, provider, version, and whether the capability is
additive or replaces a baseline capability.

The catalogue is built from public GitHub repositories that declare the same
Python plugin hooks Counterpunch uses after installation in Pyodide. Each pack
publishes machine-readable metadata describing its package identity, version,
plugin roles, provided and replaced capability keys, dependencies, and
supported scripts or languages.

GitHub discovery creates a searchable **catalogue entry**; it does not execute
code. A pack release contains a normal Python wheel, its manifest, and a
resolved lock file naming every required pure-Python or Pyodide-compatible
wheel. Authors publish these release assets on GitHub, with no PyPI account or
separate package-registry workflow required.

On the first installation of a GitHub release, Counterpunch downloads,
validates, hash-checks, and mirrors the pack wheel and its complete locked
dependency closure to Counterpunch storage. Only after this capture succeeds
does Counterpunch install the exact mirrored wheels into Pyodide and load their
declared hooks. A font records the mirrored artifact IDs and hashes, together
with the GitHub repository and release as provenance. It does not rely on a
future GitHub or dependency-index lookup to reopen or regenerate the font.

The mirror is a reproducibility guarantee, not an endorsement of the pack.
Before a release has been mirrored it may be discoverable from GitHub; after
mirroring it is eligible to become a durable font dependency. Counterpunch
installs the locked wheel list with dependency resolution disabled, so the
recorded environment is deterministic. Changing the active pack set recreates
the Pyodide worker rather than replacing imported packages in a running Python
environment.

Whether the catalogue queries the GitHub API live or uses a pre-rendered,
periodically refreshed database remains an open delivery decision. Both must
produce the same catalogue metadata and search behavior; a pre-rendered index
may be preferable for speed, availability, and stable results.

## Plugin Settings

Any plugin type may declare user-choosable settings. This includes character
databases, composition providers, anchor providers, feature generators, and
glyph filters. A plugin declares the setting's label, type, allowed values,
default, and help text; Counterpunch presents an appropriate control and
persists the selected value in the font's active Language Pack configuration.

Settings express intentional design policy that cannot reliably be inferred
from glyph names, Unicode values, or the outlines already present in a font.
They are available to the plugin's normal hooks, including OpenType feature
code generation.

For example, the Unicode character `Ŋ` is used in both Sami and several
African languages, but the preferred glyph shape differs. A language plugin
can declare a setting such as:

```text
Primary design target
  Sami
  African languages
```

The selected target tells a `locl` feature generator which shape the font
treats as its default and which language-specific substitutions it must
generate. Unicode alone cannot make that decision: the relevant design intent
exists before the `locl` code and must be supplied by the user.

Settings belong to the plugin instance, not to a generated feature-code block.
Changing one is a committed font edit. Counterpunch reruns only the plugins
whose declared setting changed and then applies the normal batched rebuild and
compilation rules. The font records the setting value together with the
plugin's identity and version so the result remains reproducible.

## Packages, Profiles, And Capabilities

Installing a pack only makes it available. A font records which packs are
active, their exact versions, and their configuration so its behavior is
reproducible.

Some capabilities are additive. Others express one exclusive policy choice.
A font therefore chooses a **profile** for each relevant scope, such as Latin
or Arabic.

```text
Latin profile
  baseline: Counterpunch Latin
  composition style: Foundry Connected Script Latin
  additions: Fractions, IPA coverage
```

Each provision has a stable capability key. Feature tags alone are not enough:
many independent sources may validly emit `liga`, `calt`, or `locl`.

```text
composition:latin:default
anchors:latin:defaults
feature:fractions
feature:connected-script-joining
```

Rules:

- Additive capabilities coexist.
- An exclusive capability requires the user to select one provider.
- A pack may explicitly replace a named capability, but never silently replace
  another pack merely because both cover the same script or use the same
  OpenType tag.
- The application reports unresolved conflicts rather than guessing.

This lets a foundry replace the baseline Latin fraction generator while
retaining baseline character data, composition rules, anchor recipes, and
other generators. It also lets a connected-script, blackletter, Antiqua,
Naskh, Ruqaa, or Nastaleeq pack replace only the construction and feature
policies that differ, while sharing useful additions such as fractions.

### Example: Replacing Fractions Only

Counterpunch Latin provides a baseline `feature:fractions` generator. A user
may install and select **Fractions Fever 2** as the provider for that same
capability:

```text
Before selection
  feature:fractions -> Counterpunch Latin / baseline fractions

After selection
  feature:fractions -> Fractions Fever 2 / replaces baseline fractions
  composition:latin:default -> Counterpunch Latin
  anchors:latin:defaults -> Counterpunch Latin
  feature:mark-positioning -> Counterpunch Latin
```

Fractions Fever 2 replaces only the generated blocks belonging to
`feature:fractions`. It does not remove the baseline Latin pack, touch manual
OpenType feature code, or replace unrelated baseline feature generators. Its
own blocks are the ones it may rebuild after relevant glyph operations.

### Style Examples

These are examples of how profiles can share a script's baseline while making
their different construction and OpenType policies explicit. They are
illustrative, not prescriptions for every typeface.

#### Latin

All three profiles can share Latin character coverage, Unicode naming,
language-specific character sets, and an optional fractions generator. They
need not share the same construction or substitution policy.

| Profile          | Typical composition and anchor policy                                                                           | Typical generated feature policy                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Antiqua          | Canonical Unicode decomposition and familiar `top`, `bottom`, and mark anchors                                  | Standard mark positioning, common ligatures, and optional fractions                                            |
| Blackletter      | May add historical forms, long-`s` conventions, and different recipes or anchors for tightly joined forms       | Historical ligatures and context-sensitive form selection alongside ordinary mark positioning                  |
| Connected script | May use `#entry` and `#exit` anchors, or style-specific join anchors, for letters that connect in authored text | Joining and connection logic, commonly in `calt` and `liga`, while retaining shared fractions or mark features |

The connected-script profile can replace
`composition:latin:default` and add `feature:connected-script-joining` without
replacing `feature:fractions`. A blackletter profile can make a different
selection for composition while retaining the same shared character database.

#### Arabic

Naskh, Ruqaa, and Nastaleeq can share Arabic character coverage, Unicode
identity, basic joining classes, and language metadata. Their visual grammar
can require distinct construction, anchor defaults, and feature generation.

| Profile   | Typical composition and anchor policy                                                                                     | Typical generated feature policy                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Naskh     | Conventional mark attachment and a relatively regular baseline for connected forms                                        | Standard joining-form selection, mark positioning, and language-specific substitutions                      |
| Ruqaa     | Compact, abbreviated forms may need style-specific alternate recipes and tighter mark-placement defaults                  | Contextual alternates and form selection tailored to compact written shapes                                 |
| Nastaleeq | Sloped writing and stacked forms may call for different anchor families, component recipes, and mark-placement strategies | Contextual form selection and positioning for a highly context-dependent, vertically arranged writing style |

Selecting a Nastaleeq composition profile does not discard shared Arabic
character data. It replaces only the named exclusive capabilities, such as
`composition:arabic:default` and an Arabic joining generator, while unrelated
additive generators remain available.

## Character Identity And Glyph Naming

A glyph identity has one authoritative glyph name, an optional Unicode
sequence, and provider provenance. Encoded characters, Unicode sequences, and
unencoded glyph concepts are related but distinct. The font does not maintain
glyph-name aliases: search terms and imported naming conventions are catalogue
or import metadata, not additional names for a glyph.

Unicode decomposition is the default source of component recipes. Packs can
add, replace, or rank recipes when Unicode is insufficient, including
script-specific forms, alternative component order, or unencoded glyphs.

[context-glyphdata](https://github.com/yanone/context-glyphdata), a package
named when the editor was still called Context, supplies an algorithmic
Unicode-to-name baseline. Every plugin ships a versioned glyph-identity
artifact; an artifact is empty when that plugin contributes no glyph
identities. The artifact provides two maps:

```text
glyph name      -> glyph identity and properties
Unicode sequence -> preferred glyph identity and glyph name
```

When a font's active packs or profiles change, Counterpunch builds one resolved
glyph-identity index by layering the core artifact and the active plugin
artifacts in the font's persisted priority order. The first matching entry is
authoritative in both maps. There is no runtime candidate resolution.

This gives the same result whether a user enters a glyph name or creates a
glyph from Unicode. If a profile overrides `alef-ar`, it also supplies the
corresponding Unicode-to-name policy. A plugin cannot override only one lookup
direction and leave the two directions inconsistent.

Conflicting active artifacts must be ordered explicitly by the selected
profiles or reported as a conflict. The resolved index is the normal lookup
mechanism for glyph creation, name completion, search, and preview; it is not
a second editable glyph database.

## Composition And Anchors

The editor remains responsible for generic automatic component alignment.
Packs contribute recipes, not a competing composition engine.

A composition recipe can request components and the anchors they need:

```text
napostrophe
  components: n + apostrophe
  anchors: n.apostrophe + apostrophe._apostrophe
  fallback: n.topleft + apostrophe._topleft
```

Anchor providers define **initial** anchor placement with expressions, for
example:

```text
apostrophe: x = left + 10% of width, y = xHeight
ogonek:     x = right - 12% of width, y = baseline - 8%
top:        x = center, y = ascender
```

Expressions may use actual bounds, font metrics, and a stable virtual bounding
box when the glyph is empty. A virtual box makes it possible to create useful
anchors before outlines or components exist.

Anchors are permanent ordinary font data once created:

- They have no generator ownership and are never automatically removed or
  moved.
- The user may explicitly generate missing anchors or regenerate anchors for
  selected glyphs.
- Regeneration previews additions, repositioning, and preservation of existing
  anchors.
- The safe default adds missing anchors only; moving or replacing existing
  anchor families is an explicit action.

## Generated OpenType Feature Code

Feature generators create readable OpenType feature code in FEA syntax. Each
block stores provenance in the font model:

```text
origin: generated
generator: org.foundry.connected-latin/v2
block: joining-forms
capability: feature:connected-script-joining
feature tag: calt
placement: after common-classes
```

Two identifiers serve different purposes:

- **Capability** is the named service a provider offers to the font, such as
  `feature:connected-script-joining` or `feature:fractions`. It is the unit a
  user selects or replaces in a profile. Selecting Fractions Fever 2 for
  `feature:fractions`, for example, replaces the baseline provider for that
  capability only.
- **Block** is one stable, generator-owned piece of OpenType feature code, such
  as `joining-forms`. A block equals one ordered OpenType feature-code entry in
  the font object's feature-code list. A generator may create several blocks
  for one capability. Blocks have their own feature tags, placement
  constraints, and rebuild ownership. The block identifier is stable within its
  generator; it is what lets that generator update or remove precisely its own
  feature-code entry on a rebuild.

For example, a connected-script generator selected for
`feature:connected-script-joining` could produce these blocks:

```text
common-classes     -> shared class definitions
joining-forms      -> calt rules for contextual connections
joining-ligatures  -> liga rules for required joined ligatures
```

All three blocks fulfil one selected capability, but they must remain separate
because they may be ordered differently and may change independently. Their
`calt` and `liga` tags describe the OpenType tables they contribute to; those
tags do not identify their provider or ownership.

Likewise, the Fractions Fever 2 provider selected for `feature:fractions` may
produce `fraction-classes`, `numerator-substitutions`,
`denominator-substitutions`, and `fraction-rules` blocks. Replacing the
fractions capability switches that group of blocks to Fractions Fever 2, while
leaving the connected-script blocks and every unrelated capability intact.

The generator may completely replace its own blocks on a rebuild. It cannot
remove manual OpenType feature code, another generator's block, or every block
with the same four-letter tag.

Users can convert a generated block to manual OpenType feature code. That
preserves the code, removes generator ownership, and excludes it from future
regeneration.

Feature order is expressed with stable `before` and `after` block constraints,
then resolved as a dependency order. A cycle or conflict is shown to the user;
the app must not silently choose an arbitrary order.

## Efficient And Correct Rebuilds

Generation must run after committed, batched edits, never repeatedly during an
interactive operation. A generated feature change only compiles when its
persisted output actually differs.

Plugins have two levels of scheduling control:

1. **Static subscriptions** are a cheap host-side filter, such as glyph
   creation, rename, Unicode change, component change, or anchor change.
2. An optional `needsRebuild(changeBatch, fontView)` receives a compact,
   read-only summary and decides whether its expensive work is needed.

The change summary identifies affected glyphs, fields, anchor names, old and
new identities, active profiles, and existing generator output fingerprints.
It can support a skip, a scoped rebuild, or a deferred rebuild.

The host batches matching plugins, runs each at most once per committed batch,
marks generated edits with their origin to prevent feedback loops, and records
input/output fingerprints for development diagnostics. A plugin that cannot
state a narrow dependency can subscribe conservatively.

The same model applies to glyph filters: they declare meaningful refresh
triggers and may refine them through `needsRebuild`, rather than rerunning on
every change.

## Provider And User Experience

Plugin authoring should be inspectable rather than magical. Providers need a
small manifest, typed role-specific APIs, read-only font and change views,
fixture-based tests, and a local inspector showing inputs, rebuild reasons,
duration, output, and errors.

Users need to see the distinction between:

- **Installed:** available in Pyodide.
- **Active:** contributes data or tools to this font.
- **Selected:** supplies an exclusive policy for a profile scope.

Every search result, recipe, anchor-generation action, and generated feature
block should be explainable: which provider produced it, why it applied, what
it replaces, and what a regeneration will change.

## Core Principles

- Unicode is the baseline; packs provide focused knowledge and overrides.
- Feature tags do not define ownership; stable capability and block IDs do.
- Generated OpenType feature code is disposable by its owner; manual OpenType
  feature code is never touched automatically.
- Anchors become user-owned, permanent font data at creation time.
- Profile selection resolves exclusive stylistic policies; additive capabilities
  coexist.
- The host guarantees deterministic resolution, batching, provenance, and
  protection of user work.

## TLDR

A **Language Pack** is an installable Python package that teaches
Counterpunch about a language, script, writing style, or font-engineering
task. A font can activate several packs and select one provider where a policy
must be exclusive, while unrelated additions continue to work together.

The plugin types work together as follows:

- A **Character database** says which encoded characters, Unicode sequences,
  and unencoded glyph concepts matter for a language or coverage set.
- A **Glyph-name resolver** supplies its versioned glyph-identity artifact.
  Counterpunch combines active artifacts in the font's saved priority order so
  a glyph name and a Unicode sequence resolve to one authoritative identity.
- A **Composition provider** uses Unicode decomposition where possible and
  adds explicit recipes where it is not enough, such as a style-specific or
  script-specific composite.
- An **Anchor provider** supplies initial anchor-placement rules for those
  glyphs and components. It can use real or virtual bounds, but created
  anchors immediately become ordinary, permanent font data.
- A **Feature generator** turns the relevant glyphs, the selected pack
  settings, and the font's state into ordered OpenType feature-code entries.
  Its user-selectable capability, such as `feature:fractions`, says what can
  be replaced; each generated block is one entry that its generator can update
  later without touching manual code or another generator's entries.
- A **Glyph filter** provides a code-driven view or grouping of the font. Like
  feature generators, it declares when it needs to refresh so it does not run
  on every edit.

Plugin settings provide deliberate choices that cannot be inferred from
Unicode or outlines alone, such as whether `Ŋ` follows a Sami or African
design target. Counterpunch saves those settings with the active pack versions
and reruns only the affected plugins after an edit. The result is a modular,
inspectable alternative to one global `GlyphData.xml`: common knowledge is
inferred from reusable rules, while script-, style-, and foundry-specific
exceptions remain explicit and replaceable.
