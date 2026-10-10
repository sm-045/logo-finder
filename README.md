# Logo Finder

Find transparent-background company logos in three variants — **original/brand colour**, **dark** (for light backgrounds) and **light/white** (for dark backgrounds) — and download them as SVG or PNG.

**Live app:** https://sm-045.github.io/logo-finder/

It's a static site (plain HTML/CSS/JS, no build step, no backend, no API keys). Everything runs in your browser and talks directly to public, CORS-enabled sources.

## Using it

### Single company
1. Type a company name (e.g. `Stripe`). Optionally add its website (`stripe.com`) — this tells apart companies with similar names and is used to fetch a site icon as a last resort.
2. If more than one company matches, the most likely one is shown and the others are listed as chips. Click one to switch.
3. **Best set** shows the three variants, each previewed on a checkerboard (transparent), black and white background.
   - Real variants from the source are used when they exist (e.g. a file named *“… (black).svg”*, or a Wikidata logo marked for a colour scheme).
   - Otherwise a recoloured version is created and labelled **Generated**. If a generated version loses detail (e.g. white lettering inside a coloured badge becomes a solid blob), change **Generated style** to *Cut out white areas* or *Cut out black areas*.
4. **All results** lists everything found, ranked, with source, licence and a link to the file page. Use **Use as…** to put any result into the best set.
5. Download **SVG** (vector logos only) or **PNG**. Choose 512 / 1024 / 2048 px for the long edge; the aspect ratio is kept and the background stays transparent.

You can share a search as a link: `…/logo-finder/?q=Tata%20Steel&domain=tatasteel.com`.

### Batch
Open the **Batch** tab and paste one company per line (optionally `Name, domain.com`). Click **Find all**, then **Download all as ZIP**. The ZIP contains:

```
<company>/
  original/<company>-original.svg, <company>-original-1024.png
  dark/…            (files from generated variants end in -generated)
  light/…
  SOURCES.txt       (where each file came from, and its licence)
```

Batch picks the most likely company for each name automatically and marks ambiguous ones with ⚠ — add a domain on those lines to be sure. Companies are processed one at a time to stay within the free APIs' rate limits.

## Where the logos come from

Results are ranked in this order:

| # | Source | What it gives |
|---|--------|---------------|
| 1 | **[Wikidata](https://www.wikidata.org)** — the company's *logo image* (P154) | The official full logo / wordmark, hosted on Wikimedia Commons. The `for color scheme` qualifier (P8798) identifies dark/light versions; logos with an end date are marked *Historical*. |
| 2 | **[Wikimedia Commons](https://commons.wikimedia.org) search** | Extra versions whose filenames say *black, white, dark, light, negative, inverted, mono, wordmark, icon…*, plus files in the logo's Commons category. Third-party icon sets and unrelated files are filtered out. |
| 3 | **Icons** — Wikidata *small logo or icon* (P8972/P2910) and **[Simple Icons](https://simpleicons.org)** | Single-colour brand marks and the official brand colour. |
| 4 | **Site icon** via [icon.horse](https://icon.horse) (falls back to Google's favicon service as preview-only) | The site's apple-touch-icon / favicon. Low quality, used only when nothing else exists. |

Every result shows its source and licence and links to its file page. Identical files are de-duplicated.

## How it works

- **Transparency check.** Each image is drawn to a canvas and its alpha channel inspected: images with no transparent pixels, or with opaque corners and border, are flagged. SVGs whose first painted shape is a full-size `<rect>` are flagged as having a background rectangle. Flagged files are ranked lower and not picked for the best set when a clean one exists.
- **Recolouring.** Generated variants wrap the original in an SVG filter (`feFlood` + `feComposite operator="in"` against the source alpha) to build a solid silhouette. Because it works on rendered pixels rather than editing attributes, it handles `fill`/`stroke`, inline `style`, `<style>` blocks, gradients, `currentColor` and shapes with no fill. The *cut out* styles add an `feColorMatrix` step that makes near-white or near-black areas transparent.
- **Safety.** SVGs are sanitised with [DOMPurify](https://github.com/cure53/DOMPurify) and only ever displayed as `<img>` elements from `blob:` URLs, so embedded scripts can't run. The page also has a strict Content-Security-Policy.
- **Rate limits.** `upload.wikimedia.org` allows a short burst and then roughly one file download every 2–3 seconds per IP, so the app throttles itself, shows the official logo first and fills in variants as they arrive.

## Limitations

- Coverage depends on Wikidata/Commons. Small or private companies often have no logo there; you'll get a Simple Icon or just a site icon.
- Generated variants are a mechanical recolour, not an official asset. Check them against the company's brand guidelines.
- PNG logos (e.g. some Indian companies) can't be turned into true vector SVGs; their generated variants are PNG-only, and large PNG sizes are upscaled.

## Running locally

Any static file server works, for example:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` straight from disk won't work, because ES modules need to be served over HTTP.)

## Deployment

`.github/workflows/pages.yml` publishes the site to GitHub Pages on every push to `main`.

## Trademarks

All logos are trademarks of their respective owners. This tool only finds files that are already publicly available; it doesn't grant any right to use them. Check each file's licence and the owner's brand guidelines before using a logo.
