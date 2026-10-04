//! Shared, bounded execution primitives for Finding and Covering.
pub(crate) mod budget;
pub(crate) mod config;
pub(crate) mod engine;
pub(crate) mod ledger;
pub(crate) mod measurement;
pub(crate) mod policy;
pub(crate) mod projection;
pub(crate) mod prompt;
pub(crate) mod source;
pub(crate) mod transport;

pub(crate) mod acquisition;
mod tests;

pub(crate) mod ingress;

pub(crate) mod gateway;

pub(crate) mod research;
