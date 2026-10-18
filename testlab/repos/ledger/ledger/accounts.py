"""Accounts hold a balance and the entries that produced it."""

from __future__ import annotations

from dataclasses import dataclass, field

from .money import ZERO, Money


class InsufficientFunds(Exception):
    pass


@dataclass
class Entry:
    amount: Money
    memo: str


@dataclass
class Account:
    id: str
    owner: str
    kind: str = "checking"
    balance: Money = ZERO
    entries: list[Entry] = field(default_factory=list)

    def deposit(self, amount: Money, memo: str = "deposit") -> None:
        if amount.is_negative() or amount.cents == 0:
            raise ValueError("deposit must be positive")
        self.balance = self.balance.add(amount)
        self.entries.append(Entry(amount, memo))

    def withdraw(self, amount: Money, memo: str = "withdrawal") -> None:
        if amount.is_negative() or amount.cents == 0:
            raise ValueError("withdrawal must be positive")
        if self.balance.sub(amount).is_negative():
            raise InsufficientFunds(f"{self.id} has {self.balance.format()}")
        self.balance = self.balance.sub(amount)
        self.entries.append(Entry(Money(-amount.cents, amount.currency), memo))
