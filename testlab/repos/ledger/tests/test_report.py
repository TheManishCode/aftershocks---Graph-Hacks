from ledger.accounts import Account
from ledger.audit import Journal
from ledger.money import Money
from ledger.report import split_bill, statement


def test_statement_lists_entries_and_balance():
    a = Account("A7", "ada")
    a.deposit(Money.of("20.00"), "pay")
    a.withdraw(Money.of("2.25"), "coffee")
    text = statement(a)
    assert "pay" in text and "-2.25 USD" in text
    assert text.splitlines()[-1].endswith("17.75 USD")


def test_split_bill():
    a = Account("A7", "ada")
    a.deposit(Money.of("10.00"))
    assert split_bill(a, 3) == ["3.34 USD", "3.33 USD", "3.33 USD"]


def test_journal_records_net_change(bank):
    with Journal(bank) as j:
        bank.transfer("A0002", "A0001", Money.of("5.00"))
        j.record("rebalance")
    assert j.lines == ["1. rebalance", "net change +0 cents"]
