"""Monthly maintenance fees."""

from __future__ import annotations

from .accounts import Account
from .money import Money

FEES = {"checking": 500, "savings": 0}
WAIVE_AT = 150_000


def monthly_fee(account: Account) -> Money:
    """Checking pays $5 unless the balance is at least $1,500; savings never pays."""
    fee = FEES.get(account.kind, 0)
    if account.balance.cents >= WAIVE_AT:
        fee = 0
    return Money(fee, account.balance.currency)
