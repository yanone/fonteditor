use read_fonts::tables::glyf::Glyph;
use read_fonts::types::{GlyphId, NameId};
use read_fonts::{FontRef, TableProvider};
use serde::Serialize;
use serde_json::{json, Value};
use std::fmt;

pub const MAX_QUERY_COUNT: usize = 64;
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_LIST_SIZE: usize = 256;
pub const MAX_RAW_BYTES: usize = 4096;
pub const MAX_RECURSION_DEPTH: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FontPath {
    UnitsPerEm,
    NumGlyphs,
    Name {
        platform_id: u16,
        encoding_id: u16,
        language_id: u16,
        name_id: u16,
    },
    VariationAxis {
        index: usize,
        field: Option<VariationAxisField>,
    },
    HorizontalMetric {
        glyph_id: u16,
        field: HorizontalMetricField,
    },
    CmapGlyph {
        codepoint: u32,
    },
    GlyphOutline {
        glyph_id: u16,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VariationAxisField {
    Tag,
    MinValue,
    DefaultValue,
    MaxValue,
    Flags,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HorizontalMetricField {
    AdvanceWidth,
    SideBearing,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct InspectionResult {
    pub values: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InspectionError {
    QueryLimitExceeded,
    OutputLimitExceeded,
    ListLimitExceeded,
    RawDataLimitExceeded,
    RecursionLimitExceeded,
    InvalidPath(String),
    InvalidValue(String),
    Font(String),
}

impl fmt::Display for InspectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::QueryLimitExceeded => formatter.write_str("inspection query limit exceeded"),
            Self::OutputLimitExceeded => formatter.write_str("inspection output limit exceeded"),
            Self::ListLimitExceeded => formatter.write_str("inspection list limit exceeded"),
            Self::RawDataLimitExceeded => formatter.write_str("inspection raw data limit exceeded"),
            Self::RecursionLimitExceeded => formatter.write_str("inspection recursion limit exceeded"),
            Self::InvalidPath(path) => write!(formatter, "invalid font path: {path}"),
            Self::InvalidValue(value) => write!(formatter, "invalid font path value: {value}"),
            Self::Font(error) => write!(formatter, "font inspection failed: {error}"),
        }
    }
}

impl std::error::Error for InspectionError {}

pub fn parse_path(path: &str) -> Result<FontPath, InspectionError> {
    let parts: Vec<&str> = path.split('/').skip(1).collect();
    if path.is_empty() || !path.starts_with('/') {
        return Err(InspectionError::InvalidPath(path.to_owned()));
    }
    if parts.len() > MAX_RECURSION_DEPTH {
        return Err(InspectionError::RecursionLimitExceeded);
    }

    match parts.as_slice() {
        ["tables", "head", "unitsPerEm"] => Ok(FontPath::UnitsPerEm),
        ["tables", "maxp", "numGlyphs"] => Ok(FontPath::NumGlyphs),
        ["tables", "name", "records", platform, encoding, language, name, "string"] => {
            Ok(FontPath::Name {
                platform_id: parse_u16_segment(platform, "platformID")?,
                encoding_id: parse_u16_segment(encoding, "encodingID")?,
                language_id: parse_u16_segment(language, "languageID")?,
                name_id: parse_u16_segment(name, "nameID")?,
            })
        }
        ["tables", "fvar", "axes", index] => Ok(FontPath::VariationAxis {
            index: parse_list_index(index, "index")?,
            field: None,
        }),
        ["tables", "fvar", "axes", index, field] => Ok(FontPath::VariationAxis {
            index: parse_list_index(index, "index")?,
            field: Some(parse_variation_axis_field(field)?),
        }),
        ["tables", "hmtx", "metrics", gid, "advanceWidth"] => Ok(FontPath::HorizontalMetric {
            glyph_id: parse_u16_segment(gid, "gid")?,
            field: HorizontalMetricField::AdvanceWidth,
        }),
        ["tables", "hmtx", "metrics", gid, "sideBearing"] => Ok(FontPath::HorizontalMetric {
            glyph_id: parse_u16_segment(gid, "gid")?,
            field: HorizontalMetricField::SideBearing,
        }),
        ["tables", "cmap", codepoint, "gid"] => Ok(FontPath::CmapGlyph {
            codepoint: parse_codepoint(codepoint)?,
        }),
        ["tables", "glyf", gid, "outline"] => Ok(FontPath::GlyphOutline {
            glyph_id: parse_u16_segment(gid, "gid")?,
        }),
        _ => Err(InspectionError::InvalidPath(path.to_owned())),
    }
}

pub fn inspect_font_bytes(
    bytes: &[u8],
    font_index: u32,
    paths: &[FontPath],
) -> Result<InspectionResult, InspectionError> {
    if paths.len() > MAX_QUERY_COUNT {
        return Err(InspectionError::QueryLimitExceeded);
    }

    let font = FontRef::from_index(bytes, font_index)
        .map_err(|error| InspectionError::Font(format!("{error:?}")))?;
    let mut values = Vec::with_capacity(paths.len());

    for path in paths {
        values.push(resolve_path(&font, path)?);
    }

    let result = InspectionResult { values };
    let encoded = serde_json::to_vec(&result)
        .map_err(|error| InspectionError::Font(error.to_string()))?;
    if encoded.len() > MAX_OUTPUT_BYTES {
        return Err(InspectionError::OutputLimitExceeded);
    }
    Ok(result)
}

fn resolve_path(font: &FontRef<'_>, path: &FontPath) -> Result<Value, InspectionError> {
    match path {
        FontPath::UnitsPerEm => Ok(json!(font
            .head()
            .map_err(font_error)?
            .units_per_em())),
        FontPath::NumGlyphs => Ok(json!(font.maxp().map_err(font_error)?.num_glyphs())),
        FontPath::Name {
            platform_id,
            encoding_id,
            language_id,
            name_id,
        } => resolve_name(font, *platform_id, *encoding_id, *language_id, *name_id),
        FontPath::VariationAxis { index, field } => resolve_variation_axis(font, *index, *field),
        FontPath::HorizontalMetric { glyph_id, field } => {
            resolve_horizontal_metric(font, *glyph_id, *field)
        }
        FontPath::CmapGlyph { codepoint } => resolve_cmap(font, *codepoint),
        FontPath::GlyphOutline { glyph_id } => resolve_glyph_outline(font, *glyph_id),
    }
}

fn resolve_name(
    font: &FontRef<'_>,
    platform_id: u16,
    encoding_id: u16,
    language_id: u16,
    name_id: u16,
) -> Result<Value, InspectionError> {
    let name = match font.name() {
        Ok(name) => name,
        Err(_) => return Ok(Value::Null),
    };
    let data = name.string_data();
    let record = name.name_record().iter().find(|record| {
        record.platform_id() == platform_id
            && record.encoding_id() == encoding_id
            && record.language_id() == language_id
            && record.name_id() == NameId::new(name_id)
    });

    let Some(record) = record else {
        return Ok(Value::Null);
    };
    if record.length() as usize > MAX_RAW_BYTES {
        return Err(InspectionError::RawDataLimitExceeded);
    }
    let string = record
        .string(data)
        .map_err(font_error)?
        .to_string();
    if string.len() > MAX_RAW_BYTES {
        return Err(InspectionError::RawDataLimitExceeded);
    }
    Ok(json!(string))
}

fn resolve_variation_axis(
    font: &FontRef<'_>,
    index: usize,
    field: Option<VariationAxisField>,
) -> Result<Value, InspectionError> {
    let fvar = match font.fvar() {
        Ok(fvar) => fvar,
        Err(_) => return Ok(Value::Null),
    };
    let axes = fvar.axes().map_err(font_error)?;
    let Some(axis) = axes.get(index) else {
        return Ok(Value::Null);
    };

    let value = match field {
        None => json!({
            "tag": axis.axis_tag().to_string(),
            "minValue": axis.min_value().to_f32(),
            "defaultValue": axis.default_value().to_f32(),
            "maxValue": axis.max_value().to_f32(),
            "flags": axis.flags(),
        }),
        Some(VariationAxisField::Tag) => json!(axis.axis_tag().to_string()),
        Some(VariationAxisField::MinValue) => json!(axis.min_value().to_f32()),
        Some(VariationAxisField::DefaultValue) => json!(axis.default_value().to_f32()),
        Some(VariationAxisField::MaxValue) => json!(axis.max_value().to_f32()),
        Some(VariationAxisField::Flags) => json!(axis.flags()),
    };
    Ok(value)
}

fn resolve_horizontal_metric(
    font: &FontRef<'_>,
    glyph_id: u16,
    field: HorizontalMetricField,
) -> Result<Value, InspectionError> {
    let max_glyphs = font.maxp().map_err(font_error)?.num_glyphs();
    if glyph_id >= max_glyphs {
        return Ok(Value::Null);
    }
    let metrics = match font.hmtx() {
        Ok(metrics) => metrics,
        Err(_) => return Ok(Value::Null),
    };
    let glyph_id = GlyphId::new(glyph_id as u32);
    let value = match field {
        HorizontalMetricField::AdvanceWidth => metrics.advance(glyph_id).map(|value| json!(value)),
        HorizontalMetricField::SideBearing => metrics
            .side_bearing(glyph_id)
            .map(|value| json!(value)),
    };
    Ok(value.unwrap_or(Value::Null))
}

fn resolve_cmap(font: &FontRef<'_>, codepoint: u32) -> Result<Value, InspectionError> {
    let cmap = match font.cmap() {
        Ok(cmap) => cmap,
        Err(_) => return Ok(Value::Null),
    };
    Ok(cmap
        .map_codepoint(codepoint)
        .map(|glyph_id| json!(glyph_id.to_u32()))
        .unwrap_or(Value::Null))
}

fn resolve_glyph_outline(font: &FontRef<'_>, glyph_id: u16) -> Result<Value, InspectionError> {
    let max_glyphs = font.maxp().map_err(font_error)?.num_glyphs();
    if glyph_id >= max_glyphs {
        return Ok(Value::Null);
    }
    let loca = font.loca(None).map_err(font_error)?;
    let glyf = font.glyf().map_err(font_error)?;
    let glyph = loca
        .get_glyf(GlyphId::new(glyph_id as u32), &glyf)
        .map_err(font_error)?;
    let Some(glyph) = glyph else {
        return Ok(Value::Null);
    };

    match glyph {
        Glyph::Simple(simple) => {
            let points = simple.points().take(MAX_LIST_SIZE + 1).collect::<Vec<_>>();
            if points.len() > MAX_LIST_SIZE {
                return Err(InspectionError::ListLimitExceeded);
            }
            let contours = simple
                .end_pts_of_contours()
                .iter()
                .take(MAX_LIST_SIZE + 1)
                .map(|point| point.get())
                .collect::<Vec<_>>();
            if contours.len() > MAX_LIST_SIZE {
                return Err(InspectionError::ListLimitExceeded);
            }
            Ok(json!({
                "kind": "simple",
                "contours": contours,
                "points": points
                    .into_iter()
                    .map(|point| json!({
                        "x": point.x,
                        "y": point.y,
                        "onCurve": point.on_curve,
                    }))
                    .collect::<Vec<_>>(),
            }))
        }
        Glyph::Composite(composite) => {
            let components = composite
                .component_glyphs_and_flags()
                .take(MAX_LIST_SIZE + 1)
                .map(|(component, flags)| json!({
                    "gid": component.to_u32(),
                    "flags": flags.bits(),
                }))
                .collect::<Vec<_>>();
            if components.len() > MAX_LIST_SIZE {
                return Err(InspectionError::ListLimitExceeded);
            }
            Ok(json!({
                "kind": "composite",
                "components": components,
            }))
        }
    }
}

fn parse_u16_segment(segment: &str, prefix: &str) -> Result<u16, InspectionError> {
    parse_u32_segment(segment, prefix)?
        .try_into()
        .map_err(|_| InspectionError::InvalidValue(segment.to_owned()))
}

fn parse_u32_segment(segment: &str, prefix: &str) -> Result<u32, InspectionError> {
    let value = segment
        .strip_prefix(&format!("{prefix}="))
        .ok_or_else(|| InspectionError::InvalidPath(segment.to_owned()))?;
    parse_integer(value)
}

fn parse_list_index(segment: &str, prefix: &str) -> Result<usize, InspectionError> {
    let index = parse_u32_segment(segment, prefix)? as usize;
    if index >= MAX_LIST_SIZE {
        return Err(InspectionError::ListLimitExceeded);
    }
    Ok(index)
}

fn parse_variation_axis_field(segment: &str) -> Result<VariationAxisField, InspectionError> {
    match segment {
        "tag" => Ok(VariationAxisField::Tag),
        "minValue" => Ok(VariationAxisField::MinValue),
        "defaultValue" => Ok(VariationAxisField::DefaultValue),
        "maxValue" => Ok(VariationAxisField::MaxValue),
        "flags" => Ok(VariationAxisField::Flags),
        _ => Err(InspectionError::InvalidPath(segment.to_owned())),
    }
}

fn parse_codepoint(segment: &str) -> Result<u32, InspectionError> {
    let value = segment
        .strip_prefix("codepoint=U+")
        .ok_or_else(|| InspectionError::InvalidPath(segment.to_owned()))?;
    u32::from_str_radix(value, 16).map_err(|_| InspectionError::InvalidValue(segment.to_owned()))
}

fn parse_integer(value: &str) -> Result<u32, InspectionError> {
    if let Some(hex) = value.strip_prefix("0x") {
        u32::from_str_radix(hex, 16).map_err(|_| InspectionError::InvalidValue(value.to_owned()))
    } else {
        value
            .parse::<u32>()
            .map_err(|_| InspectionError::InvalidValue(value.to_owned()))
    }
}

fn font_error(error: impl fmt::Debug) -> InspectionError {
    InspectionError::Font(format!("{error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TEST_FONT: &[u8] = include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../webapp/compilation-test/output/2-editing.ttf"
    ));

    fn build_two_face_collection() -> Vec<u8> {
        let face_count = 2usize;
        let header_len = 12 + face_count * 4;
        let face_len = TEST_FONT.len();
        let mut collection = Vec::with_capacity(header_len + face_count * face_len);

        collection.extend_from_slice(b"ttcf");
        collection.extend_from_slice(&[0x00, 0x01, 0x00, 0x00]);
        collection.extend_from_slice(&(face_count as u32).to_be_bytes());
        for face_index in 0..face_count {
            let offset = header_len + face_index * face_len;
            collection.extend_from_slice(&(offset as u32).to_be_bytes());
        }
        for _ in 0..face_count {
            collection.extend_from_slice(TEST_FONT);
        }

        let table_count = u16::from_be_bytes([TEST_FONT[4], TEST_FONT[5]]) as usize;
        for face_index in 0..face_count {
            let face_offset = header_len + face_index * face_len;
            for table_index in 0..table_count {
                let record_offset = face_offset + 12 + table_index * 16;
                let source_offset = 12 + table_index * 16 + 8;
                let table_offset = u32::from_be_bytes([
                    TEST_FONT[source_offset],
                    TEST_FONT[source_offset + 1],
                    TEST_FONT[source_offset + 2],
                    TEST_FONT[source_offset + 3],
                ]);
                collection[record_offset + 8..record_offset + 12]
                    .copy_from_slice(&(table_offset + face_offset as u32).to_be_bytes());
            }
        }

        collection
    }

    #[test]
    fn parses_exact_paths() {
        assert_eq!(
            parse_path("/tables/head/unitsPerEm"),
            Ok(FontPath::UnitsPerEm)
        );
        assert_eq!(
            parse_path("/tables/name/records/platformID=3/encodingID=1/languageID=0x0409/nameID=1/string"),
            Ok(FontPath::Name {
                platform_id: 3,
                encoding_id: 1,
                language_id: 0x0409,
                name_id: 1,
            })
        );
        assert_eq!(
            parse_path("/tables/cmap/codepoint=U+0041/gid"),
            Ok(FontPath::CmapGlyph { codepoint: 0x41 })
        );
        assert_eq!(
            parse_path("/tables/glyf/gid=36/outline"),
            Ok(FontPath::GlyphOutline { glyph_id: 36 })
        );
    }

    #[test]
    fn rejects_unknown_and_unbounded_paths() {
        assert!(matches!(
            parse_path("/tables/head/unknown"),
            Err(InspectionError::InvalidPath(_))
        ));
        assert!(matches!(
            parse_path("/tables/fvar/axes/index=256"),
            Err(InspectionError::ListLimitExceeded)
        ));
        assert!(matches!(
            parse_path("/a/b/c/d/e/f/g/h/i"),
            Err(InspectionError::RecursionLimitExceeded)
        ));
    }

    #[test]
    fn rejects_invalid_font_indexes_and_query_counts() {
        assert!(matches!(
            inspect_font_bytes(&[], 0, &[]),
            Err(InspectionError::Font(_))
        ));
        let paths = vec![FontPath::UnitsPerEm; MAX_QUERY_COUNT + 1];
        assert_eq!(
            inspect_font_bytes(&[], 0, &paths),
            Err(InspectionError::QueryLimitExceeded)
        );
    }

    #[test]
    fn resolves_valid_font_values_in_request_order_deterministically() {
        let paths = vec![
            FontPath::NumGlyphs,
            FontPath::UnitsPerEm,
            FontPath::CmapGlyph { codepoint: 0x41 },
            FontPath::Name {
                platform_id: 3,
                encoding_id: 1,
                language_id: 0x0409,
                name_id: 1,
            },
        ];

        let first = inspect_font_bytes(TEST_FONT, 0, &paths).unwrap();
        let second = inspect_font_bytes(TEST_FONT, 0, &paths).unwrap();

        assert_eq!(first, second);
        assert_eq!(
            first.values,
            vec![json!(1058), json!(1000), json!(1), json!("Fustat ExtraLight")]
        );
    }

    #[test]
    fn resolves_each_face_of_a_true_type_collection_and_rejects_invalid_index() {
        let collection = build_two_face_collection();
        let paths = [FontPath::UnitsPerEm];

        assert_eq!(
            inspect_font_bytes(&collection, 0, &paths).unwrap().values,
            vec![json!(1000)]
        );
        assert_eq!(
            inspect_font_bytes(&collection, 1, &paths).unwrap().values,
            vec![json!(1000)]
        );
        assert!(matches!(
            inspect_font_bytes(&collection, 2, &paths),
            Err(InspectionError::Font(_))
        ));
    }

    #[test]
    fn rejects_truncated_fonts_and_oversized_serialized_output() {
        assert!(matches!(
            inspect_font_bytes(&TEST_FONT[..32], 0, &[FontPath::UnitsPerEm]),
            Err(InspectionError::Font(_))
        ));

        let paths = vec![FontPath::GlyphOutline { glyph_id: 404 }; MAX_QUERY_COUNT];
        assert_eq!(
            inspect_font_bytes(TEST_FONT, 0, &paths),
            Err(InspectionError::OutputLimitExceeded)
        );
    }
}