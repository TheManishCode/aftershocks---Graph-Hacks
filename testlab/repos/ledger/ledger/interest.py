"""Interest policies. `apply` is shared; subclasses only decide the monthly rate."""

from __future__ import annotations

from .accounts import Account
from .money import Money


class InterestPolicy:
    def rate(self, account: Account) -> float:
        return 0.0

    def apply(self, account: Account) -> Money:
        """Credit one month of interest and return it. Negative balances earn nothing."""
        if account.balance.cents <= 0:
            return Money(0, account.balance.currency)
        earned = account.balance.times(self.rate(account))
        if earned.cents > 0:
            account.deposit(earned, "interest")
        return earned


class FlatRate(InterestPolicy):
    def __init__(self, monthly: float):
        self.monthly = monthly

    def rate(self, account: Account) -> float:
        return self.monthly


class TieredRate(InterestPolicy):
    """A higher rate once the balance reaches `threshold` cents."""

    def __init__(self, low: float, high: float, threshold: int):
        self.low, self.high, self.threshold = low, high, threshold

    def rate(self, account: Account) -> float:
        if account.balance.cents >= self.threshold:
            return self.high
        return self.low
