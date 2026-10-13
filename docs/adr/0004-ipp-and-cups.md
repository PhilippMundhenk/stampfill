# 0004. Print over IPP directly, convert through CUPS when needed

Date: 2026-10-13 · Status: accepted

## Context

The point of the service is to end with paper. The server should print on an office printer
without a driver, and users should not need anything installed. Most network printers speak IPP;
many home printers accept only raster formats over IPP, not PDF.

## Decision

The server sends `Print-Job` requests itself (a 60-line IPP client, RFC 8011) with
`document-format: application/pdf`. `Get-Printer-Attributes` backs a "Test printer" button that
reports the accepted formats. For printers that refuse PDF (`0x040a`), the Compose overlay
`docker-compose.cups.yml` runs a CUPS server with driverless (IPP Everywhere) queues that convert;
stampfill then prints to `http://cups:631/printers/<queue>`. No rasteriser is built into
stampfill.

## Consequences

- Zero configuration for printers that accept PDF (CUPS queues always do).
- Raster-only printers need the sidecar or an existing CUPS server; the error message says so.
- The printer URL is admin-controlled and the server connects to it. The audit in
  `docs/security.md` treats this as the one place the service makes outbound requests.
- Browser printing stays available regardless: vector PDF on desktop Chromium, page images
  elsewhere.
