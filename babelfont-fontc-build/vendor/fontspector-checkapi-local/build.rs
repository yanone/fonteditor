use std::{env, fs::File, io::Write, path::PathBuf};

fn out_dir_path(name: &str) -> PathBuf {
    let out_dir = env::var_os("OUT_DIR").expect("OUT_DIR must be set");
    PathBuf::from(out_dir).join(name)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut script_file = File::create(out_dir_path("script_tags.rs"))?;
    writeln!(
        script_file,
        "/// Valid OpenType script names\npub const VALID_SCRIPT_TAGS: [&str; 0] = [];"
    )?;

    let mut language_file = File::create(out_dir_path("language_tags.rs"))?;
    writeln!(
        language_file,
        "/// Valid OpenType language names\npub const VALID_LANG_TAGS: [&str; 0] = [];"
    )?;

    Ok(())
}
