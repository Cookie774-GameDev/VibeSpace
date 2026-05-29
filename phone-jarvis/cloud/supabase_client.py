"""
Supabase server-side client.

Used by the cloud node to:
- Verify auth tokens (via JWKS, see auth.py)
- Look up per-user phone_settings, BYOK keys, allowlist
- Write call_audit rows for cross-device viewing

Uses the SERVICE_ROLE key — bypasses RLS. Treat with care: never expose
this key to clients.
"""

from __future__ import annotations

import logging
from typing import Optional

from supabase import Client, create_client

from .config import get_settings

log = logging.getLogger(__name__)

_client: Optional[Client] = None


def get_supabase() -> Client:
    """Cached Supabase client. Raises if SUPABASE_URL/KEY unset."""
    global _client
    if _client is not None:
        return _client
    s = get_settings()
    if not s.has_supabase:
        raise RuntimeError(
            "Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
        )
    _client = create_client(s.SUPABASE_URL, s.SUPABASE_SERVICE_ROLE_KEY)
    return _client
