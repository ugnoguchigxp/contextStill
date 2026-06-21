use std::collections::HashMap;

pub trait EnvProvider {
    fn var(&self, key: &str) -> Option<String>;
}

pub struct OsEnv;

impl EnvProvider for OsEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|value| !value.is_empty())
    }
}

#[derive(Default)]
pub struct MapEnv {
    values: HashMap<String, String>,
}

impl MapEnv {
    pub fn new(values: HashMap<String, String>) -> Self {
        Self { values }
    }

    #[cfg(test)]
    pub fn from_pairs<I, K, V>(vars: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let values = vars
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        Self { values }
    }
}

impl<K, V> FromIterator<(K, V)> for MapEnv
where
    K: Into<String>,
    V: Into<String>,
{
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        let values = iter
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        Self { values }
    }
}

impl EnvProvider for MapEnv {
    fn var(&self, key: &str) -> Option<String> {
        self.values
            .get(key)
            .cloned()
            .filter(|value| !value.is_empty())
    }
}
