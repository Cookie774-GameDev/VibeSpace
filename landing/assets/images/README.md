# Images — Logo & Hero Assets (optional)

The landing page ships with a built-in **inline SVG logo and hero mockup**, so
it looks complete with NO image files. Add real images here only if you want to
replace the generated visuals.

## Optional drop-ins

```
logo.png            →  square app logo (used in navbar/footer if present)
hero-preview.png    →  real screenshot of the Jarvis One desktop app
og-cover.png        →  1200x630 social share image (Open Graph / Twitter card)
favicon.png         →  browser tab icon
```

## How to use them

- To swap the navbar logo: in `landing/index.html`, find `<!-- EDIT LOGO -->`
  and replace the inline `<svg>` with `<img src="assets/images/logo.png" .../>`.
- To swap the hero mockup with a real screenshot: find `<!-- EDIT HERO IMAGE -->`
  and uncomment the `<img>` line.

Recommended: PNG with transparent background for the logo, and a high-resolution
(at least 1600px wide) screenshot for the hero preview.
