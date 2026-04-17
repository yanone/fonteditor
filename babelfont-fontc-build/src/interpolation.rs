// Glyph interpolation module
//
// This module provides functions for interpolating glyphs at specific locations
// in the design space using babelfont's VariationModel-based multi-axis interpolation.
// Optimized with per-request caching for batch operations.

use babelfont::{Layer, Tag};
use fontdrasil::coords::{DesignCoord, DesignLocation, Location, NormalizedSpace, UserCoord};
use fontdrasil::variations::VariationModel;
use serde_json::Value as JsonValue;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use wasm_bindgen::prelude::*;

/// Interpolate a glyph at a specific location in design space
///
/// # Arguments
/// * `font` - Reference to the font
/// * `glyph_name` - Name of the glyph to interpolate
/// * `location_json` - JSON object with axis tags and values in USER SPACE, e.g., '{"wght": 550.0, "wdth": 100.0}'
///
/// # Returns
/// * `String` - JSON representation of the interpolated Layer
pub fn interpolate_glyph(
    font: &babelfont::Font,
    glyph_name: &str,
    location_json: &str,
    extrapolate: bool,
) -> Result<String, JsValue> {
    // Parse location from JSON (user space coordinates)
    let location_map: HashMap<String, f64> = serde_json::from_str(location_json)
        .map_err(|e| JsValue::from_str(&format!("Location parse error: {}", e)))?;

    // Convert user space to design space using axis mappings
    let design_location: DesignLocation = location_map
        .iter()
        .map(|(tag_str, user_value)| {
            let tag = Tag::from_str(tag_str)
                .map_err(|e| JsValue::from_str(&format!("Invalid tag '{}': {}", tag_str, e)))?;

            // Find the axis and convert user space to design space
            let design_value = if let Some(axis) = font.axes.iter().find(|a| a.tag == tag) {
                match axis.userspace_to_designspace(UserCoord::new(*user_value)) {
                    Ok(design_coord) => design_coord,
                    Err(e) => {
                        web_sys::console::warn_1(&format!("[Rust] Warning: Could not convert user space value {} for axis {}: {:?}. Using value as-is.", user_value, tag_str, e).into());
                        DesignCoord::new(*user_value)
                    }
                }
            } else {
                // No axis found, use value as-is
                DesignCoord::new(*user_value)
            };

            Ok((tag, design_value))
        })
        .collect::<Result<Vec<_>, JsValue>>()?
        .into_iter()
        .collect();

    let interpolated_layer = interpolate_glyph_layer(
        font,
        glyph_name,
        &design_location,
        extrapolate,
    )
        .map_err(|e| JsValue::from_str(&format!("Interpolation failed: {}", e)))?;

    // Serialize to JSON and recursively add component layer data
    let layer_json_with_components =
        serialize_layer_with_components(
            &interpolated_layer,
            font,
            &design_location,
            extrapolate,
        )
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))?;

    // Parse the layer JSON to add location data
    let mut result: serde_json::Value = serde_json::from_str(&layer_json_with_components)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse layer JSON: {}", e)))?;

    let vertical_metrics = interpolate_vertical_metrics(font, &design_location, extrapolate)
        .map_err(|e| JsValue::from_str(&format!("Vertical metrics interpolation error: {}", e)))?;

    // Add the location (user space) to the result
    if let Some(obj) = result.as_object_mut() {
        obj.insert(
            "_interpolationLocation".to_string(),
            serde_json::to_value(&location_map)
                .map_err(|e| JsValue::from_str(&format!("Failed to serialize location: {}", e)))?,
        );
        obj.insert("_verticalMetrics".to_string(), vertical_metrics);
    }

    // Serialize back to string
    let result_json = serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize result: {}", e)))?;

    Ok(result_json)
}

pub fn interpolate_glyph_layer(
    font: &babelfont::Font,
    glyph_name: &str,
    target_location: &DesignLocation,
    extrapolate: bool,
) -> Result<Layer, String> {
    font.interpolate_glyph_with_extrapolation(glyph_name, target_location, extrapolate)
        .map_err(|e| format!("{:?}", e))
}

fn normalize_vertical_metric_value(metric_name: &str, metric_value: f64) -> f64 {
    if metric_name == "WinDescent" && metric_value > 0.0 {
        -metric_value
    } else {
        metric_value
    }
}

fn interpolate_vertical_metrics(
    font: &babelfont::Font,
    target_location: &DesignLocation,
    extrapolate: bool,
) -> Result<JsonValue, String> {
    let axis_order: Vec<babelfont::Tag> = font.axes.iter().map(|axis| axis.tag).collect();
    let target_normalized = font
        .normalize_location(target_location.clone())
        .map_err(|e| format!("Failed to normalize target location: {:?}", e))?;

    let mut master_rows: Vec<(Location<NormalizedSpace>, serde_json::Map<String, JsonValue>)> =
        Vec::new();
    let mut metric_names: HashSet<String> = HashSet::new();

    for master in &font.masters {
        let normalized_location = font
            .normalize_location(master.location.clone())
            .map_err(|e| format!("Failed to normalize master location: {:?}", e))?;

        let metrics_json = serde_json::to_value(&master.metrics)
            .map_err(|e| format!("Failed to serialize master metrics: {}", e))?;

        if let JsonValue::Object(metrics_object) = metrics_json {
            for (metric_name, metric_raw_value) in &metrics_object {
                if metric_raw_value.as_f64().is_some() {
                    metric_names.insert(metric_name.clone());
                }
            }
            master_rows.push((normalized_location, metrics_object));
        }
    }

    let mut interpolated_metrics = serde_json::Map::new();

    for metric_name in metric_names {
        let mut locations_for_metric: HashSet<Location<NormalizedSpace>> = HashSet::new();
        let mut values_by_location: HashMap<Location<NormalizedSpace>, Vec<f64>> = HashMap::new();

        for (location, metrics_object) in &master_rows {
            let Some(metric_value) = metrics_object
                .get(&metric_name)
                .and_then(|value| value.as_f64())
            else {
                continue;
            };

            let normalized_value = normalize_vertical_metric_value(&metric_name, metric_value);
            locations_for_metric.insert(location.clone());
            values_by_location.insert(location.clone(), vec![normalized_value]);
        }

        if values_by_location.is_empty() {
            continue;
        }

        let interpolated_value = if values_by_location.len() == 1 {
            values_by_location
                .values()
                .next()
                .and_then(|vals| vals.first())
                .copied()
                .unwrap_or(0.0)
        } else {
            let model = if extrapolate {
                VariationModel::new_extrapolating(
                    locations_for_metric,
                    axis_order.clone(),
                )
            } else {
                VariationModel::new(locations_for_metric, axis_order.clone())
            };
            let deltas = model
                .deltas(&values_by_location)
                .map_err(|e| format!("Failed computing metric deltas: {:?}", e))?;
            let interpolated = model.interpolate_from_deltas(&target_normalized, &deltas);
            interpolated.first().copied().unwrap_or(0.0)
        };

        if interpolated_value.is_finite() {
            interpolated_metrics.insert(metric_name, JsonValue::from(interpolated_value));
        }
    }

    Ok(JsonValue::Object(interpolated_metrics))
}

/// Serialize a layer with recursively interpolated component data
/// This matches the Python fetchLayerData behavior where each component
/// includes its interpolated layer data in a `layerData` field
pub fn serialize_layer_with_components(
    layer: &Layer,
    font: &babelfont::Font,
    location: &DesignLocation,
    extrapolate: bool,
) -> Result<String, String> {
    // Track visited glyphs to prevent infinite recursion
    let mut visited = HashSet::new();
    serialize_layer_recursive(layer, font, location, extrapolate, &mut visited)
}

/// Serialize a layer with cached interpolation - for batch operations
/// Uses shared caches for interpolated layers and serialized JSON to avoid redundant work
pub fn serialize_layer_with_components_cached(
    layer: &Layer,
    font: &babelfont::Font,
    location: &DesignLocation,
    extrapolate: bool,
    layer_cache: &RefCell<HashMap<String, Layer>>,
    json_cache: &RefCell<HashMap<String, JsonValue>>,
) -> Result<JsonValue, String> {
    // Track visited glyphs to prevent infinite recursion in this call
    let mut visited = HashSet::new();
    serialize_layer_recursive_cached(
        layer,
        font,
        location,
        extrapolate,
        &mut visited,
        layer_cache,
        json_cache,
    )
}

/// Recursive helper with caching
fn serialize_layer_recursive_cached(
    layer: &Layer,
    font: &babelfont::Font,
    location: &DesignLocation,
    extrapolate: bool,
    visited: &mut HashSet<String>,
    layer_cache: &RefCell<HashMap<String, Layer>>,
    json_cache: &RefCell<HashMap<String, JsonValue>>,
) -> Result<JsonValue, String> {
    // First serialize the layer to JSON
    let mut layer_json: JsonValue =
        serde_json::to_value(layer).map_err(|e| format!("Failed to serialize layer: {}", e))?;

    // Get mutable access to shapes array
    if let Some(shapes) = layer_json.get_mut("shapes") {
        if let Some(shapes_array) = shapes.as_array_mut() {
            // Process each shape
            for shape_json in shapes_array.iter_mut() {
                // Check if this is a component (serde(untagged) so no wrapper)
                // Components have "reference" field, paths have "nodes" field
                if let Some(component) = shape_json.as_object_mut() {
                    let reference_opt = component
                        .get("reference")
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string());

                    if let Some(reference) = reference_opt {
                        // Prevent infinite recursion
                        if visited.contains(&reference) {
                            continue;
                        }

                        // Check JSON cache first for this component's layer data
                        {
                            let cache = json_cache.borrow();
                            if let Some(cached_json) = cache.get(&reference) {
                                component.insert("layerData".to_string(), cached_json.clone());
                                continue;
                            }
                        }

                        visited.insert(reference.clone());

                        // Get interpolated layer from cache or interpolate
                        let component_layer = {
                            let cache = layer_cache.borrow();
                            if let Some(cached) = cache.get(&reference) {
                                cached.clone()
                            } else {
                                drop(cache);
                                match interpolate_glyph_layer(
                                    font,
                                    &reference,
                                    location,
                                    extrapolate,
                                ) {
                                    Ok(interpolated) => {
                                        layer_cache
                                            .borrow_mut()
                                            .insert(reference.clone(), interpolated.clone());
                                        interpolated
                                    }
                                    Err(_) => {
                                        visited.remove(&reference);
                                        continue;
                                    }
                                }
                            }
                        };

                        // Recursively serialize - returns full layer JSON
                        match serialize_layer_recursive_cached(
                            &component_layer,
                            font,
                            location,
                            extrapolate,
                            visited,
                            layer_cache,
                            json_cache,
                        ) {
                            Ok(component_layer_json) => {
                                // Cache and insert the full layer JSON as layerData
                                json_cache
                                    .borrow_mut()
                                    .insert(reference.clone(), component_layer_json.clone());
                                component.insert("layerData".to_string(), component_layer_json);
                            }
                            Err(_) => {}
                        }

                        visited.remove(&reference);
                    }
                }
            }
        }
    }

    // Return the full layer JSON object (not just shapes)
    // Note: layerData fields added to components are for runtime rendering only
    // and must be stripped before passing font data to compile_babelfont()
    Ok(layer_json)
}

/// Recursive helper that serializes a layer and adds layerData to components
fn serialize_layer_recursive(
    layer: &Layer,
    font: &babelfont::Font,
    location: &DesignLocation,
    extrapolate: bool,
    visited: &mut HashSet<String>,
) -> Result<String, String> {
    // First serialize the layer to JSON
    let mut layer_json: JsonValue =
        serde_json::to_value(layer).map_err(|e| format!("Failed to serialize layer: {}", e))?;

    // Get mutable access to shapes array
    if let Some(shapes) = layer_json.get_mut("shapes") {
        if let Some(shapes_array) = shapes.as_array_mut() {
            // Process each shape
            for shape_json in shapes_array.iter_mut() {
                // Check if this is a component (serde(untagged) so no wrapper)
                // Components have "reference" field, paths have "nodes" field
                if let Some(component) = shape_json.as_object_mut() {
                    // Extract reference as a String to avoid borrow conflicts
                    let reference_opt = component
                        .get("reference")
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string());

                    if let Some(reference) = reference_opt {
                        // Prevent infinite recursion
                        if visited.contains(&reference) {
                            web_sys::console::warn_1(
                                &format!(
                                    "[Rust] Circular component reference detected: {}",
                                    reference
                                )
                                .into(),
                            );
                            continue;
                        }

                        visited.insert(reference.clone());

                        // Interpolate the component's glyph to get its untransformed layer data
                        // We want the raw interpolated geometry without the parent transform applied
                        match interpolate_glyph_layer(
                            font,
                            &reference,
                            location,
                            extrapolate,
                        ) {
                            Ok(component_layer) => {
                                // Recursively serialize with nested components
                                match serialize_layer_recursive(
                                    &component_layer,
                                    font,
                                    location,
                                    extrapolate,
                                    visited,
                                ) {
                                    Ok(component_layer_json) => {
                                        // Parse the JSON string back to a Value
                                        match serde_json::from_str::<JsonValue>(
                                            &component_layer_json,
                                        ) {
                                            Ok(component_json) => {
                                                // Add layerData field to the component
                                                // The transform stays in the component unchanged for JavaScript to apply
                                                component.insert(
                                                    "layerData".to_string(),
                                                    component_json,
                                                );
                                            }
                                            Err(e) => {
                                                web_sys::console::warn_1(
                                                    &format!(
                                                        "[Rust] Failed to parse component JSON for {}: {}",
                                                        reference, e
                                                    )
                                                    .into(),
                                                );
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        web_sys::console::warn_1(
                                            &format!(
                                                "[Rust] Failed to serialize component {}: {}",
                                                reference, e
                                            )
                                            .into(),
                                        );
                                    }
                                }
                            }
                            Err(e) => {
                                web_sys::console::warn_1(
                                    &format!(
                                        "[Rust] Failed to interpolate component {}: {:?}",
                                        reference, e
                                    )
                                    .into(),
                                );
                            }
                        }

                        visited.remove(&reference);
                    }
                }
            }
        }
    }

    // Serialize the modified JSON back to string
    serde_json::to_string(&layer_json)
        .map_err(|e| format!("Failed to serialize modified layer: {}", e))
}
