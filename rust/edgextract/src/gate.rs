//! Accept / Review / Reject. Thresholds live in code, not in the model.

use crate::types::GateBand;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Cutoffs. `fitted=false` means they are starting points, not a measured policy.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GateConfig {
    pub fitted: bool,
    pub accept_prob: f64,
    pub accept_confidence: f64,
    pub reject_prob: f64,
    pub noul_yes: f64,
    pub noul_no: f64,
    pub rotate_below_confidence: f64,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self {
            fitted: false,
            accept_prob: 0.70,
            accept_confidence: 0.50,
            reject_prob: 0.40,
            noul_yes: 0.80,
            noul_no: 0.20,
            rotate_below_confidence: 0.0,
        }
    }
}

impl GateConfig {
    pub fn band_choice(
        &self,
        choice: &str,
        winner_prob: f64,
        confidence: Option<f64>,
        null_labels: &HashSet<String>,
        flipped: bool,
    ) -> GateBand {
        if flipped {
            return GateBand::Review;
        }
        if null_labels.contains(choice) {
            if winner_prob >= self.accept_prob {
                return GateBand::Reject;
            }
            return GateBand::Review;
        }
        let conf = confidence.unwrap_or(1.0);
        if winner_prob >= self.accept_prob && conf >= self.accept_confidence {
            return GateBand::Accept;
        }
        if winner_prob <= self.reject_prob {
            return GateBand::Reject;
        }
        GateBand::Review
    }

    pub fn band_noul(&self, p_yes: f64) -> GateBand {
        if p_yes >= self.noul_yes {
            GateBand::Accept
        } else if p_yes <= self.noul_no {
            GateBand::Reject
        } else {
            GateBand::Review
        }
    }

    /// Off unless you measured option-order bias and set a cutoff.
    pub fn needs_rotation(&self, confidence: Option<f64>) -> bool {
        if self.rotate_below_confidence <= 0.0 {
            return false;
        }
        match confidence {
            Some(c) => c < self.rotate_below_confidence,
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::GateConfig;
    use crate::ontology::NOT_ENTITY;
    use crate::types::GateBand;

    #[test]
    fn accept_reject_review() {
        let g = GateConfig::default();
        let null = [NOT_ENTITY.to_string()].into_iter().collect();
        assert_eq!(
            g.band_choice("PERSON", 0.9, Some(0.8), &null, false),
            GateBand::Accept
        );
        assert_eq!(
            g.band_choice("PERSON", 0.2, Some(0.9), &null, false),
            GateBand::Reject
        );
        assert_eq!(
            g.band_choice("PERSON", 0.55, Some(0.4), &null, false),
            GateBand::Review
        );
        assert_eq!(
            g.band_choice("PERSON", 0.99, Some(0.99), &null, true),
            GateBand::Review
        );
        assert_eq!(
            g.band_choice(NOT_ENTITY, 0.95, Some(0.9), &null, false),
            GateBand::Reject
        );
    }

    #[test]
    fn noul_bands() {
        let g = GateConfig::default();
        assert_eq!(g.band_noul(0.9), GateBand::Accept);
        assert_eq!(g.band_noul(0.1), GateBand::Reject);
        assert_eq!(g.band_noul(0.5), GateBand::Review);
        assert!(!g.fitted);
    }
}
