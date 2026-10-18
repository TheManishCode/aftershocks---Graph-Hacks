"""Leftovers from the float-based ledger. Nothing calls these any more."""

from __future__ import annotations


def old_rounding(amount: float) -> float:
    """Banker's rounding to two places, from before balances were integer cents."""
    return round(amount + 0.0, 2)
