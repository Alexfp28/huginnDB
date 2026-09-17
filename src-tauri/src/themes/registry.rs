//! Client for an Open VSX registry.
//!
//! [open-vsx.org](https://open-vsx.org) is the Eclipse Foundation's open
//! registry for VS Code extensions, and it is the **only** one this app may
//! talk to by design rather than by preference: Microsoft's marketplace terms
//! forbid access from products that are not VS Code, which is why Cursor,
//! VSCodium and Gitpod all target this one too.
//!
//! Four things about the API shaped this module, all measured rather than
//! assumed:
//!
//! - **The search endpoint's `Themes` category covers icon themes as well as
//!   colour themes**, and the search response says nothing about what an
//!   extension contributes. Only `contributes.themes` in the manifest does.
//! - **The manifest is served on its own** (`files.manifest`, 1–11 KB), so
//!   that filter costs a small fetch per candidate instead of a multi-megabyte
//!   `.vsix` download. Material Icon Theme is discarded for 11 KB rather than
//!   for 6 MB.
//! - **Responses carry no `Cache-Control` and no `ETag`**, so there is nothing
//!   to piggyback on: any caching is ours to own, with our own TTL.
//! - **Every version publishes a `sha256`** next to its `.vsix`, verified to
//!   match byte for byte, so integrity checking is nearly free.
//!
//! The registry also returns intermittent `503`s — two of seven probes during
//! the original survey — so [`fetch_bytes`] retries with backoff and every
//! caller is expected to degrade rather than fail hard.

use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::themes::vsix::{contributed_themes, ThemeContribution};

/// The public registry, used when the user has not pointed at another one.
pub const DEFAULT_REGISTRY_URL: &str = "https://open-vsx.org";

/// Per-request ceiling. Generous: the registry is occasionally slow before it
/// is unavailable, and a slow search beats a spurious failure.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Ceiling on a downloaded `.vsix`. The largest theme extension sampled was
/// under 1 MB; 32 MiB leaves room for one that bundles heavy artwork while
/// still refusing something that is not a theme at all.
const MAX_VSIX_BYTES: u64 = 32 * 1024 * 1024;
/// How many manifests to fetch at once while filtering a page of results.
/// Small on purpose — this is someone else's free infrastructure.
const MANIFEST_CONCURRENCY: usize = 6;
/// Attempts per request, against the registry's intermittent 503s.
const MAX_ATTEMPTS: u32 = 3;

/// One colour-theme extension, as the browser lists it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryTheme {
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub license: Option<String>,
    pub download_count: u64,
    pub average_rating: Option<f64>,
    pub review_count: u64,
    /// The registry's own publisher-verification flag, shown as-is.
    pub verified: bool,
    pub icon_url: Option<String>,
    pub download_url: String,
    /// URL of the published digest, or `None` when the version predates it.
    pub sha256_url: Option<String>,
    /// The variants this extension contributes, read from its manifest. This
    /// is also what proves it is a colour theme at all.
    pub variants: Vec<ThemeContribution>,
}

/// One page of results.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub items: Vec<RegistryTheme>,
    /// The registry's own total for the query, **before** icon themes are
    /// filtered out. It is therefore an upper bound on what the user can
    /// actually install, and the UI must treat it as "about this many" —
    /// there is no way to get an exact count without fetching every manifest
    /// in the result set.
    pub total: u64,
    pub offset: u64,
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("HuginnDB/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(AppError::from)
}

/// Normalise a registry base URL: no trailing slash, scheme required.
pub fn normalize_base(url: &str) -> AppResult<String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(DEFAULT_REGISTRY_URL.to_string());
    }
    let parsed = url::Url::parse(trimmed)
        .map_err(|e| AppError::InvalidInput(format!("registry URL is not a URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::InvalidInput(
            "registry URL must be http or https".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// Refuse a URL that does not live on the configured registry's origin.
///
/// The download URL for an extension comes back inside a search result, which
/// means it is a value the app carries around rather than one it derives. If
/// it were followed unchecked, "install this theme" would be "fetch whatever
/// host this record names" — and a record can be stale, cached, or come from
/// a registry the user has since pointed away from. Scheme, host and port must
/// all match; a redirect *within* the origin is still fine, since `reqwest`
/// follows those and they never leave the host that was approved.
pub fn ensure_same_origin(base_url: &str, target: &str) -> AppResult<()> {
    let base = url::Url::parse(base_url)
        .map_err(|e| AppError::InvalidInput(format!("registry URL is not a URL: {e}")))?;
    let target_url = url::Url::parse(target)
        .map_err(|e| AppError::InvalidInput(format!("download URL is not a URL: {e}")))?;
    let same = base.scheme() == target_url.scheme()
        && base.host_str() == target_url.host_str()
        && base.port_or_known_default() == target_url.port_or_known_default();
    if !same {
        return Err(AppError::InvalidInput(format!(
            "refusing to download from {} — it is not the configured registry ({})",
            target_url.host_str().unwrap_or("an unknown host"),
            base.host_str().unwrap_or("none"),
        )));
    }
    Ok(())
}

/// GET with retry/backoff, capped at `max_bytes`.
///
/// The cap is enforced against `Content-Length` when the server sends one and
/// against the accumulated body when it does not, because a missing or lying
/// header must not be the only thing standing between us and an unbounded
/// read.
async fn fetch_bytes(client: &reqwest::Client, url: &str, max_bytes: u64) -> AppResult<Vec<u8>> {
    let mut last: Option<String> = None;
    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * u64::from(attempt))).await;
        }
        let response = match client.get(url).send().await {
            Ok(r) => r,
            Err(e) => {
                last = Some(e.to_string());
                continue;
            }
        };
        if !response.status().is_success() {
            last = Some(format!("{} returned {}", url, response.status()));
            // 4xx is a permanent answer; only a server-side failure is worth
            // asking again for.
            if response.status().is_client_error() {
                break;
            }
            continue;
        }
        if response.content_length().is_some_and(|n| n > max_bytes) {
            return Err(AppError::InvalidInput(format!(
                "{url} is larger than the {max_bytes} byte limit"
            )));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(AppError::from)?;
            if body.len() as u64 + chunk.len() as u64 > max_bytes {
                return Err(AppError::InvalidInput(format!(
                    "{url} is larger than the {max_bytes} byte limit"
                )));
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(body);
    }
    Err(AppError::Registry(
        last.unwrap_or_else(|| format!("could not reach {url}")),
    ))
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> AppResult<serde_json::Value> {
    let bytes = fetch_bytes(client, url, 4 * 1024 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(AppError::from)
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// Turn one search hit plus its manifest into a listing entry, or `None` when
/// the extension contributes no colour theme (an icon theme, a language pack
/// filed under `Themes`, anything else).
fn to_registry_theme(
    hit: &serde_json::Value,
    manifest: &serde_json::Value,
) -> Option<RegistryTheme> {
    let variants = contributed_themes(manifest);
    if variants.is_empty() {
        return None;
    }
    let files = hit.get("files")?;
    let download_url = files.get("download")?.as_str()?.to_string();
    let name = str_field(hit, "name");
    let display = str_field(hit, "displayName");
    Some(RegistryTheme {
        namespace: str_field(hit, "namespace"),
        display_name: if display.is_empty() {
            name.clone()
        } else {
            display
        },
        name,
        description: str_field(hit, "description"),
        version: str_field(hit, "version"),
        // The search hit does not carry a licence; the manifest does.
        license: manifest
            .get("license")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        download_count: hit
            .get("downloadCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        average_rating: hit.get("averageRating").and_then(|v| v.as_f64()),
        review_count: hit.get("reviewCount").and_then(|v| v.as_u64()).unwrap_or(0),
        verified: hit
            .get("verified")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        icon_url: files
            .get("icon")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        download_url,
        sha256_url: files
            .get("sha256")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        variants,
    })
}

/// Search a registry for colour themes.
///
/// Two round trips per result by necessity: the search response cannot say
/// whether a hit is a colour theme, so each candidate's manifest is fetched
/// (concurrently, bounded) and hits that contribute none are dropped. A
/// manifest that fails to load drops its hit rather than failing the page —
/// one flaky fetch should cost one row, not the search.
pub async fn search(base_url: &str, query: &str, offset: u64, size: u64) -> AppResult<SearchPage> {
    let base = normalize_base(base_url)?;
    let client = client()?;
    let url = format!(
        "{base}/api/-/search?query={}&category=Themes&offset={offset}&size={size}&sortBy={}&sortOrder=desc",
        urlencoding_minimal(query),
        if query.trim().is_empty() { "downloadCount" } else { "relevance" },
    );
    let page = fetch_json(&client, &url).await?;
    let total = page.get("totalSize").and_then(|v| v.as_u64()).unwrap_or(0);
    let hits: Vec<serde_json::Value> = page
        .get("extensions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let items: Vec<RegistryTheme> = stream::iter(hits.into_iter().map(|hit| {
        let client = client.clone();
        let base = base.clone();
        async move {
            let ns = str_field(&hit, "namespace");
            let name = str_field(&hit, "name");
            if ns.is_empty() || name.is_empty() {
                return None;
            }
            let manifest_url = hit
                .get("files")
                .and_then(|f| f.get("manifest"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{base}/api/{ns}/{name}/latest/file/package.json"));
            let manifest = fetch_json(&client, &manifest_url).await.ok()?;
            to_registry_theme(&hit, &manifest)
        }
    }))
    .buffered(MANIFEST_CONCURRENCY)
    .filter_map(|x| async move { x })
    .collect()
    .await;

    Ok(SearchPage {
        items,
        total,
        offset,
    })
}

/// Look one extension up by name, for the update check and for installing a
/// theme the user named directly. `None` when the registry has no such
/// extension or it contributes no colour theme.
pub async fn lookup(
    base_url: &str,
    namespace: &str,
    name: &str,
) -> AppResult<Option<RegistryTheme>> {
    let base = normalize_base(base_url)?;
    let client = client()?;
    let meta = match fetch_json(&client, &format!("{base}/api/{namespace}/{name}")).await {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let manifest_url = meta
        .get("files")
        .and_then(|f| f.get("manifest"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{base}/api/{namespace}/{name}/latest/file/package.json"));
    let Ok(manifest) = fetch_json(&client, &manifest_url).await else {
        return Ok(None);
    };
    Ok(to_registry_theme(&meta, &manifest))
}

/// Download a `.vsix` and verify it against the digest the registry
/// publishes beside it.
///
/// A published digest that does not match is a hard failure: the bytes are
/// not what the registry says they are, and the two explanations (corruption
/// in transit, or something interfering) both end with "do not open this".
/// A version with **no** published digest is downloaded anyway, because the
/// alternative is refusing older extensions the registry itself serves
/// happily — the check strengthens what exists rather than gating on it.
pub async fn download_vsix(theme: &RegistryTheme) -> AppResult<Vec<u8>> {
    let client = client()?;
    let bytes = fetch_bytes(&client, &theme.download_url, MAX_VSIX_BYTES).await?;
    if let Some(url) = &theme.sha256_url {
        if let Ok(raw) = fetch_bytes(&client, url, 4096).await {
            let declared = String::from_utf8_lossy(&raw);
            // The file is `<hex>  <filename>`, like `sha256sum` output.
            if let Some(expected) = declared.split_whitespace().next() {
                let actual = hex_lower(&Sha256::digest(&bytes));
                if !expected.eq_ignore_ascii_case(&actual) {
                    return Err(AppError::InvalidInput(format!(
                        "downloaded package does not match the registry's published checksum \
                         (expected {expected}, got {actual})"
                    )));
                }
            }
        }
    }
    Ok(bytes)
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Percent-encode the handful of characters a search term can contain that
/// would otherwise break the query string. Deliberately not a dependency: the
/// input is one query parameter, and `url`'s own encoder is not exposed in a
/// form that is simpler than this.
fn urlencoding_minimal(input: &str) -> String {
    input
        .chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                vec![c]
            } else {
                let mut buf = [0u8; 4];
                c.encode_utf8(&mut buf)
                    .as_bytes()
                    .iter()
                    .flat_map(|b| format!("%{b:02X}").chars().collect::<Vec<_>>())
                    .collect()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_a_base_url() {
        assert_eq!(
            normalize_base("https://open-vsx.org/").unwrap(),
            "https://open-vsx.org"
        );
        assert_eq!(normalize_base("  ").unwrap(), DEFAULT_REGISTRY_URL);
        assert_eq!(normalize_base("").unwrap(), DEFAULT_REGISTRY_URL);
        assert!(normalize_base("ftp://example.com").is_err());
        assert!(normalize_base("not a url").is_err());
    }

    #[test]
    fn same_origin_accepts_the_registry_and_refuses_anything_else() {
        let base = "https://open-vsx.org";
        assert!(ensure_same_origin(base, "https://open-vsx.org/api/a/b/file/x.vsix").is_ok());
        // Different host, scheme and port are each disqualifying on their own.
        assert!(ensure_same_origin(base, "https://evil.example/x.vsix").is_err());
        assert!(ensure_same_origin(base, "http://open-vsx.org/x.vsix").is_err());
        assert!(ensure_same_origin(base, "https://open-vsx.org:8443/x.vsix").is_err());
        // A lookalike host must not pass on a prefix/suffix match.
        assert!(ensure_same_origin(base, "https://open-vsx.org.evil.example/x.vsix").is_err());
        assert!(ensure_same_origin(base, "https://notopen-vsx.org/x.vsix").is_err());
        assert!(ensure_same_origin(base, "not a url").is_err());
    }

    #[test]
    fn same_origin_honours_a_self_hosted_registry() {
        let base = "https://vsx.internal.example:8443";
        assert!(ensure_same_origin(base, "https://vsx.internal.example:8443/f.vsix").is_ok());
        assert!(ensure_same_origin(base, "https://open-vsx.org/f.vsix").is_err());
    }

    #[test]
    fn encodes_a_query_safely() {
        assert_eq!(urlencoding_minimal("tokyo night"), "tokyo%20night");
        assert_eq!(urlencoding_minimal("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencoding_minimal("one-dark_pro.2~x"), "one-dark_pro.2~x");
        // Non-ASCII is encoded per UTF-8 byte, not per char.
        assert_eq!(urlencoding_minimal("café"), "caf%C3%A9");
    }

    #[test]
    fn hexes_a_digest_lowercase() {
        assert_eq!(hex_lower(&[0x00, 0x0f, 0xff]), "000fff");
    }

    fn hit(files: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "namespace": "someone", "name": "my-theme", "displayName": "My Theme",
            "description": "d", "version": "1.0.0", "downloadCount": 42,
            "reviewCount": 1, "verified": true, "files": files
        })
    }

    #[test]
    fn keeps_a_colour_theme_and_drops_an_icon_theme() {
        let files = serde_json::json!({
            "download": "https://r/x.vsix", "sha256": "https://r/x.sha256", "icon": "https://r/i.png"
        });
        let colour = serde_json::json!({
            "license": "MIT",
            "contributes": { "themes": [{ "label": "L", "uiTheme": "vs-dark", "path": "./t.json" }] }
        });
        let kept = to_registry_theme(&hit(files.clone()), &colour).unwrap();
        assert_eq!(kept.namespace, "someone");
        assert_eq!(kept.license.as_deref(), Some("MIT"));
        assert_eq!(kept.variants.len(), 1);
        assert_eq!(kept.download_count, 42);

        // The whole reason manifests are fetched at all.
        let icon = serde_json::json!({
            "contributes": { "iconThemes": [{ "id": "i", "path": "./i.json" }] }
        });
        assert!(to_registry_theme(&hit(files), &icon).is_none());
    }

    #[test]
    fn drops_a_hit_with_no_download_url() {
        let colour = serde_json::json!({
            "contributes": { "themes": [{ "label": "L", "uiTheme": "vs", "path": "./t.json" }] }
        });
        assert!(to_registry_theme(&hit(serde_json::json!({})), &colour).is_none());
    }

    /// Live checks against the real registry, `#[ignore]`d so `cargo test`
    /// stays offline and deterministic. Run them deliberately when touching
    /// this client:
    ///
    /// ```text
    /// cargo test --lib themes::registry::tests::live -- --ignored --nocapture
    /// ```
    ///
    /// They exist because everything unit-testable here is response *shaping*;
    /// what they cover is the part only the real service can answer — that the
    /// search response still has the fields this module reads, that manifests
    /// are still served on their own, and that the published digest still
    /// matches the bytes.
    mod live {
        use super::super::*;

        #[tokio::test]
        #[ignore = "hits open-vsx.org"]
        async fn search_returns_colour_themes_with_their_variants() {
            let page = search(DEFAULT_REGISTRY_URL, "dracula", 0, 10)
                .await
                .unwrap();
            assert!(
                !page.items.is_empty(),
                "no results for a query that has them"
            );
            for item in &page.items {
                // The filter's whole purpose: nothing without a colour theme
                // may reach the list.
                assert!(!item.variants.is_empty(), "{} has no variants", item.name);
                assert!(item.download_url.starts_with("https://"));
            }
            println!(
                "{} of ~{} hits are colour themes; first: {} ({} variants)",
                page.items.len(),
                page.total,
                page.items[0].display_name,
                page.items[0].variants.len()
            );
        }

        #[tokio::test]
        #[ignore = "hits open-vsx.org"]
        async fn an_icon_theme_never_reaches_the_results() {
            // Material Icon Theme is the most-downloaded thing in the `Themes`
            // category and contributes no colour theme at all.
            let page = search(DEFAULT_REGISTRY_URL, "material icon theme", 0, 10)
                .await
                .unwrap();
            assert!(!page.items.iter().any(|i| i.name == "material-icon-theme"));
        }

        #[tokio::test]
        #[ignore = "hits open-vsx.org"]
        async fn lookup_then_download_verifies_the_published_digest() {
            let found = lookup(DEFAULT_REGISTRY_URL, "dracula-theme", "theme-dracula")
                .await
                .unwrap()
                .expect("dracula should be listed");
            assert_eq!(found.namespace, "dracula-theme");
            assert!(found.sha256_url.is_some(), "no digest published any more");
            // `download_vsix` fails loudly on a mismatch, so reaching the
            // assert at all is the check.
            let bytes = download_vsix(&found).await.unwrap();
            assert!(bytes.len() > 10_000);
            println!("downloaded and verified {} KB", bytes.len() / 1024);
        }

        #[tokio::test]
        #[ignore = "hits open-vsx.org"]
        async fn lookup_of_something_absent_is_none_not_an_error() {
            let found = lookup(DEFAULT_REGISTRY_URL, "nobody", "no-such-extension-xyz")
                .await
                .unwrap();
            assert!(found.is_none());
        }
    }

    #[test]
    fn falls_back_to_the_extension_name_when_no_display_name() {
        let mut h = hit(serde_json::json!({ "download": "https://r/x.vsix" }));
        h["displayName"] = serde_json::Value::String(String::new());
        let colour = serde_json::json!({
            "contributes": { "themes": [{ "label": "L", "uiTheme": "vs", "path": "./t.json" }] }
        });
        assert_eq!(
            to_registry_theme(&h, &colour).unwrap().display_name,
            "my-theme"
        );
    }
}
