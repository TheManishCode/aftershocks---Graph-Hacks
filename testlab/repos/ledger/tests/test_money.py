import pytest

from ledger.money import CurrencyMismatch, Money


def test_parse_and_format():
    assert Money.of("1234.5").format() == "1,234.50 USD"
    assert Money.of("-0.07").cents == -7


def test_add_and_sub():
    assert Money.of("1.25").add(Money.of("2.80")) == Money.of("4.05")
    assert Money.of("1.00").sub(Money.of("2.50")).is_negative()


def test_currency_mismatch():
    with pytest.raises(CurrencyMismatch):
        Money(100, "USD").add(Money(100, "EUR"))


def test_allocate_sums_exactly():
    parts = Money(1000).allocate(3)
    assert [p.cents for p in parts] == [334, 333, 333]
    assert sum(p.cents for p in parts) == 1000


def test_times_rounds_to_cents():
    assert Money(1001).times(0.5).cents == 500
