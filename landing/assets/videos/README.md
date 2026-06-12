# Demo Video — Drop Your VibeSpace Recording Here

The landing page currently shows an **animated simulated terminal demo** (pure
CSS/JS — no video file needed).

To swap in a real screen recording:

1. Drop your clip here as `vibespace-demo.mp4` (H.264 MP4, ideally < 40 MB).
2. Open `landing/index.html` and find the `REAL VIDEO SLOT` comment in the
   `#demo` section.
3. Uncomment the `<video>` block and delete the `.terminal` element below it.

The `<video>` uses native controls and never autoplays with sound.
