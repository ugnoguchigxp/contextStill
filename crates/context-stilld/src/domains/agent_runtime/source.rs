use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const SOURCE_LIMIT: usize = 16 * 1024 * 1024;

pub(crate) fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Quote {
    pub snapshot_hash: String,
    pub from_byte: usize,
    pub to_byte: usize,
    pub text: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub hash: String,
    pub uri: String,
    pub kind: String,
    pub text: String,
}

impl Snapshot {
    pub fn new(uri: String, kind: String, text: String) -> Result<Self, String> {
        if text.len() > SOURCE_LIMIT || uri.len() > 8_192 {
            return Err("source_byte_limit".into());
        }
        Ok(Self {
            hash: hash(&text),
            uri: display_uri(&uri),
            kind,
            text,
        })
    }
    pub fn read(&self, from: usize, to: usize) -> Result<&str, String> {
        if from >= to
            || to > self.text.len()
            || !self.text.is_char_boundary(from)
            || !self.text.is_char_boundary(to)
        {
            return Err("invalid_source_range".into());
        }
        Ok(&self.text[from..to])
    }
    pub fn validate(&self, quote: &Quote) -> Result<(), String> {
        if quote.snapshot_hash != self.hash
            || hash(&self.text) != self.hash
            || self.read(quote.from_byte, quote.to_byte)? != quote.text
            || quote.text.trim().is_empty()
            || !matches!(
                quote.role.as_str(),
                "supports" | "counterevidence" | "condition" | "context"
            )
        {
            return Err("invalid_quote".into());
        }
        Ok(())
    }
    /// UTF-8 byte chunks, preserving every byte. These are locators, never model tokens.
    pub fn ranges(&self, chunk_bytes: usize) -> Vec<(usize, usize)> {
        let mut result = Vec::new();
        let mut from = 0;
        while from < self.text.len() {
            let mut to = from.saturating_add(chunk_bytes.max(4)).min(self.text.len());
            while !self.text.is_char_boundary(to) {
                to -= 1;
            }
            result.push((from, to));
            from = to;
        }
        result
    }
}

/// Request URIs may contain signed query parameters. They remain private task input for the
/// guarded fetcher; the model and evidence projections receive only the public location.
pub(crate) fn display_uri(uri: &str) -> String {
    if let Ok(mut url) = reqwest::Url::parse(uri) {
        if matches!(url.scheme(), "http" | "https") {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            return url.to_string();
        }
    }
    uri.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_ranges_preserve_original_bytes_and_reject_invented_quotes() {
        let s = Snapshot::new(
            "vibe://a".into(),
            "primary".into(),
            "根拠🙂\r\n後半の反証".into(),
        )
        .unwrap();
        let ranges = s.ranges(7);
        let reconstructed: String = ranges
            .iter()
            .map(|(a, b)| s.read(*a, *b).unwrap())
            .collect();
        assert_eq!(reconstructed, s.text);
        let mut q = Quote {
            snapshot_hash: s.hash.clone(),
            from_byte: 0,
            to_byte: 6,
            text: "根拠".into(),
            role: "supports".into(),
        };
        s.validate(&q).unwrap();
        q.to_byte = 7;
        assert!(s.validate(&q).is_err());
        q.to_byte = 6;
        q.text = "仮説".into();
        assert!(s.validate(&q).is_err());
    }
}
