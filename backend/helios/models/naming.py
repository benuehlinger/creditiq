"""Friendly version names, derived from the configuration hash.

The name is a DISPLAY LABEL; the hash underneath is the identity. Deriving the
name from the hash means an identical specification always produces an identical
name, so an accidental duplicate is visible the moment it appears in the list
rather than after someone compares two coefficient tables.

Renaming never breaks a reference, because nothing references the name.
"""

from __future__ import annotations

ADJECTIVES = [
    "amber", "stoic", "candid", "brisk", "lucid", "quiet", "sturdy", "vivid",
    "patient", "frank", "nimble", "solemn", "keen", "steady", "wry", "plain",
    "sober", "hardy", "tidy", "swift", "clement", "prudent", "astute", "modest",
    "gilded", "rugged", "tranquil", "earnest", "vigilant", "temperate", "canny",
    "measured",
]
NOUNS = [
    "heron", "lattice", "harbour", "beacon", "compass", "quarry", "meridian",
    "anchor", "cypress", "foundry", "keystone", "lantern", "bastion", "trellis",
    "granary", "aqueduct", "obelisk", "chandler", "ledger", "abacus", "sextant",
    "almanac", "cornice", "pergola", "cistern", "dovecote", "windlass", "capstan",
    "rampart", "buttress", "colonnade", "portico",
]


def friendly_name(config_hash: str) -> str:
    """adjective-noun-NN, seeded from the hash. Stable and collision-visible."""
    h = int(config_hash[:12], 16)
    adj = ADJECTIVES[h % len(ADJECTIVES)]
    noun = NOUNS[(h // len(ADJECTIVES)) % len(NOUNS)]
    nn = (h // (len(ADJECTIVES) * len(NOUNS))) % 100
    return f"{adj}-{noun}-{nn:02d}"
