"""Plain-text statements."""

from __future__ import annotations

from .accounts import Account


def statement(account: Account) -> str:
    lines = [f"{account.id} {account.owner} ({account.kind})"]
    for e in account.entries:
        lines.append(f"  {e.memo:<24} {e.amount.format():>16}")
    lines.append(f"  {'balance':<24} {account.balance.format():>16}")
    return "\n".join(lines)


def split_bill(account: Account, people: int) -> list[str]:
    """What each of `people` owes to cover the balance, to the cent."""
    return [m.format() for m in account.balance.allocate(people)]
