import pytest

from ledger.accounts import Account, InsufficientFunds
from ledger.money import Money


def test_deposit_then_withdraw():
    a = Account("A1", "ada")
    a.deposit(Money.of("10.00"))
    a.withdraw(Money.of("2.50"))
    assert a.balance == Money.of("7.50")
    assert [e.amount.cents for e in a.entries] == [1000, -250]


def test_overdraw_is_refused():
    a = Account("A1", "ada")
    a.deposit(Money.of("1.00"))
    with pytest.raises(InsufficientFunds):
        a.withdraw(Money.of("1.01"))
    assert a.balance == Money.of("1.00")


def test_non_positive_amounts_are_refused():
    a = Account("A1", "ada")
    with pytest.raises(ValueError):
        a.deposit(Money(0))
