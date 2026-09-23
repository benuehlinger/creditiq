"""Friendly version names, derived from the configuration hash.

The name is a DISPLAY LABEL; the hash underneath is the identity. Deriving the
name from the hash means an identical specification always produces an identical
name, so an accidental duplicate is visible the moment it appears in the list
rather than after someone compares two coefficient tables.

Renaming never breaks a reference, because nothing references the name.
"""

from __future__ import annotations

# One word per half. Adjective-noun pairs made a saved pairing four words
# long ("wry-rampart-98 · vivid-heron-51"), which nobody could hold in their
# head. The PD and LGD halves draw from DISJOINT word families, so a bare
# name also says which half it is: PD names are structures, LGD names are
# vessels and grounds.
PD_NOUNS = [
    "rampart", "bastion", "keystone", "beacon", "lattice", "obelisk",
    "buttress", "colonnade", "portico", "trellis", "pergola", "cornice",
    "meridian", "compass", "sextant", "anchor", "capstan", "windlass",
    "harbour", "foundry", "quarry", "aqueduct", "citadel", "parapet",
    "gable", "spire", "vault", "archway", "pillar", "turret", "gantry",
    "causeway",
]
LGD_NOUNS = [
    "heron", "cypress", "granary", "cistern", "dovecote", "ledger",
    "abacus", "almanac", "chandler", "lantern", "coffer", "sluice",
    "wharf", "ballast", "keel", "rudder", "mooring", "jetty", "quay",
    "estuary", "delta", "fathom", "sounding", "breakwater", "lockgate",
    "millrace", "weir", "culvert", "berth", "hull", "bilge", "anchorage",
]


def friendly_name(config_hash: str, kind: str = "pd") -> str:
    """noun-NN, seeded from the hash. Stable and collision-visible; the word
    family says which half of the model the name belongs to."""
    nouns = LGD_NOUNS if kind == "lgd" else PD_NOUNS
    h = int(config_hash[:12], 16)
    noun = nouns[h % len(nouns)]
    nn = (h // len(nouns)) % 100
    return f"{noun}-{nn:02d}"


def lgd_display(lgd_spec) -> str:
    """The severity half's display name. A fitted model gets the hash-derived
    name like any other; a declared assumption IS its own name — minting a
    codename for "55%, because I said so" would dress an assumption as an
    estimate."""
    if getattr(lgd_spec, "assumed_lgd", None) is not None:
        return f"assumed {lgd_spec.assumed_lgd:.0%}"
    return friendly_name(lgd_spec.hash(), kind="lgd")
