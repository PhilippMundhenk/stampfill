# 0003. Stamp text onto the page instead of filling PDF form fields

Date: 2026-10-13 · Status: accepted

## Context

The templates are whatever PDF an office already has: scanned paper forms, exports from a word
processor, downloads from an authority. Almost none of them contain AcroForm fields, and those
that do are often broken or flattened.

## Decision

A field is a position on a page (PDF points, bottom-left origin) plus a type and size. Rendering
draws text, an `X`, or an image at that position with pdf-lib. The editor renders the page with
pdf.js and converts clicks and drags between pixels and points through the same viewport, so what
the admin sees is what prints. Existing form fields in a template are ignored.

## Consequences

- Any PDF works, including scans; a skewed scan can be straightened per page (rotation is applied
  at render time, the upload stays untouched).
- Values are never stored in the PDF as data; the output is a flat document. For an archive that
  must stay machine-readable this would be the wrong tool.
- Text wrapping is pdf-lib's simple word wrap within `maxWidth`; there is no rich layout.
- Images are placed into a width × height box and keep their aspect ratio.
