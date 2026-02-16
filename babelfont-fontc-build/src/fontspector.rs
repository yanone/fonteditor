use fontspector_checkapi::{
    Check, CheckResult, Context, Plugin, Registry, StatusCode, Testable, TestableCollection,
    TestableType,
};
use fontspector_profile_fontwerk::Fontwerk;
use fontspector_profile_googlefonts::GoogleFonts;
use fontspector_profile_iso15008::Iso15008;
use fontspector_profile_opentype::OpenType;
use fontspector_profile_universal::Universal;
use serde_json::{json, Value};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const AVAILABLE_PROFILES: [&str; 5] = [
    "opentype",
    "universal",
    "googlefonts",
    "iso15008",
    "fontwerk",
];

fn normalize_profile(profile_name: &str) -> &'static str {
    AVAILABLE_PROFILES
        .iter()
        .find(|&&profile| profile == profile_name)
        .copied()
        .unwrap_or("opentype")
}

fn register_profiles<'a>() -> Result<Registry<'a>, JsValue> {
    let mut registry = Registry::new();
    OpenType
        .register(&mut registry)
        .map_err(|e| JsValue::from_str(&format!("Could not register opentype profile: {e}")))?;
    Universal
        .register(&mut registry)
        .map_err(|e| JsValue::from_str(&format!("Could not register universal profile: {e}")))?;
    GoogleFonts.register(&mut registry).map_err(|e| {
        JsValue::from_str(&format!("Could not register googlefonts profile: {e}"))
    })?;
    Iso15008
        .register(&mut registry)
        .map_err(|e| JsValue::from_str(&format!("Could not register iso15008 profile: {e}")))?;
    Fontwerk
        .register(&mut registry)
        .map_err(|e| JsValue::from_str(&format!("Could not register fontwerk profile: {e}")))?;
    Ok(registry)
}

fn run_profile(
    registry: &Registry<'_>,
    profile_name: &str,
    font_bytes: &[u8],
) -> Result<Vec<CheckResult>, JsValue> {
    let testables = vec![Testable {
        filename: "font.ttf".into(),
        source: None,
        contents: font_bytes.to_vec(),
    }];

    let collection = TestableCollection::from_testables(testables, None);
    let all_testables: Vec<TestableType> = collection.collection_and_files().collect();

    let profile = registry
        .get_profile(profile_name)
        .ok_or_else(|| JsValue::from_str(&format!("Could not find profile {profile_name:?}")))?;

    let context = Context {
        skip_network: true,
        network_timeout: None,
        full_lists: true,
        ..Default::default()
    };

    let checkorder: Vec<(String, &TestableType, &Check, Context)> = profile.check_order(
        &[],
        &[],
        registry,
        context,
        &HashMap::new(),
        &all_testables,
    );

    let results = checkorder
        .iter()
        .map(|(sectionname, testable, check, context)| {
            (
                testable,
                check,
                check.run(testable, context, Some(sectionname)),
            )
        })
        .flat_map(|(_, _, result)| result)
        .collect();

    Ok(results)
}

#[wasm_bindgen]
pub fn run_fontspector(font_bytes: &[u8], profile: &str) -> Result<String, JsValue> {
    let registry = register_profiles()?;
    let profile_name = normalize_profile(profile);
    let results = run_profile(&registry, profile_name, font_bytes)?;

    let mut fails: u32 = 0;
    let mut warns: u32 = 0;
    let mut infos: u32 = 0;
    let mut checks: Vec<Value> = Vec::new();

    for result in &results {
        for sub in &result.subresults {
            let mut level: Option<&str> = None;
            match sub.severity {
                StatusCode::Fail => {
                    fails += 1;
                    level = Some("fail");
                }
                StatusCode::Warn => {
                    warns += 1;
                    level = Some("warn");
                }
                StatusCode::Info => {
                    infos += 1;
                    level = Some("info");
                }
                StatusCode::Error => {
                    fails += 1;
                    level = Some("fail");
                }
                _ => {}
            }

            if let Some(level) = level {
                checks.push(json!({
                    "level": level,
                    "code": sub.code.as_deref().unwrap_or("uncoded"),
                    "message": sub.message.as_deref().unwrap_or(""),
                    "checkId": result.check_id,
                    "severity": sub.severity.to_string()
                }));
            }
        }
    }

    let results_json = serde_json::to_value(&results)
        .map_err(|e| JsValue::from_str(&format!("Failed to serialize fontspector results: {e}")))?;

    let output = json!({
        "summary": {
            "fails": fails,
            "warns": warns,
            "infos": infos
        },
        "checks": checks,
        "results": results_json,
        "profile": profile_name,
        "availableProfiles": AVAILABLE_PROFILES
    });

    Ok(output.to_string())
}
