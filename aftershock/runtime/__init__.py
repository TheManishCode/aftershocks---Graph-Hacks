"""Runtime evidence: run the repo's own tests to record which tests execute which symbols, run the tests a change
selects, and measure selection against real breakage (mutation). Python/pytest only for now.

This executes the indexed repository's code. The CLI is for a trusted local user; nothing here is exposed over the
API or MCP.
"""
