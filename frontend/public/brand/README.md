# Brand assets

## `kpmg.svg`

The KPMG wordmark, from Wikimedia Commons
(`File:KPMG blue logo.svg`, https://commons.wikimedia.org/wiki/File:KPMG_blue_logo.svg).

A single path with **no fill attribute**, so it inherits `currentColor` and can be
tinted from CSS. No background rectangle, no embedded raster, no script.

**Replace this with the file from KPMG's own brand portal before this goes in
front of a client.** The mark is a registered trademark and the internal asset is
the authoritative one; this is a stand-in so the layout is real rather than a
grey box. The component reads the file at runtime, so swapping it is a file copy
and nothing else changes.

## `fonts/SpaceGrotesk-variable.woff2`

Space Grotesk, latin subset, variable weight 300–700. SIL Open Font License 1.1.

Self-hosted deliberately. The brief requires the application to run with zero
configuration and no network, so a `fonts.googleapis.com` link would be a
dependency that fails in a conference room. One 22 KB file covers every weight
because Space Grotesk is a variable font — Google serves the same bytes for
weight 500, 600 and 700.
