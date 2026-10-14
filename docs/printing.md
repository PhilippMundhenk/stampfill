# Printing from the server

Visitors can always print from their browser or download the PDF. In addition, the server itself
can send the finished PDF to a printer over IPP, the protocol every network printer and every CUPS
server speaks. The button is called "Print at home" by default; the label is a setting, and each
form can switch the button off.

## Printer URL

Enter the printer's IPP URL in Settings and press "Test printer": it asks the printer what it is
and which document formats it accepts.

| Target | URL |
| --- | --- |
| CUPS queue | `http://cups-host:631/printers/Office` |
| Printer with IPP Everywhere / AirPrint (most Brother, HP, Canon and Epson models), e.g. a Brother MFC-L2700DW | `ipp://192.168.1.50:631/ipp/print` |

Keep the `:631` port in the URL and use the printer's IP address rather than its `.local` name:
mDNS usually does not resolve inside a container, and a DHCP reservation keeps the address
stable. `ipps://` and `https://` work the same way where the printer offers them.

## Printers that do not accept PDF (IPP status 0x040a)

Many home and small-office printers, the Brother MFC-L2700DW among them, only take raster formats
over IPP and answer a PDF job with `0x040a` (document format not supported). CUPS converts the
PDF for them. The repository ships a CUPS sidecar:

```sh
docker compose -f docker-compose.yml -f docker-compose.cups.yml up -d
# register the printer once, driverless ("IPP Everywhere"), by IP address:
docker compose exec cups lpadmin -p Office -E -v ipp://192.168.1.50/ipp/print -m everywhere
```

Then enter `http://cups:631/printers/Office` as the printer URL in Settings and press "Test
printer": a CUPS queue always accepts PDF. Set `CUPSPASSWORD` in `.env` before starting the
overlay. The queue survives restarts in its own volume.

The sidecar is not reachable from the network on purpose, since whoever controls the queue
receives every printed form. Administer it with `docker compose exec cups lpadmin ...`; the
overlay file explains how to reach the CUPS web interface through an SSH tunnel when needed.

Without Docker, any CUPS server on the network works the same way: point stampfill at
`http://cups-host:631/printers/<queue>`, preferably over `ipps://` where available.

## IPP status codes

The error message names the status the printer returned. The common ones:

| Status | Meaning | What to do |
| --- | --- | --- |
| `0x040a` | document format not supported | Print through a CUPS queue (above) |
| `0x0406` | not found | The path in the printer URL is wrong; try `/ipp/print` |
| `0x0506` | not accepting jobs | The printer is paused or out of paper; check its panel |
| `0x0400` | bad request | The printer did not understand the job; "Test printer" shows what it supports |

Only a logged-in admin sees the detailed message; visitors get a generic error.

## Who may print

By default only a logged-in admin sees the server-print button. The setting "Let everyone with a
document link use this printer" opens it to all visitors, which only makes sense on a trusted
network: anyone with a link could then print at will. Anonymous print jobs are limited to five
copies and rate-limited per address.
