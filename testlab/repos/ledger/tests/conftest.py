import pytest

from ledger.bank import Bank
from ledger.interest import FlatRate, TieredRate
from ledger.money import Money


@pytest.fixture
def bank():
    b = Bank({"savings": TieredRate(0.01, 0.02, 1_000_000), "checking": FlatRate(0.0)})
    b.open_account("ada", "checking", Money.of("200.00"))
    b.open_account("bob", "savings", Money.of("12000.00"))
    b.open_account("cy", "savings", Money.of("50.00"))
    return b
