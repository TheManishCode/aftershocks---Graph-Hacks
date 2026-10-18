"""Integer-cent money. Floats never touch a balance."""

from __future__ import annotations

from dataclasses import dataclass


class CurrencyMismatch(ValueError):
    pass


@dataclass(frozen=True)
class Money:
    cents: int
    currency: str = "USD"

    @classmethod
    def of(cls, amount: str, currency: str = "USD") -> Money:
        whole, _, frac = amount.partition(".")
        sign = -1 if whole.startswith("-") else 1
        return cls(sign * (abs(int(whole or "0")) * 100 + int((frac + "00")[:2])), currency)

    def _check(self, other: Money) -> None:
        if other.currency != self.currency:
            raise CurrencyMismatch(f"{self.currency} vs {other.currency}")

    def add(self, other: Money) -> Money:
        self._check(other)
        return Money(self.cents + other.cents, self.currency)

    def sub(self, other: Money) -> Money:
        self._check(other)
        return Money(self.cents - other.cents, self.currency)

    def times(self, factor: float) -> Money:
        return Money(round(self.cents * factor), self.currency)

    def allocate(self, parts: int) -> list[Money]:
        """Split into `parts` amounts that differ by at most a cent and sum exactly to self."""
        base, extra = divmod(self.cents, parts)
        return [Money(base + (1 if i < extra else 0), self.currency) for i in range(parts)]

    def is_negative(self) -> bool:
        return self.cents < 0

    def format(self) -> str:
        sign = "-" if self.cents < 0 else ""
        whole, frac = divmod(abs(self.cents), 100)
        return f"{sign}{whole:,}.{frac:02d} {self.currency}"


ZERO = Money(0)
