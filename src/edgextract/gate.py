"""Accept / Review / Reject. Thresholds live in code, not in the model."""

from __future__ import annotations

from pydantic import BaseModel

from edgextract.types import GateBand


class GateConfig(BaseModel):
    """Cutoffs. fitted=False means they are starting points, not a measured policy."""

    fitted: bool = False
    accept_prob: float = 0.70
    accept_confidence: float = 0.50
    reject_prob: float = 0.40
    noul_yes: float = 0.80
    noul_no: float = 0.20
    rotate_below_confidence: float = 0.0

    def band_choice(
        self,
        choice: str,
        winner_prob: float,
        confidence: float | None,
        *,
        null_labels: frozenset[str],
        flipped: bool = False,
    ) -> GateBand:
        if flipped:
            return GateBand.REVIEW
        if choice in null_labels:
            if winner_prob >= self.accept_prob:
                return GateBand.REJECT
            if winner_prob <= self.reject_prob:
                return GateBand.REVIEW
            return GateBand.REVIEW
        conf = 1.0 if confidence is None else confidence
        if winner_prob >= self.accept_prob and conf >= self.accept_confidence:
            return GateBand.ACCEPT
        if winner_prob <= self.reject_prob:
            return GateBand.REJECT
        return GateBand.REVIEW

    def band_noul(self, p_yes: float) -> GateBand:
        if p_yes >= self.noul_yes:
            return GateBand.ACCEPT
        if p_yes <= self.noul_no:
            return GateBand.REJECT
        return GateBand.REVIEW

    def needs_rotation(self, confidence: float | None) -> bool:
        """Off unless you measured option-order bias and set a cutoff."""
        if self.rotate_below_confidence <= 0 or confidence is None:
            return False
        return confidence < self.rotate_below_confidence
