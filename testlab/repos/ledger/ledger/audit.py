"""An audit journal used as a context manager around a batch of operations."""

from __future__ import annotations

from .bank import Bank


class Journal:
    def __init__(self, bank: Bank):
        self.bank = bank
        self.lines: list[str] = []
        self._before = 0

    def __enter__(self) -> Journal:
        self._before = self.bank.total().cents
        return self

    def record(self, what: str) -> None:
        self.lines.append(f"{len(self.lines) + 1}. {what}")

    def __exit__(self, *exc) -> None:
        after = self.bank.total().cents
        self.lines.append(f"net change {after - self._before:+d} cents")
