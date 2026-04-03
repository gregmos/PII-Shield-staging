"""
Shared fixtures for PII Shield tests.

Imports PIIEngine and helpers from the server module.
The server module tries to import `mcp` at module level and create a FastMCP instance.
We mock `mcp` before importing so tests don't require the MCP package or a running server.
"""

import sys
import types
import pytest
from pathlib import Path
from unittest.mock import MagicMock


def _mock_mcp():
    """Install a fake `mcp` package so pii_shield_server.py can be imported without it."""
    if "mcp" in sys.modules:
        return  # already available (real or mocked)

    # Build a minimal mock module tree:  mcp → mcp.server → mcp.server.fastmcp → FastMCP
    mcp_mod = types.ModuleType("mcp")
    mcp_server = types.ModuleType("mcp.server")
    mcp_fastmcp = types.ModuleType("mcp.server.fastmcp")

    # FastMCP mock — needs to be callable (constructor) and return an object with .tool() decorator and .run()
    class _FakeFastMCP:
        def __init__(self, *a, **kw):
            pass

        def tool(self):
            def decorator(fn):
                return fn
            return decorator

        def run(self, **kw):
            pass

    mcp_fastmcp.FastMCP = _FakeFastMCP
    mcp_mod.server = mcp_server
    mcp_server.fastmcp = mcp_fastmcp

    sys.modules["mcp"] = mcp_mod
    sys.modules["mcp.server"] = mcp_server
    sys.modules["mcp.server.fastmcp"] = mcp_fastmcp


# Mock MCP before any server imports
_mock_mcp()

# Add server directory to path
SERVER_DIR = Path(__file__).parent.parent / "server"
sys.path.insert(0, str(SERVER_DIR))


@pytest.fixture(scope="session")
def engine():
    """Return an initialized PIIEngine instance (shared across all tests in session)."""
    from pii_shield_server import PIIEngine, _engine_ready

    # Mark engine as ready (skip background bootstrap wait)
    _engine_ready.set()

    eng = PIIEngine()
    eng._ensure_ready(_from_bootstrap=True)
    return eng


@pytest.fixture
def fresh_placeholders():
    """Return fresh placeholder state dicts for testing deduplication."""
    from collections import defaultdict
    return {
        "type_counters": defaultdict(int),
        "seen_exact": {},
        "seen_family": {},
        "mapping": {},
    }
