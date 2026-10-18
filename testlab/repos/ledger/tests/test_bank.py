import pytest

from ledger.accounts import InsufficientFunds
from ledger.bank import UnknownAccount
from ledger.money import Money


def test_open_numbers_accounts(bank):
    assert sorted(bank.accounts) == ["A0001", "A0002", "A0003"]
    assert bank.get("A0001").owner == "ada"


def test_transfer_moves_money(bank):
    bank.transfer("A0002", "A0001", Money.of("100.00"))
    assert bank.get("A0001").balance == Money.of("300.00")
    assert bank.get("A0002").balance == Money.of("11900.00")


def test_failed_transfer_changes_nothing(bank):
    with pytest.raises(InsufficientFunds):
        bank.transfer("A0003", "A0001", Money.of("50.01"))
    assert bank.total() == Money.of("12250.00")


def test_unknown_account(bank):
    with pytest.raises(UnknownAccount):
        bank.get("Z9")


def test_month_end_charges_fees_and_pays_interest(bank):
    paid = bank.month_end()
    assert bank.get("A0001").balance == Money.of("195.00")  # $5 fee, 0% interest
    assert paid["A0002"] == Money.of("240.00")  # 2% on the high tier
    assert paid["A0003"] == Money.of("0.50")  # 1% on the low tier
