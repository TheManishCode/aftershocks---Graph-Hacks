"""The bank: opens accounts, moves money between them, and runs month end."""

from __future__ import annotations

from .accounts import Account, InsufficientFunds
from .fees import monthly_fee
from .interest import InterestPolicy
from .money import Money


class UnknownAccount(KeyError):
    pass


class Bank:
    def __init__(self, policies: dict[str, InterestPolicy] | None = None):
        self.accounts: dict[str, Account] = {}
        self.policies: dict[str, InterestPolicy] = policies or {}
        self._next = 1

    def open_account(self, owner: str, kind: str = "checking", opening: Money | None = None) -> Account:
        acct = Account(id=f"A{self._next:04d}", owner=owner, kind=kind)
        self._next += 1
        if opening is not None and opening.cents > 0:
            acct.deposit(opening, "opening deposit")
        self.accounts[acct.id] = acct
        return acct

    def get(self, account_id: str) -> Account:
        try:
            return self.accounts[account_id]
        except KeyError:
            raise UnknownAccount(account_id) from None

    def transfer(self, src: str, dst: str, amount: Money) -> None:
        """Move `amount` atomically: if the withdrawal fails, nothing changes."""
        a, b = self.get(src), self.get(dst)
        a.withdraw(amount, f"transfer to {dst}")
        b.deposit(amount, f"transfer from {src}")

    def month_end(self) -> dict[str, Money]:
        """Charge fees, then pay interest by account kind. Returns interest paid per account."""
        paid = {}
        for acct in self.accounts.values():
            fee = monthly_fee(acct)
            if fee.cents:
                try:
                    acct.withdraw(fee, "monthly fee")
                except InsufficientFunds:
                    pass
            policy: InterestPolicy = self.policies.get(acct.kind, InterestPolicy())
            paid[acct.id] = policy.apply(acct)
        return paid

    def total(self) -> Money:
        out = Money(0)
        for acct in self.accounts.values():
            out = out.add(acct.balance)
        return out
