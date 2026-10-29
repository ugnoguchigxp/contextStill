//! Compare stated calendar precision as an interval, never an invented exact date.
use chrono::{Datelike, NaiveDate};

pub(crate) fn bounds(value: &str, precision: &str) -> Option<(i64, i64)> {
    if precision == "instant" {
        let t = chrono::DateTime::parse_from_rfc3339(value)
            .ok()?
            .timestamp_millis();
        return Some((t, t));
    }
    let first = match precision {
        "day" if value.len() == 10 => NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?,
        "month" if value.len() == 7 => {
            NaiveDate::parse_from_str(&format!("{value}-01"), "%Y-%m-%d").ok()?
        }
        "year" if value.len() == 4 => {
            NaiveDate::parse_from_str(&format!("{value}-01-01"), "%Y-%m-%d").ok()?
        }
        _ => return None,
    };
    let next = match precision {
        "day" => first.succ_opt()?,
        "month" if first.month() == 12 => NaiveDate::from_ymd_opt(first.year() + 1, 1, 1)?,
        "month" => NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1)?,
        "year" => NaiveDate::from_ymd_opt(first.year() + 1, 1, 1)?,
        _ => return None,
    };
    Some((
        first.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis(),
        next.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() - 1,
    ))
}
pub(crate) fn query_bound(value: &str) -> Option<i64> {
    let precision = match value.len() {
        4 => "year",
        7 => "month",
        10 => "day",
        _ => "instant",
    };
    bounds(value, precision).map(|p| p.0)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn year_precision_overlaps_a_month_and_invalid_dates_are_rejected() {
        let (a, b) = bounds("2024", "year").unwrap();
        let september = query_bound("2024-09").unwrap();
        assert!(a < september && september < b);
        assert!(bounds("2024-02-30", "day").is_none());
        assert!(bounds("2024-13", "month").is_none());
        assert_eq!(
            query_bound("2024-09-01T09:00:00+09:00"),
            query_bound("2024-09-01T00:00:00Z")
        );
    }
}
