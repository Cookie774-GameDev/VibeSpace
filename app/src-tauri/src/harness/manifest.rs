use serde::{Deserialize, Serialize};
use std::path::{Component, Path};
use url::Url;

const EMBEDDED_MANIFEST: &str = include_str!("../../resources/opencode-runtime-manifest.json");
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_COMPRESSED_BYTES: u64 = 1_073_741_824;
const MAX_EXPANDED_BYTES: u64 = 2_147_483_648;
const MAX_ARCHIVE_ENTRIES: usize = 4_096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeManifest {
    schema_version: u32,
    releases: Vec<OpenCodeRelease>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenCodeRelease {
    pub platform: String,
    pub architecture: String,
    pub version: String,
    pub asset: String,
    pub url: String,
    pub compressed_bytes: u64,
    pub sha256: String,
    pub executable: String,
    pub maximum_expanded_bytes: u64,
    pub maximum_entries: usize,
}

fn is_safe_basename(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn is_numeric_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_release(release: &OpenCodeRelease) -> Result<(), String> {
    if !is_numeric_version(&release.version) {
        return Err("OpenCode release version is invalid.".to_string());
    }
    if !is_safe_basename(&release.asset) || !release.asset.ends_with(".zip") {
        return Err("OpenCode release asset name is unsafe.".to_string());
    }
    if !is_safe_basename(&release.executable)
        || !release.executable.eq_ignore_ascii_case("opencode.exe")
    {
        return Err("OpenCode release executable name is unsafe.".to_string());
    }
    if release.sha256.len() != 64
        || !release
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("OpenCode release SHA-256 is invalid.".to_string());
    }
    if release.compressed_bytes == 0 || release.compressed_bytes > MAX_COMPRESSED_BYTES {
        return Err("OpenCode release compressed size is invalid.".to_string());
    }
    if release.maximum_expanded_bytes < release.compressed_bytes
        || release.maximum_expanded_bytes > MAX_EXPANDED_BYTES
    {
        return Err("OpenCode release expanded size is invalid.".to_string());
    }
    if release.maximum_entries == 0 || release.maximum_entries > MAX_ARCHIVE_ENTRIES {
        return Err("OpenCode release entry limit is invalid.".to_string());
    }

    let parsed =
        Url::parse(&release.url).map_err(|_| "OpenCode release URL is invalid.".to_string())?;
    let expected_path = format!(
        "/anomalyco/opencode/releases/download/v{}/{}",
        release.version, release.asset
    );
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.path() != expected_path
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("OpenCode release URL is not an approved official source.".to_string());
    }

    Ok(())
}

pub fn parse_release_manifest(
    json: &str,
    platform: &str,
    architecture: &str,
) -> Result<OpenCodeRelease, String> {
    let manifest: RuntimeManifest = serde_json::from_str(json)
        .map_err(|_| "OpenCode runtime manifest is invalid.".to_string())?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err("OpenCode runtime manifest schema is unsupported.".to_string());
    }

    let matching = manifest
        .releases
        .into_iter()
        .filter(|release| release.platform == platform && release.architecture == architecture)
        .collect::<Vec<_>>();
    if matching.len() != 1 {
        return Err("OpenCode runtime manifest has no unique platform release.".to_string());
    }
    let release = matching.into_iter().next().expect("one matching release");
    validate_release(&release)?;
    Ok(release)
}

pub fn embedded_release_for(platform: &str, architecture: &str) -> Result<OpenCodeRelease, String> {
    parse_release_manifest(EMBEDDED_MANIFEST, platform, architecture)
}

#[cfg(test)]
mod tests {
    use super::{embedded_release_for, parse_release_manifest};
    use serde_json::{json, Value};

    fn valid_manifest() -> Value {
        json!({
            "schemaVersion": 1,
            "releases": [{
                "platform": "windows",
                "architecture": "x86_64",
                "version": "1.18.16",
                "asset": "opencode-windows-x64.zip",
                "url": "https://github.com/anomalyco/opencode/releases/download/v1.18.16/opencode-windows-x64.zip",
                "compressedBytes": 60_501_625,
                "sha256": "a60bf4d8019982b81dc0c3b91b6e226442cf2b73aca817599b68779ac053e3ff",
                "executable": "opencode.exe",
                "maximumExpandedBytes": 536_870_912,
                "maximumEntries": 128
            }]
        })
    }

    #[test]
    fn embedded_manifest_selects_the_exact_pinned_windows_x64_release() {
        let release = embedded_release_for("windows", "x86_64").expect("embedded release");

        assert_eq!(release.version, "1.18.16");
        assert_eq!(release.asset, "opencode-windows-x64.zip");
        assert_eq!(release.compressed_bytes, 60_501_625);
        assert_eq!(
            release.sha256,
            "a60bf4d8019982b81dc0c3b91b6e226442cf2b73aca817599b68779ac053e3ff"
        );
        assert_eq!(release.executable, "opencode.exe");
        assert_eq!(release.maximum_expanded_bytes, 536_870_912);
        assert_eq!(release.maximum_entries, 128);
    }

    #[test]
    fn manifest_rejects_unknown_schema_platform_and_architecture() {
        let mut unknown_schema = valid_manifest();
        unknown_schema["schemaVersion"] = json!(2);
        assert!(parse_release_manifest(&unknown_schema.to_string(), "windows", "x86_64").is_err());
        assert!(parse_release_manifest(&valid_manifest().to_string(), "linux", "x86_64").is_err());
        assert!(
            parse_release_manifest(&valid_manifest().to_string(), "windows", "aarch64").is_err()
        );
    }

    #[test]
    fn manifest_rejects_non_official_or_non_https_sources() {
        for url in [
            "http://github.com/anomalyco/opencode/releases/download/v1.18.16/opencode-windows-x64.zip",
            "https://example.com/opencode-windows-x64.zip",
            "file:///C:/opencode-windows-x64.zip",
            "https://github.com/anomalyco/opencode/releases/download/v9.9.9/opencode-windows-x64.zip",
        ] {
            let mut manifest = valid_manifest();
            manifest["releases"][0]["url"] = json!(url);
            assert!(
                parse_release_manifest(&manifest.to_string(), "windows", "x86_64").is_err(),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn manifest_rejects_unsafe_names_hashes_and_limits() {
        let mutations = [
            ("asset", json!("../opencode.zip")),
            ("asset", json!("nested/opencode.zip")),
            ("executable", json!("../opencode.exe")),
            ("executable", json!("opencode.cmd")),
            ("sha256", json!("ABC123")),
            ("compressedBytes", json!(0)),
            ("maximumExpandedBytes", json!(0)),
            ("maximumEntries", json!(0)),
        ];

        for (field, value) in mutations {
            let mut manifest = valid_manifest();
            manifest["releases"][0][field] = value;
            assert!(
                parse_release_manifest(&manifest.to_string(), "windows", "x86_64").is_err(),
                "accepted invalid {field}"
            );
        }
    }

    #[test]
    fn manifest_rejects_unknown_fields_and_duplicate_platform_records() {
        let mut unknown_field = valid_manifest();
        unknown_field["releases"][0]["fallbackUrl"] = json!("https://example.com/fallback.zip");
        assert!(parse_release_manifest(&unknown_field.to_string(), "windows", "x86_64").is_err());

        let mut duplicate = valid_manifest();
        let second = duplicate["releases"][0].clone();
        duplicate["releases"]
            .as_array_mut()
            .expect("release array")
            .push(second);
        assert!(parse_release_manifest(&duplicate.to_string(), "windows", "x86_64").is_err());
    }
}
