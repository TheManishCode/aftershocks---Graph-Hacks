from ledger.accounts import Account
from ledger.interest import FlatRate, InterestPolicy, TieredRate
from ledger.money import Money


def _acct(cents: int) -> Account:
    a = Account("A1", "ada", "savings")
    a.deposit(Money(cents))
    return a


def test_flat_rate():
    a = _acct(10_000)
    assert FlatRate(0.05).apply(a) == Money(500)
    assert a.balance == Money(10_500)


def test_tiered_rate_switches_at_threshold():
    policy: InterestPolicy = TieredRate(0.01, 0.03, 50_000)
    assert policy.apply(_acct(49_999)) == Money(500)
    assert policy.apply(_acct(50_000)) == Money(1500)


def test_base_policy_pays_nothing():
    assert InterestPolicy().apply(_acct(10_000)) == Money(0)
