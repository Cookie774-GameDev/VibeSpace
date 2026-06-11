# Demo Videos — Drop Your VibeSpace Recordings Here

The landing page (`../../index.html`) loads three demo videos from THIS folder.
Replace these placeholders with your real VibeSpace screen recordings.

## Expected filenames (exact)

```
jarvis-demo-1.mp4   →  "VibeSpace App Walkthrough"
jarvis-demo-2.mp4   →  "Voice + Chat Demo"
jarvis-demo-3.mp4   →  "Local Models & Plugins Preview"
```

## How to add your videos

1. Drop your `.mp4` files into this folder.
2. Name them exactly as above (or edit the filenames/titles in
   `landing/index.html` — look for the `data-video-list` section and the
   `<!-- EDIT VIDEO -->` comments).
3. Optional poster images: add `jarvis-demo-1.jpg`, `jarvis-demo-2.jpg`,
   `jarvis-demo-3.jpg` here and they will show as thumbnails before play.

## Tips

- Keep each clip web-friendly: H.264 MP4, < ~40 MB for fast loading.
- The player uses native HTML5 `<video controls>`. It never autoplays with sound.
- You can add MORE videos: copy a thumbnail block in `index.html` and bump the
  number (`jarvis-demo-4.mp4`, etc.).

> If a file is missing, the player shows a friendly "video coming soon" fallback
> instead of breaking the page.
