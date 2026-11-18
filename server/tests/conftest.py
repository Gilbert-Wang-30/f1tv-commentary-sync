"""Fixtures several test modules share, made available to all of them here (a module importing
one only to name it as an argument redefines it, as far as a linter can tell)."""

from test_ads import synth_refs, synth_refs_dir  # noqa: F401
from test_backfill_synth import synth  # noqa: F401
from test_timing import archived_root  # noqa: F401
